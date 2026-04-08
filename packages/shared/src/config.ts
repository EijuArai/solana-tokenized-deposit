import { readSolanaDemoState } from "./solana-state.js";

export interface ServiceConfig {
  host: string;
  port: number;
}

export interface DemoConfig {
  bankCore: ServiceConfig;
  coreGateway: ServiceConfig;
  orchestrator: ServiceConfig;
  restApi: ServiceConfig;
  bankCoreBaseUrl: string;
  gatewayBaseUrl: string;
  orchestratorBaseUrl: string;
  internalAuthToken: string;
  rpcUrl: string;
  solanaDemoStatePath: string;
  solanaRuntime: "mock" | "validator";
  seedCustomers: Array<{
    customerId: string;
    name: string;
    depositBalance: number;
    walletAddress: string;
  }>;
}

function readPort(name: string, fallback: number): number {
  const rawValue = process.env[name];
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function serviceConfig(prefix: string, fallbackPort: number): ServiceConfig {
  return {
    host: process.env[`${prefix}_HOST`] ?? "127.0.0.1",
    port: readPort(`${prefix}_PORT`, fallbackPort),
  };
}

export function loadDemoConfig(): DemoConfig {
  const bankCore = serviceConfig("BANK_CORE", 4001);
  const coreGateway = serviceConfig("CORE_GATEWAY", 4002);
  const orchestrator = serviceConfig("ORCHESTRATOR", 4003);
  const restApi = serviceConfig("REST_API", 4004);
  const solanaDemoStatePath = process.env.SOLANA_DEMO_STATE_PATH;
  const solanaRuntime =
    (process.env.SOLANA_RUNTIME as "mock" | "validator" | undefined) ?? "mock";
  const solanaState =
    solanaRuntime === "validator"
      ? readSolanaDemoState(solanaDemoStatePath)
      : undefined;

  return {
    bankCore,
    coreGateway,
    orchestrator,
    restApi,
    bankCoreBaseUrl:
      process.env.BANK_CORE_BASE_URL ??
      `http://${bankCore.host}:${bankCore.port}`,
    gatewayBaseUrl:
      process.env.CORE_GATEWAY_BASE_URL ??
      `http://${coreGateway.host}:${coreGateway.port}`,
    orchestratorBaseUrl:
      process.env.ORCHESTRATOR_BASE_URL ??
      `http://${orchestrator.host}:${orchestrator.port}`,
    internalAuthToken:
      process.env.INTERNAL_AUTH_TOKEN ?? "demo-internal-auth-token",
    rpcUrl:
      process.env.SOLANA_RPC_URL ??
      solanaState?.rpcUrl ??
      "http://127.0.0.1:8899",
    solanaDemoStatePath:
      solanaDemoStatePath ??
      new URL("../../../.demo/solana-state.json", import.meta.url).pathname,
    solanaRuntime,
    seedCustomers: solanaState?.customers.map((customer) => ({
      customerId: customer.customerId,
      name: customer.name,
      depositBalance: customer.depositBalance,
      walletAddress: customer.walletAddress,
    })) ?? [
      {
        customerId: "user-a",
        name: "User A",
        depositBalance: 100000,
        walletAddress: "WALLET_USER_A_1111111111111111111111111",
      },
      {
        customerId: "user-b",
        name: "User B",
        depositBalance: 50000,
        walletAddress: "WALLET_USER_B_2222222222222222222222222",
      },
    ],
  };
}
