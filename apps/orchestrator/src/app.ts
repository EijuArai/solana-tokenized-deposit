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
  type BalanceView,
  type CustodyWallet,
  type OperationRecord,
  type PersistedOperation,
  type ReserveMovementRequest,
} from "@tokenized-deposit/shared";
import { createRuntimeSolanaAdapter, type SolanaAdapter } from "./solana.js";

async function requestJson<T>(
  input: string,
  init?: RequestInit,
  allowNotFound = false,
): Promise<T | undefined> {
  const config = loadDemoConfig();
  const response = await fetch(input, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-internal-auth": config.internalAuthToken,
      ...(init?.headers ?? {}),
    },
  });

  if (allowNotFound && response.status === 404) {
    return undefined;
  }

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

function nowIso(): string {
  return new Date().toISOString();
}

function operationFingerprint(
  type: OperationRecord["type"],
  body: unknown,
): string {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const { correlationId: _ignored, ...normalizedBody } = body as Record<
      string,
      unknown
    >;
    return JSON.stringify({ type, body: normalizedBody });
  }

  return JSON.stringify({ type, body });
}

export function createOrchestratorApp(
  gatewayBaseUrl = loadDemoConfig().gatewayBaseUrl,
  solana: SolanaAdapter = createRuntimeSolanaAdapter(),
) {
  const config = loadDemoConfig();
  const app = express();

  app.use(express.json());

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

  async function loadStoredOperationByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<PersistedOperation | undefined> {
    return requestJson(
      `${gatewayBaseUrl}/internal/saga-operations/idempotency/${idempotencyKey}`,
      undefined,
      true,
    ) as Promise<PersistedOperation | undefined>;
  }

  async function loadStoredOperationById(
    operationId: string,
  ): Promise<PersistedOperation | undefined> {
    return requestJson(
      `${gatewayBaseUrl}/internal/saga-operations/${operationId}`,
      undefined,
      true,
    ) as Promise<PersistedOperation | undefined>;
  }

  async function getExistingOperation(
    idempotencyKey: string,
    type: OperationRecord["type"],
    body: unknown,
  ): Promise<OperationRecord | undefined> {
    const stored = await loadStoredOperationByIdempotencyKey(idempotencyKey);
    if (!stored) {
      return undefined;
    }

    const fingerprint = operationFingerprint(type, body);
    if (stored.fingerprint !== fingerprint) {
      throw new AppError(
        ERROR_CODES.IDEMPOTENCY_CONFLICT,
        "Idempotency key reuse does not match original request",
        409,
      );
    }

    return stored.record;
  }

  async function getWallet(customerId: string): Promise<CustodyWallet> {
    return requestJson(
      `${gatewayBaseUrl}/internal/customers/${customerId}/wallet`,
    ) as Promise<CustodyWallet>;
  }

  async function getBalance(customerId: string): Promise<BalanceView> {
    return requestJson(
      `${gatewayBaseUrl}/internal/customers/${customerId}/balance`,
    ) as Promise<BalanceView>;
  }

  async function reserveFund(payload: ReserveMovementRequest): Promise<void> {
    await requestJson(`${gatewayBaseUrl}/internal/reserve/fund`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async function reserveRelease(
    payload: ReserveMovementRequest,
  ): Promise<void> {
    await requestJson(`${gatewayBaseUrl}/internal/reserve/release`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  function createOperationRecord(
    type: OperationRecord["type"],
    idempotencyKey: string,
    amount: number,
    correlationId: string,
    sourceCustomerId?: string,
    destinationCustomerId?: string,
  ): OperationRecord {
    const timestamp = nowIso();
    return {
      operationId: crypto.randomUUID(),
      idempotencyKey,
      type,
      status: "pending",
      amount,
      sourceCustomerId,
      destinationCustomerId,
      correlationId,
      steps: ["accepted"],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  async function rememberOperation(
    body: unknown,
    record: OperationRecord,
  ): Promise<void> {
    const payload: PersistedOperation = {
      fingerprint: operationFingerprint(record.type, body),
      record,
    };

    await requestJson(`${gatewayBaseUrl}/internal/saga-operations`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async function persistUpdate(
    record: OperationRecord,
  ): Promise<OperationRecord> {
    record.updatedAt = nowIso();
    const persisted = (await requestJson(
      `${gatewayBaseUrl}/internal/saga-operations/${record.operationId}`,
      {
        method: "PUT",
        body: JSON.stringify(record),
      },
    )) as PersistedOperation;

    return persisted.record;
  }

  async function appendStep(
    record: OperationRecord,
    step: string,
  ): Promise<OperationRecord> {
    record.steps.push(step);
    return persistUpdate(record);
  }

  async function markFailed(
    record: OperationRecord,
    status: OperationRecord["status"],
    failureCode: string,
    step: string,
  ): Promise<OperationRecord> {
    record.status = status;
    record.failureCode = failureCode;
    record.steps.push(step);
    return persistUpdate(record);
  }

  app.get("/health", (_request, response) => {
    response.json({ status: "ok", service: "orchestrator" });
  });

  app.post("/internal/tokenize", async (request, response) => {
    const payload = tokenizeRequestSchema.parse(request.body);
    const existing = await getExistingOperation(
      payload.idempotencyKey,
      "tokenize",
      payload,
    );
    if (existing) {
      response.json(existing);
      return;
    }

    const correlationId = payload.correlationId ?? crypto.randomUUID();
    let operation = createOperationRecord(
      "tokenize",
      payload.idempotencyKey,
      payload.amount,
      correlationId,
      payload.customerId,
    );
    await rememberOperation(payload, operation);

    const wallet = await getWallet(payload.customerId);
    operation = await appendStep(operation, "wallet-resolved");

    await reserveFund({
      operationId: operation.operationId,
      idempotencyKey: payload.idempotencyKey,
      customerId: payload.customerId,
      amount: payload.amount,
      correlationId,
    });
    operation = await appendStep(operation, "reserve-funded");

    try {
      operation.txSignature = await solana.mint(
        wallet.walletAddress,
        payload.amount,
      );
      operation.status = "confirmed";
      operation.steps.push("mint-confirmed");
      response.json(await persistUpdate(operation));
    } catch (error) {
      try {
        await reserveRelease({
          operationId: `${operation.operationId}-compensation`,
          idempotencyKey: `${payload.idempotencyKey}-compensation`,
          customerId: payload.customerId,
          destinationCustomerId: payload.customerId,
          amount: payload.amount,
          correlationId,
        });
        response
          .status(409)
          .json(
            await markFailed(
              operation,
              "compensated",
              error instanceof AppError
                ? error.code
                : ERROR_CODES.INTERNAL_ERROR,
              "compensation-completed",
            ),
          );
      } catch {
        response
          .status(500)
          .json(
            await markFailed(
              operation,
              "failed",
              ERROR_CODES.RECONCILIATION_ERROR,
              "compensation-failed",
            ),
          );
      }
    }
  });

  app.post("/internal/transfer", async (request, response) => {
    const payload = transferRequestSchema.parse(request.body);
    const existing = await getExistingOperation(
      payload.idempotencyKey,
      "transfer",
      payload,
    );
    if (existing) {
      response.json(existing);
      return;
    }

    const correlationId = payload.correlationId ?? crypto.randomUUID();
    let operation = createOperationRecord(
      "transfer",
      payload.idempotencyKey,
      payload.amount,
      correlationId,
      payload.fromCustomerId,
      payload.toCustomerId,
    );
    await rememberOperation(payload, operation);

    const [fromWallet, toWallet] = await Promise.all([
      getWallet(payload.fromCustomerId),
      getWallet(payload.toCustomerId),
    ]);
    operation = await appendStep(operation, "wallets-resolved");
    operation.txSignature = await solana.transfer(
      fromWallet.walletAddress,
      toWallet.walletAddress,
      payload.amount,
    );
    operation.status = "confirmed";
    operation.steps.push("transfer-confirmed");
    response.json(await persistUpdate(operation));
  });

  app.post("/internal/redeem", async (request, response) => {
    const payload = redeemRequestSchema.parse(request.body);
    const existing = await getExistingOperation(
      payload.idempotencyKey,
      "redeem",
      payload,
    );
    if (existing) {
      response.json(existing);
      return;
    }

    const correlationId = payload.correlationId ?? crypto.randomUUID();
    const destinationCustomerId =
      payload.destinationCustomerId ?? payload.customerId;
    let operation = createOperationRecord(
      "redeem",
      payload.idempotencyKey,
      payload.amount,
      correlationId,
      payload.customerId,
      destinationCustomerId,
    );
    await rememberOperation(payload, operation);

    const wallet = await getWallet(payload.customerId);
    operation = await appendStep(operation, "wallet-resolved");
    operation.txSignature = await solana.burn(
      wallet.walletAddress,
      payload.amount,
    );
    operation = await appendStep(operation, "burn-confirmed");

    try {
      await reserveRelease({
        operationId: operation.operationId,
        idempotencyKey: payload.idempotencyKey,
        customerId: payload.customerId,
        destinationCustomerId,
        amount: payload.amount,
        correlationId,
      });
      operation.status = "confirmed";
      operation.steps.push("reserve-released");
      response.json(await persistUpdate(operation));
    } catch (error) {
      response
        .status(500)
        .json(
          await markFailed(
            operation,
            "failed",
            error instanceof AppError
              ? error.code
              : ERROR_CODES.RECONCILIATION_ERROR,
            "reserve-release-failed",
          ),
        );
    }
  });

  app.get("/internal/operations/:operationId", async (request, response) => {
    const operation = await loadStoredOperationById(request.params.operationId);
    if (!operation) {
      throw new AppError(
        ERROR_CODES.NOT_FOUND,
        `Operation not found: ${request.params.operationId}`,
        404,
      );
    }
    response.json(operation.record);
  });

  app.get("/internal/balances/:customerId", async (request, response) => {
    const balance = await getBalance(request.params.customerId);
    response.json({
      ...balance,
      tokenBalance: await solana.getTokenBalance(balance.walletAddress),
    });
  });

  app.get("/internal/whitelist", async (_request, response) => {
    response.json({ wallets: await solana.listWhitelistedWallets() });
  });

  app.post("/internal/whitelist/:customerId", async (request, response) => {
    const wallet = await getWallet(request.params.customerId);
    await solana.addWallet(wallet.walletAddress);
    response.status(204).send();
  });

  app.delete("/internal/whitelist/:customerId", async (request, response) => {
    const wallet = await getWallet(request.params.customerId);
    await solana.removeWallet(wallet.walletAddress);
    response.status(204).send();
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
