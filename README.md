---
post_title: Tokenized Deposit Demo
author1: GitHub Copilot
post_slug: tokenized-deposit-demo
microsoft_alias: not-applicable
featured_image: ""
categories: []
tags:
  - solana
  - token-2022
  - typescript
  - express
ai_note: AI was used to help draft this walkthrough from the implemented code.
summary: API-first demo for tokenized bank deposits with four Node.js services, a seeded ledger, and verified tokenize-transfer-redeem flows.
post_date: 2026-04-06
---

# Tokenized Deposit Demo

## Overview

This repository contains an API-first tokenized deposit demo for Solana-style
flows. The implementation is split across four independently runnable Node.js
services plus an Anchor program.

The current verified demo path uses:

- bank-core as the off-chain ledger source of truth
- core-gateway as the internal bank integration boundary
- orchestrator as the saga coordinator for tokenize, transfer, and redeem
- rest-api as the only public HTTP surface
- a validator-backed Solana runtime that bootstraps a local Anchor program and
  Token-2022 mint before the scenario runs

The local walkthrough now builds the Anchor program, starts
`solana-test-validator`, bootstraps the whitelist registry and Token-2022 mint,
then verifies the end-to-end tokenize, transfer, and redeem flow against that
runtime.

## Service Topology

| Service | Default Port | Responsibility |
| --- | --- | --- |
| bank-core | 4001 | SQLite-backed deposits, reserve account, custody mapping, durable saga state |
| core-gateway | 4002 | Internal gateway over bank-core |
| orchestrator | 4003 | Idempotent tokenize, transfer, redeem coordination |
| rest-api | 4004 | Public HTTP API |

Internal service calls use the shared x-internal-auth header configured through
INTERNAL_AUTH_TOKEN. Public callers never need that header.

## Seeded Customers

| Customer | Starting Deposit | Starting Token Balance | Wallet |
| --- | ---: | ---: | --- |
| user-a | 100000 JPY | 0 SolYEN | Generated during bootstrap |
| user-b | 50000 JPY | 0 SolYEN | Generated during bootstrap |

## Local Commands

Install dependencies:

```bash
npm install
```

Build all packages:

```bash
npm run build
```

Run the automated test suite:

```bash
npm test
```

Run the full demo in one command. This builds the Anchor program, starts a
local validator, bootstraps on-chain demo state, starts all four services,
waits for health checks, executes the verified scenario script, and shuts
everything down:

```bash
npm run demo:run
```

If you want to keep the services running for manual exploration:

```bash
npm run dev
```

For the validator-backed path, bootstrap state first and set the runtime:

```bash
SOLANA_RUNTIME=validator npm run solana:build
SOLANA_RUNTIME=validator npm run solana:bootstrap
SOLANA_RUNTIME=validator npm run dev
```

Then run the scenario verifier separately:

```bash
SOLANA_RUNTIME=validator npm run verify:demo
```

## Public API Sequence

### 1. Check balances

```bash
curl http://127.0.0.1:4004/balances/user-a
curl http://127.0.0.1:4004/balances/user-b
```

### 2. Tokenize 10000 JPY for user-a

```bash
curl -X POST http://127.0.0.1:4004/tokenize \
  -H 'content-type: application/json' \
  -d '{"customerId":"user-a","amount":10000,"idempotencyKey":"demo-tokenize-1"}'
```

Expected state after tokenization:

| Customer | Deposit | Reserve | Tokens |
| --- | ---: | ---: | ---: |
| user-a | 90000 | 10000 | 10000 |
| user-b | 50000 | 10000 | 0 |

### 3. Transfer 10000 SolYEN from user-a to user-b

```bash
curl -X POST http://127.0.0.1:4004/transfer \
  -H 'content-type: application/json' \
  -d '{"fromCustomerId":"user-a","toCustomerId":"user-b","amount":10000,"idempotencyKey":"demo-transfer-1"}'
```

Expected state after transfer:

| Customer | Deposit | Reserve | Tokens |
| --- | ---: | ---: | ---: |
| user-a | 90000 | 10000 | 0 |
| user-b | 50000 | 10000 | 10000 |

### 4. Redeem 10000 SolYEN for user-b

```bash
curl -X POST http://127.0.0.1:4004/redeem \
  -H 'content-type: application/json' \
  -d '{"customerId":"user-b","amount":10000,"idempotencyKey":"demo-redeem-1"}'
```

Expected final state:

| Customer | Deposit | Reserve | Tokens |
| --- | ---: | ---: | ---: |
| user-a | 90000 | 0 | 0 |
| user-b | 60000 | 0 | 0 |

### 5. Inspect operation state

Every state-changing response includes an operationId and correlationId. You can
query the recorded orchestration state with:

```bash
curl http://127.0.0.1:4004/operations/<operation-id>
```

## Negative Paths Covered

The automated verification covers these failure modes:

- insufficient deposit balance during tokenization
- non-whitelisted transfer after internal whitelist removal
- idempotent replay of the same tokenize request

## Current Limitations

- SQLite is in-memory, so a process restart resets the seeded demo state.
- Custody is bank-managed and simulated for demo purposes.
- The local validator flow depends on Solana CLI, Anchor CLI, and Cargo being
  installed on the machine.
- Unauthorized whitelist mutation still lacks dedicated negative tests at the
  Anchor-program level.

## Files To Start From

- packages/shared/src/contracts.ts
- apps/bank-core/src/db.ts
- apps/core-gateway/src/app.ts
- apps/orchestrator/src/app.ts
- apps/rest-api/src/app.ts
- scripts/run-demo.ts
- scripts/verify-demo.ts
