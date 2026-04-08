import http from "node:http";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { loadDemoConfig } from "@tokenized-deposit/shared";
import { createBankCoreApp } from "../apps/bank-core/src/app.js";
import { createCoreGatewayApp } from "../apps/core-gateway/src/app.js";
import { createOrchestratorApp } from "../apps/orchestrator/src/app.js";

const internalAuthToken = loadDemoConfig().internalAuthToken;

async function listen(
  app: Parameters<typeof http.createServer>[0],
): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind test server");
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

describe("orchestrator flows", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map(
          (server) =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
        ),
    );
  });

  it("tokenizes once for a repeated idempotency key", async () => {
    const bankCore = await listen(createBankCoreApp());
    servers.push(bankCore.server);
    const gateway = await listen(createCoreGatewayApp(bankCore.baseUrl));
    servers.push(gateway.server);
    const orchestrator = createOrchestratorApp(gateway.baseUrl);

    const first = await request(orchestrator)
      .post("/internal/tokenize")
      .set("x-internal-auth", internalAuthToken)
      .send({
        customerId: "user-a",
        amount: 10000,
        idempotencyKey: "idem-tokenize-test-1",
      });

    const replay = await request(orchestrator)
      .post("/internal/tokenize")
      .set("x-internal-auth", internalAuthToken)
      .send({
        customerId: "user-a",
        amount: 10000,
        idempotencyKey: "idem-tokenize-test-1",
      });

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body.operationId).toBe(first.body.operationId);

    const balance = await request(orchestrator)
      .get("/internal/balances/user-a")
      .set("x-internal-auth", internalAuthToken);
    expect(balance.body.depositBalance).toBe(90000);
    expect(balance.body.tokenBalance).toBe(10000);
  });

  it("blocks transfer when destination wallet is removed from the whitelist", async () => {
    const bankCore = await listen(createBankCoreApp());
    servers.push(bankCore.server);
    const gateway = await listen(createCoreGatewayApp(bankCore.baseUrl));
    servers.push(gateway.server);
    const orchestrator = createOrchestratorApp(gateway.baseUrl);

    await request(orchestrator)
      .post("/internal/tokenize")
      .set("x-internal-auth", internalAuthToken)
      .send({
        customerId: "user-a",
        amount: 10000,
        idempotencyKey: "idem-tokenize-test-2",
      });
    await request(orchestrator)
      .delete("/internal/whitelist/user-b")
      .set("x-internal-auth", internalAuthToken);

    const transfer = await request(orchestrator)
      .post("/internal/transfer")
      .set("x-internal-auth", internalAuthToken)
      .send({
        fromCustomerId: "user-a",
        toCustomerId: "user-b",
        amount: 10000,
        idempotencyKey: "idem-transfer-test-1",
      });

    expect(transfer.status).toBe(409);
    expect(transfer.body.error.code).toBe("WHITELIST_REQUIRED");
  });
});
