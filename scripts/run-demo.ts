import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadDemoConfig } from "@tokenized-deposit/shared";

const config = loadDemoConfig();
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const anchorCommand = process.platform === "win32" ? "anchor.exe" : "anchor";
const solanaTestValidatorCommand =
  process.platform === "win32"
    ? "solana-test-validator.exe"
    : "solana-test-validator";
const tsxCommand = resolve(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);
const programId = "HzLFTDqqkeNzhrAB4rAPvTjzgjp2288stSmDLWQuKTNt";
const validatorLedgerDir = resolve(repoRoot, ".demo", "validator-ledger");
const programSoPath = resolve(
  repoRoot,
  "programs",
  "solyen",
  "target",
  "deploy",
  "solyen.so",
);
const demoStatePath = resolve(repoRoot, ".demo", "solana-state.json");

interface BackgroundProcess extends ServiceProcess {}

interface ServiceProcess {
  name: string;
  child: ChildProcess;
  healthUrl: string;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForHealth(url: string, name: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Service is still starting.
    }

    await delay(500);
  }

  throw new Error(`Timed out waiting for ${name} at ${url}`);
}

async function waitForRpc(url: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getLatestBlockhash",
        }),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Validator is still starting.
    }

    await delay(500);
  }

  throw new Error(`Timed out waiting for validator RPC at ${url}`);
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const child = spawn(command, args, {
    cwd,
    stdio: "inherit",
    env: env ?? process.env,
  });

  const [exitCode] = (await once(child, "exit")) as [number | null];
  if (exitCode !== 0) {
    throw new Error(
      `Command failed: ${command} ${args.join(" ")} (exit ${exitCode})`,
    );
  }
}

function spawnService(
  name: string,
  appDirectory: string,
  healthUrl: string,
): ServiceProcess {
  const child = spawn(
    tsxCommand,
    ["watch", "--conditions=development", "src/server.ts"],
    {
      cwd: resolve(repoRoot, appDirectory),
      stdio: "inherit",
      env: {
        ...process.env,
        SOLANA_RUNTIME: "validator",
        SOLANA_DEMO_STATE_PATH: demoStatePath,
        SOLANA_RPC_URL: config.rpcUrl,
      },
    },
  );

  return { name, child, healthUrl };
}

async function stopService(service: ServiceProcess): Promise<void> {
  if (service.child.exitCode !== null || service.child.killed) {
    return;
  }

  service.child.kill("SIGTERM");
  try {
    await Promise.race([
      once(service.child, "exit"),
      delay(3_000).then(() => {
        if (service.child.exitCode === null && !service.child.killed) {
          service.child.kill("SIGKILL");
        }
      }),
    ]);
  } catch {
    // Best effort cleanup.
  }
}

async function runVerify(): Promise<void> {
  const verifier = spawn(npmCommand, ["run", "verify:demo"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      SOLANA_RUNTIME: "validator",
      SOLANA_DEMO_STATE_PATH: demoStatePath,
      SOLANA_RPC_URL: config.rpcUrl,
      ORCHESTRATOR_BASE_URL: `http://${config.orchestrator.host}:${config.orchestrator.port}`,
      PUBLIC_API_BASE_URL: `http://${config.restApi.host}:${config.restApi.port}`,
    },
  });

  const [exitCode] = (await once(verifier, "exit")) as [number | null];
  if (exitCode !== 0) {
    throw new Error(`Demo verification failed with exit code ${exitCode}`);
  }
}

function spawnValidator(rpcUrl: string): BackgroundProcess {
  mkdirSync(dirname(validatorLedgerDir), { recursive: true });
  const rpc = new URL(rpcUrl);
  const child = spawn(
    solanaTestValidatorCommand,
    [
      "--reset",
      "--quiet",
      "--ledger",
      validatorLedgerDir,
      "--rpc-port",
      rpc.port,
      "--bind-address",
      rpc.hostname,
      "--bpf-program",
      programId,
      programSoPath,
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: process.env,
    },
  );

  return { name: "validator", child, healthUrl: rpcUrl };
}

async function main(): Promise<void> {
  await runCommand(
    anchorCommand,
    ["build"],
    resolve(repoRoot, "programs", "solyen"),
  );

  const validator = spawnValidator(config.rpcUrl);
  await waitForRpc(config.rpcUrl);

  await runCommand(tsxCommand, ["scripts/bootstrap-solana.ts"], repoRoot, {
    ...process.env,
    SOLANA_RUNTIME: "validator",
    SOLANA_DEMO_STATE_PATH: demoStatePath,
    SOLANA_RPC_URL: config.rpcUrl,
  });

  const services: ServiceProcess[] = [
    spawnService(
      "bank-core",
      "apps/bank-core",
      `http://${config.bankCore.host}:${config.bankCore.port}/health`,
    ),
    spawnService(
      "core-gateway",
      "apps/core-gateway",
      `http://${config.coreGateway.host}:${config.coreGateway.port}/health`,
    ),
    spawnService(
      "orchestrator",
      "apps/orchestrator",
      `http://${config.orchestrator.host}:${config.orchestrator.port}/health`,
    ),
    spawnService(
      "rest-api",
      "apps/rest-api",
      `http://${config.restApi.host}:${config.restApi.port}/health`,
    ),
  ];

  try {
    for (const service of services) {
      await waitForHealth(service.healthUrl, service.name);
    }

    await runVerify();
  } finally {
    await Promise.all(
      services.reverse().map((service) => stopService(service)),
    );
    await stopService(validator);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
