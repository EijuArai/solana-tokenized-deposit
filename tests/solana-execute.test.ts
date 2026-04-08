import { readFileSync } from "node:fs";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  ERROR_CODES,
  readSolanaDemoState,
  type SolanaDemoState,
} from "@tokenized-deposit/shared";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ValidatorSolanaAdapter } from "../apps/orchestrator/src/solana.js";

const validatorRuntime = process.env.SOLANA_RUNTIME === "validator";
const state = readSolanaDemoState();

if (validatorRuntime && !state) {
  throw new Error(
    "Solana demo state file is missing. Run `npm run solana:bootstrap` before this test.",
  );
}

const describeWhenValidator = validatorRuntime ? describe : describe.skip;

function keypairFromFile(path: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]),
  );
}

describeWhenValidator("solana execute transfer hook", () => {
  let adapter: ValidatorSolanaAdapter;
  let demoState: SolanaDemoState;

  beforeAll(async () => {
    demoState = state as SolanaDemoState;
    adapter = new ValidatorSolanaAdapter(demoState);

    const connection = new Connection(demoState.rpcUrl, "confirmed");
    const authority = keypairFromFile(demoState.authoritySecretKeyPath);
    try {
      const balance = await connection.getBalance(
        authority.publicKey,
        "confirmed",
      );
      if (balance < LAMPORTS_PER_SOL) {
        const signature = await connection.requestAirdrop(
          authority.publicKey,
          2 * LAMPORTS_PER_SOL,
        );
        await connection.confirmTransaction(signature, "confirmed");
      }
      await connection.getLatestBlockhash("confirmed");
    } catch (error) {
      throw new Error(
        `Local validator is not reachable at ${demoState.rpcUrl}. Start the validator and rerun npm run solana:bootstrap before executing this test. ${String(error)}`,
      );
    }
  });

  afterEach(async () => {
    await adapter.addWallet(demoState.customers[0].walletAddress);
    await adapter.addWallet(demoState.customers[1].walletAddress);
  });

  it("allows transfers between whitelisted wallets", async () => {
    const sourceWallet = demoState.customers[0].walletAddress;
    const destinationWallet = demoState.customers[1].walletAddress;

    await adapter.addWallet(sourceWallet);
    await adapter.addWallet(destinationWallet);

    const initialSourceBalance = await adapter.getTokenBalance(sourceWallet);
    const initialDestinationBalance =
      await adapter.getTokenBalance(destinationWallet);

    await adapter.mint(sourceWallet, 2);
    const signature = await adapter.transfer(
      sourceWallet,
      destinationWallet,
      1,
    );

    expect(signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,88}$/);
    expect(await adapter.getTokenBalance(sourceWallet)).toBe(
      initialSourceBalance + 1,
    );
    expect(await adapter.getTokenBalance(destinationWallet)).toBe(
      initialDestinationBalance + 1,
    );
  });

  it("rejects transfers when the destination wallet is not whitelisted", async () => {
    const sourceWallet = demoState.customers[0].walletAddress;
    const destinationWallet = demoState.customers[1].walletAddress;

    await adapter.addWallet(sourceWallet);
    await adapter.addWallet(destinationWallet);

    const initialSourceBalance = await adapter.getTokenBalance(sourceWallet);
    const initialDestinationBalance =
      await adapter.getTokenBalance(destinationWallet);

    await adapter.mint(sourceWallet, 1);
    await adapter.removeWallet(destinationWallet);

    await expect(
      adapter.transfer(sourceWallet, destinationWallet, 1),
    ).rejects.toMatchObject({
      code: ERROR_CODES.WHITELIST_REQUIRED,
      statusCode: 409,
    });

    expect(await adapter.getTokenBalance(sourceWallet)).toBe(
      initialSourceBalance + 1,
    );
    expect(await adapter.getTokenBalance(destinationWallet)).toBe(
      initialDestinationBalance,
    );
  });
});
