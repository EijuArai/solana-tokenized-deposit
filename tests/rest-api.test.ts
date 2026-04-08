import http from "node:http";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createBankCoreApp } from "../apps/bank-core/src/app.js";
import { createCoreGatewayApp } from "../apps/core-gateway/src/app.js";
import { createOrchestratorApp } from "../apps/orchestrator/src/app.js";
import { createRestApiApp } from "../apps/rest-api/src/app.js";

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

describe("rest api", () => {
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

  async function stack() {
    const bankCore = await listen(createBankCoreApp());
    servers.push(bankCore.server);
    const gateway = await listen(createCoreGatewayApp(bankCore.baseUrl));
    servers.push(gateway.server);
    const orchestrator = await listen(createOrchestratorApp(gateway.baseUrl));
    servers.push(orchestrator.server);
    return createRestApiApp(orchestrator.baseUrl);
  }

  it("rejects malformed tokenize requests before orchestration", async () => {
    const app = await stack();

    const response = await request(app).post("/tokenize").send({
      customerId: "User A",
      amount: 0,
      idempotencyKey: "short",
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("runs the public happy path and preserves correlation ids", async () => {
    const app = await stack();

    const tokenize = await request(app)
      .post("/tokenize")
      .set("x-correlation-id", "corr-public-tokenize-0001")
      .send({
        customerId: "user-a",
        amount: 10000,
        idempotencyKey: "idem-public-tokenize-1",
      });

    expect(tokenize.status).toBe(200);
    expect(tokenize.body.status).toBe("confirmed");
    expect(tokenize.body.correlationId).toBe("corr-public-tokenize-0001");

    const transfer = await request(app).post("/transfer").send({
      fromCustomerId: "user-a",
      toCustomerId: "user-b",
      amount: 10000,
      idempotencyKey: "idem-public-transfer-1",
    });
    expect(transfer.status).toBe(200);

    const redeem = await request(app).post("/redeem").send({
      customerId: "user-b",
      amount: 10000,
      idempotencyKey: "idem-public-redeem-1",
    });
    expect(redeem.status).toBe(200);

    const balanceA = await request(app).get("/balances/user-a");
    const balanceB = await request(app).get("/balances/user-b");
    expect(balanceA.body.depositBalance).toBe(90000);
    expect(balanceA.body.tokenBalance).toBe(0);
    expect(balanceB.body.depositBalance).toBe(60000);
    expect(balanceB.body.tokenBalance).toBe(0);

    const operation = await request(app).get(
      `/operations/${tokenize.body.operationId}`,
    );
    expect(operation.status).toBe(200);
    expect(operation.body.correlationId).toBe("corr-public-tokenize-0001");

    const whitelist = await request(app).get("/whitelist");
    expect(whitelist.status).toBe(200);
    expect(whitelist.body.wallets).toHaveLength(2);
  });
});
