import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  AppError,
  reserveMovementRequestSchema,
  persistedOperationSchema,
  toErrorPayload,
  ERROR_CODES,
  loadDemoConfig,
  type OperationRecord,
} from "@tokenized-deposit/shared";
import { BankCoreRepository } from "./db.js";

export function createBankCoreApp(
  repository = new BankCoreRepository(),
  internalAuthToken = loadDemoConfig().internalAuthToken,
) {
  const app = express();
  app.use(express.json());

  app.get("/health", (_request, response) => {
    response.json({ status: "ok", service: "bank-core" });
  });

  app.use("/internal", (request, _response, next) => {
    if (request.header("x-internal-auth") !== internalAuthToken) {
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

  app.get("/internal/customers/:customerId/balance", (request, response) => {
    response.json(repository.getBalance(request.params.customerId));
  });

  app.get("/internal/customers/:customerId/wallet", (request, response) => {
    response.json(repository.getWallet(request.params.customerId));
  });

  app.post("/internal/reserve/fund", (request, response) => {
    const payload = reserveMovementRequestSchema.parse(request.body);
    response.json(repository.fundReserve(payload));
  });

  app.post("/internal/reserve/release", (request, response) => {
    const payload = reserveMovementRequestSchema.parse(request.body);
    response.json(repository.releaseReserve(payload));
  });

  app.get("/internal/operations/:operationId", (request, response) => {
    const operation = repository.getOperation(request.params.operationId);
    if (!operation) {
      throw new AppError(
        ERROR_CODES.NOT_FOUND,
        `Operation not found: ${request.params.operationId}`,
        404,
      );
    }
    response.json(operation);
  });

  app.get("/internal/reconciliation", (_request, response) => {
    response.json(repository.getReconciliationSnapshot());
  });

  app.get(
    "/internal/saga-operations/idempotency/:idempotencyKey",
    (request, response) => {
      const operation = repository.getSagaOperationByIdempotencyKey(
        request.params.idempotencyKey,
      );
      if (!operation) {
        throw new AppError(
          ERROR_CODES.NOT_FOUND,
          `Saga operation not found for idempotency key: ${request.params.idempotencyKey}`,
          404,
        );
      }

      response.json(operation);
    },
  );

  app.get("/internal/saga-operations/:operationId", (request, response) => {
    const operation = repository.getSagaOperationById(
      request.params.operationId,
    );
    if (!operation) {
      throw new AppError(
        ERROR_CODES.NOT_FOUND,
        `Saga operation not found: ${request.params.operationId}`,
        404,
      );
    }

    response.json(operation);
  });

  app.post("/internal/saga-operations", (request, response) => {
    const payload = persistedOperationSchema.parse(request.body);
    response.status(201).json(repository.createSagaOperation(payload));
  });

  app.put("/internal/saga-operations/:operationId", (request, response) => {
    const record = request.body as OperationRecord;
    response.json(
      repository.updateSagaOperation(request.params.operationId, record),
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
