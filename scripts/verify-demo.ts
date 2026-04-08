import assert from "node:assert/strict";
import {
  TOKEN_2022_PROGRAM_ID,
  getMint,
  getTransferHook,
} from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { loadDemoConfig, readSolanaDemoState } from "@tokenized-deposit/shared";

const config = loadDemoConfig();
const baseUrl =
  process.env.PUBLIC_API_BASE_URL ??
  `http://${config.restApi.host}:${config.restApi.port}`;
const orchestratorBaseUrl =
  process.env.ORCHESTRATOR_BASE_URL ??
  `http://${config.orchestrator.host}:${config.orchestrator.port}`;

async function requestJson<T>(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const body = (await response.json().catch(() => undefined)) as T;
  return { status: response.status, body };
}

async function internalRequest(
  path: string,
  init?: RequestInit,
): Promise<number> {
  const response = await fetch(`${orchestratorBaseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-internal-auth": config.internalAuthToken,
      ...(init?.headers ?? {}),
    },
  });

  return response.status;
}

interface BalanceResponse {
  customerId: string;
  depositBalance: number;
  reserveBalance: number;
  tokenBalance: number;
}

async function balance(customerId: string): Promise<BalanceResponse> {
  const result = await requestJson<BalanceResponse>(`/balances/${customerId}`);
  assert.equal(result.status, 200);
  return result.body;
}

async function main(): Promise<void> {
  if (config.solanaRuntime === "validator") {
    const state = readSolanaDemoState();
    assert.ok(state, "validator runtime requires a Solana demo state file");

    const connection = new Connection(state.rpcUrl, "confirmed");
    const mint = await getMint(
      connection,
      new PublicKey(state.mintAddress),
      "confirmed",
      TOKEN_2022_PROGRAM_ID,
    );
    const transferHook = getTransferHook(mint);
    assert.ok(transferHook, "mint must be initialized with a transfer hook");
    assert.equal(
      transferHook.programId.toBase58(),
      state.programId,
      "transfer-hook program must match the whitelist program",
    );
    assert.ok(state.extraMetasAddress.length > 0);
  }

  const initialA = await balance("user-a");
  const initialB = await balance("user-b");
  assert.equal(initialA.depositBalance, 100000);
  assert.equal(initialA.tokenBalance, 0);
  assert.equal(initialB.depositBalance, 50000);
  assert.equal(initialB.tokenBalance, 0);

  const tokenize = await requestJson<{ status: string }>("/tokenize", {
    method: "POST",
    body: JSON.stringify({
      customerId: "user-a",
      amount: 10000,
      idempotencyKey: "demo-tokenize-1",
    }),
  });
  assert.equal(tokenize.status, 200);
  assert.equal(tokenize.body.status, "confirmed");

  const afterTokenizeA = await balance("user-a");
  assert.equal(afterTokenizeA.depositBalance, 90000);
  assert.equal(afterTokenizeA.reserveBalance, 10000);
  assert.equal(afterTokenizeA.tokenBalance, 10000);

  const transfer = await requestJson<{ status: string }>("/transfer", {
    method: "POST",
    body: JSON.stringify({
      fromCustomerId: "user-a",
      toCustomerId: "user-b",
      amount: 10000,
      idempotencyKey: "demo-transfer-1",
    }),
  });
  assert.equal(transfer.status, 200);
  assert.equal(transfer.body.status, "confirmed");

  const afterTransferA = await balance("user-a");
  const afterTransferB = await balance("user-b");
  assert.equal(afterTransferA.tokenBalance, 0);
  assert.equal(afterTransferB.tokenBalance, 10000);

  const redeem = await requestJson<{ status: string }>("/redeem", {
    method: "POST",
    body: JSON.stringify({
      customerId: "user-b",
      amount: 10000,
      idempotencyKey: "demo-redeem-1",
    }),
  });
  assert.equal(redeem.status, 200);
  assert.equal(redeem.body.status, "confirmed");

  const finalB = await balance("user-b");
  assert.equal(finalB.depositBalance, 60000);
  assert.equal(finalB.reserveBalance, 0);
  assert.equal(finalB.tokenBalance, 0);

  const insufficient = await requestJson<{ error: { code: string } }>(
    "/tokenize",
    {
      method: "POST",
      body: JSON.stringify({
        customerId: "user-a",
        amount: 999999,
        idempotencyKey: "demo-tokenize-insufficient",
      }),
    },
  );
  assert.equal(insufficient.status, 409);
  assert.equal(insufficient.body.error.code, "INTEGRATION_ERROR");

  assert.equal(
    await internalRequest("/internal/whitelist/user-b", { method: "DELETE" }),
    204,
  );
  const blockedTransfer = await requestJson<{ error: { code: string } }>(
    "/transfer",
    {
      method: "POST",
      body: JSON.stringify({
        fromCustomerId: "user-a",
        toCustomerId: "user-b",
        amount: 1,
        idempotencyKey: "demo-transfer-blocked-1",
      }),
    },
  );
  assert.equal(blockedTransfer.status, 409);
  assert.equal(blockedTransfer.body.error.code, "INTEGRATION_ERROR");
  assert.equal(
    await internalRequest("/internal/whitelist/user-b", { method: "POST" }),
    204,
  );

  const replayFirst = await requestJson<{ operationId: string }>("/tokenize", {
    method: "POST",
    body: JSON.stringify({
      customerId: "user-a",
      amount: 1000,
      idempotencyKey: "demo-tokenize-replay-1",
    }),
  });
  const replaySecond = await requestJson<{ operationId: string }>("/tokenize", {
    method: "POST",
    body: JSON.stringify({
      customerId: "user-a",
      amount: 1000,
      idempotencyKey: "demo-tokenize-replay-1",
    }),
  });
  assert.equal(replayFirst.body.operationId, replaySecond.body.operationId);

  console.log("Demo verification completed successfully.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
