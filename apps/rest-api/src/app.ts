import crypto from "node:crypto";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  AppError,
  ERROR_CODES,
  loadDemoConfig,
  tokenizeRequestSchema,
  transferRequestSchema,
  redeemRequestSchema,
  toErrorPayload,
} from "@tokenized-deposit/shared";

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const config = loadDemoConfig();
  const response = await fetch(input, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-internal-auth": config.internalAuthToken,
      ...(init?.headers ?? {}),
    },
  });

  const json = (await response.json().catch(() => undefined)) as
    | T
    | { error?: { message?: string } }
    | undefined;
  if (!response.ok) {
    const message =
      typeof json === "object" && json && "error" in json
        ? json.error?.message
        : undefined;
    throw new AppError(
      ERROR_CODES.INTEGRATION_ERROR,
      message ?? `Upstream request failed: ${response.status}`,
      response.status,
      response.status >= 500,
      json,
    );
  }

  return json as T;
}

export function createRestApiApp(
  orchestratorBaseUrl = loadDemoConfig().orchestratorBaseUrl,
) {
  const app = express();
  app.use(express.json());

  function correlationId(request: Request): string {
    return request.header("x-correlation-id") ?? crypto.randomUUID();
  }

  app.get("/health", (_request, response) => {
    response.json({ status: "ok", service: "rest-api" });
  });

  app.get("/balances/:customerId", async (request, response) => {
    response.json(
      await requestJson(
        `${orchestratorBaseUrl}/internal/balances/${request.params.customerId}`,
      ),
    );
  });

  app.get("/operations/:operationId", async (request, response) => {
    response.json(
      await requestJson(
        `${orchestratorBaseUrl}/internal/operations/${request.params.operationId}`,
      ),
    );
  });

  app.get("/whitelist", async (_request, response) => {
    response.json(
      await requestJson(`${orchestratorBaseUrl}/internal/whitelist`),
    );
  });

  app.post("/tokenize", async (request, response) => {
    const payload = tokenizeRequestSchema.parse({
      ...request.body,
      correlationId: request.body.correlationId ?? correlationId(request),
    });
    response.json(
      await requestJson(`${orchestratorBaseUrl}/internal/tokenize`, {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    );
  });

  app.post("/transfer", async (request, response) => {
    const payload = transferRequestSchema.parse({
      ...request.body,
      correlationId: request.body.correlationId ?? correlationId(request),
    });
    response.json(
      await requestJson(`${orchestratorBaseUrl}/internal/transfer`, {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    );
  });

  app.post("/redeem", async (request, response) => {
    const payload = redeemRequestSchema.parse({
      ...request.body,
      correlationId: request.body.correlationId ?? correlationId(request),
    });
    response.json(
      await requestJson(`${orchestratorBaseUrl}/internal/redeem`, {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    );
  });

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
