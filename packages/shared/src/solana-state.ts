import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface SolanaDemoCustomerState {
  customerId: string;
  name: string;
  depositBalance: number;
  walletAddress: string;
  tokenAccountAddress: string;
  secretKey: number[];
}

export interface SolanaDemoState {
  rpcUrl: string;
  programId: string;
  registryAddress: string;
  mintAddress: string;
  extraMetasAddress: string;
  authoritySecretKeyPath: string;
  customers: SolanaDemoCustomerState[];
}

export function defaultSolanaDemoStatePath(): string {
  return fileURLToPath(
    new URL("../../../.demo/solana-state.json", import.meta.url),
  );
}

export function defaultAuthorityKeypairPath(): string {
  return resolve(
    dirname(defaultSolanaDemoStatePath()),
    "authority-keypair.json",
  );
}

export function readSolanaDemoState(
  statePath = process.env.SOLANA_DEMO_STATE_PATH ??
    defaultSolanaDemoStatePath(),
): SolanaDemoState | undefined {
  if (!existsSync(statePath)) {
    return undefined;
  }

  const rawValue = readFileSync(statePath, "utf8");
  return JSON.parse(rawValue) as SolanaDemoState;
}
