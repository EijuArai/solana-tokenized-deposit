import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  AppError,
  ERROR_CODES,
  persistedOperationSchema,
  reserveMovementRequestSchema,
  toErrorPayload,
  loadDemoConfig,
  type OperationRecord,
} from "@tokenized-deposit/shared";

async function requestJson<T>(
  input: string,
  init?: RequestInit,
  allowNotFound = false,
): Promise<T | undefined> {
  const response = await fetch(input, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-internal-auth": loadDemoConfig().internalAuthToken,
      ...(init?.headers ?? {}),
    },
  });

  if (allowNotFound && response.status === 404) {
    return undefined;
  }

  if (!response.ok) {
    const errorPayload = (await response.json().catch(() => undefined)) as
      | { error?: { message?: string } }
      | undefined;
    throw new AppError(
      ERROR_CODES.INTEGRATION_ERROR,
      errorPayload?.error?.message ??
        `Upstream request failed: ${response.status}`,
      response.status,
      response.status >= 500,
    );
  }

  return (await response.json()) as T;
}

export function createCoreGatewayApp(
  bankCoreBaseUrl = loadDemoConfig().bankCoreBaseUrl,
) {
  const config = loadDemoConfig();
  const app = express();
  app.use(express.json());

  app.get("/health", (_request, response) => {
    response.json({ status: "ok", service: "core-gateway" });
  });

  app.use("/internal", (request, _response, next) => {
    if (request.header("x-internal-auth") !== config.internalAuthToken) {
      next(
        new AppError(
          ERROR_CODES.UNAUTHORIZED,
          "Missing or invalid internal authentication token",
          401,
        ),
      );
      return;
    }

    next();
  });

  app.get(
    "/internal/customers/:customerId/balance",
    async (request, response) => {
      response.json(
        await requestJson(
          `${bankCoreBaseUrl}/internal/customers/${request.params.customerId}/balance`,
        ),
      );
    },
  );

  app.get(
    "/internal/customers/:customerId/wallet",
    async (request, response) => {
      response.json(
        await requestJson(
          `${bankCoreBaseUrl}/internal/customers/${request.params.customerId}/wallet`,
        ),
      );
    },
  );

  app.post("/internal/reserve/fund", async (request, response) => {
    const payload = reserveMovementRequestSchema.parse(request.body);
    response.json(
      await requestJson(`${bankCoreBaseUrl}/internal/reserve/fund`, {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    );
  });

  app.post("/internal/reserve/release", async (request, response) => {
    const payload = reserveMovementRequestSchema.parse(request.body);
    response.json(
      await requestJson(`${bankCoreBaseUrl}/internal/reserve/release`, {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    );
  });

  app.get("/internal/operations/:operationId", async (request, response) => {
    response.json(
      await requestJson(
        `${bankCoreBaseUrl}/internal/operations/${request.params.operationId}`,
      ),
    );
  });

  app.get("/internal/reconciliation", async (_request, response) => {
    response.json(
      await requestJson(`${bankCoreBaseUrl}/internal/reconciliation`),
    );
  });

  app.get(
    "/internal/saga-operations/idempotency/:idempotencyKey",
    async (request, response) => {
      const operation = await requestJson(
        `${bankCoreBaseUrl}/internal/saga-operations/idempotency/${request.params.idempotencyKey}`,
        undefined,
        true,
      );
      if (!operation) {
        response.status(404).send();
        return;
      }

      response.json(operation);
    },
  );

  app.get(
    "/internal/saga-operations/:operationId",
    async (request, response) => {
      const operation = await requestJson(
        `${bankCoreBaseUrl}/internal/saga-operations/${request.params.operationId}`,
        undefined,
        true,
      );
      if (!operation) {
        response.status(404).send();
        return;
      }

      response.json(operation);
    },
  );

  app.post("/internal/saga-operations", async (request, response) => {
    const payload = persistedOperationSchema.parse(request.body);
    response.status(201).json(
      await requestJson(`${bankCoreBaseUrl}/internal/saga-operations`, {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    );
  });

  app.put(
    "/internal/saga-operations/:operationId",
    async (request, response) => {
      const payload = request.body as OperationRecord;
      response.json(
        await requestJson(
          `${bankCoreBaseUrl}/internal/saga-operations/${request.params.operationId}`,
          {
            method: "PUT",
            body: JSON.stringify(payload),
          },
        ),
      );
    },
  );

  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      _next: NextFunction,
    ) => {
      if (error instanceof AppError) {
        response.status(error.statusCode).json(toErrorPayload(error));
        return;
      }

      if (error instanceof Error && "issues" in error) {
        response
          .status(400)
          .json(
            toErrorPayload(
              new AppError(
                ERROR_CODES.VALIDATION_ERROR,
                "Request validation failed",
                400,
                false,
                error,
              ),
            ),
          );
        return;
      }

      response.status(500).json(toErrorPayload(error));
    },
  );

  return app;
}
