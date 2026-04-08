import Database from "better-sqlite3";
import {
  AppError,
  ERROR_CODES,
  type BalanceView,
  type CustodyWallet,
  type OperationRecord,
  operationRecordSchema,
  type PersistedOperation,
  type ReserveMovementRequest,
  loadDemoConfig,
} from "@tokenized-deposit/shared";

interface CustomerRow {
  customer_id: string;
  deposit_balance: number;
  wallet_address: string;
  wallet_secret: string;
}

interface OperationRow {
  operation_id: string;
  idempotency_key: string;
  type: string;
  status: string;
  amount: number;
  source_customer_id: string | null;
  destination_customer_id: string | null;
  correlation_id: string;
  tx_signature: string | null;
  failure_code: string | null;
  steps: string;
  created_at: string;
  updated_at: string;
}

interface SagaOperationRow {
  operation_id: string;
  idempotency_key: string;
  payload_fingerprint: string;
  record_json: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function walletSecretFor(customerId: string): string {
  return `demo-custody-secret-${customerId}`;
}

export class BankCoreRepository {
  private readonly database: Database.Database;

  public constructor() {
    this.database = new Database(":memory:");
    this.database.pragma("journal_mode = WAL");
    this.initialize();
    this.seed();
  }

  private initialize(): void {
    this.database.exec(`
      CREATE TABLE customers (
        customer_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        deposit_balance INTEGER NOT NULL,
        wallet_address TEXT NOT NULL UNIQUE,
        wallet_secret TEXT NOT NULL
      );

      CREATE TABLE system_state (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );

      CREATE TABLE operation_journal (
        operation_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        amount INTEGER NOT NULL,
        source_customer_id TEXT,
        destination_customer_id TEXT,
        correlation_id TEXT NOT NULL,
        tx_signature TEXT,
        failure_code TEXT,
        steps TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE saga_operations (
        operation_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        payload_fingerprint TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
    `);
  }

  private seed(): void {
    const config = loadDemoConfig();
    const insertCustomer = this.database.prepare(
      `INSERT INTO customers (customer_id, name, deposit_balance, wallet_address, wallet_secret)
       VALUES (@customerId, @name, @depositBalance, @walletAddress, @walletSecret)`,
    );

    for (const customer of config.seedCustomers) {
      insertCustomer.run({
        ...customer,
        walletSecret: walletSecretFor(customer.customerId),
      });
    }

    this.database
      .prepare(
        "INSERT INTO system_state (key, value) VALUES ('reserve_balance', 0)",
      )
      .run();
  }

  private getCustomerRow(customerId: string): CustomerRow {
    const row = this.database
      .prepare(
        `SELECT customer_id, deposit_balance, wallet_address, wallet_secret
         FROM customers WHERE customer_id = ?`,
      )
      .get(customerId) as CustomerRow | undefined;

    if (!row) {
      throw new AppError(
        ERROR_CODES.NOT_FOUND,
        `Customer not found: ${customerId}`,
        404,
      );
    }

    return row;
  }

  private getReserveBalance(): number {
    const row = this.database
      .prepare("SELECT value FROM system_state WHERE key = 'reserve_balance'")
      .get([]) as { value: number } | undefined;
    return row?.value ?? 0;
  }

  public getBalance(customerId: string): BalanceView {
    const customer = this.getCustomerRow(customerId);

    return {
      customerId,
      depositBalance: customer.deposit_balance,
      reserveBalance: this.getReserveBalance(),
      tokenBalance: 0,
      walletAddress: customer.wallet_address,
      updatedAt: nowIso(),
    };
  }

  public getWallet(customerId: string): CustodyWallet {
    const customer = this.getCustomerRow(customerId);

    return {
      customerId,
      walletAddress: customer.wallet_address,
      whitelisted: true,
    };
  }

  public getSagaOperationByIdempotencyKey(
    idempotencyKey: string,
  ): PersistedOperation | undefined {
    const row = this.database
      .prepare(
        "SELECT operation_id, idempotency_key, payload_fingerprint, record_json FROM saga_operations WHERE idempotency_key = ?",
      )
      .get(idempotencyKey) as SagaOperationRow | undefined;

    return row ? this.mapSagaOperation(row) : undefined;
  }

  public getSagaOperationById(
    operationId: string,
  ): PersistedOperation | undefined {
    const row = this.database
      .prepare(
        "SELECT operation_id, idempotency_key, payload_fingerprint, record_json FROM saga_operations WHERE operation_id = ?",
      )
      .get(operationId) as SagaOperationRow | undefined;

    return row ? this.mapSagaOperation(row) : undefined;
  }

  public createSagaOperation(
    operation: PersistedOperation,
  ): PersistedOperation {
    const existing = this.getSagaOperationByIdempotencyKey(
      operation.record.idempotencyKey,
    );
    if (existing) {
      return existing;
    }

    this.database
      .prepare(
        `INSERT INTO saga_operations (operation_id, idempotency_key, payload_fingerprint, record_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        operation.record.operationId,
        operation.record.idempotencyKey,
        operation.fingerprint,
        JSON.stringify(operation.record),
      );

    return this.getSagaOperationById(operation.record.operationId)!;
  }

  public updateSagaOperation(
    operationId: string,
    record: OperationRecord,
  ): PersistedOperation {
    const existing = this.getSagaOperationById(operationId);
    if (!existing) {
      throw new AppError(
        ERROR_CODES.NOT_FOUND,
        `Saga operation not found: ${operationId}`,
        404,
      );
    }

    this.database
      .prepare(
        "UPDATE saga_operations SET record_json = ? WHERE operation_id = ?",
      )
      .run(JSON.stringify(record), operationId);

    return this.getSagaOperationById(operationId)!;
  }

  public getOperation(operationId: string): OperationRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM operation_journal WHERE operation_id = ?")
      .get(operationId) as OperationRow | undefined;
    return row ? this.mapOperation(row) : undefined;
  }

  public fundReserve(request: ReserveMovementRequest): OperationRecord {
    const existingOperation = this.getOperation(request.operationId);
    if (existingOperation) {
      return existingOperation;
    }

    const execute = this.database.transaction(
      (payload: ReserveMovementRequest): OperationRecord => {
        const customer = this.getCustomerRow(payload.customerId);
        if (customer.deposit_balance < payload.amount) {
          throw new AppError(
            ERROR_CODES.INSUFFICIENT_FUNDS,
            "Customer deposit balance is insufficient",
            409,
            false,
            {
              customerId: payload.customerId,
              available: customer.deposit_balance,
              required: payload.amount,
            },
          );
        }

        this.database
          .prepare(
            "UPDATE customers SET deposit_balance = deposit_balance - ? WHERE customer_id = ?",
          )
          .run(payload.amount, payload.customerId);
        this.database
          .prepare(
            "UPDATE system_state SET value = value + ? WHERE key = 'reserve_balance'",
          )
          .run(payload.amount);

        const timestamp = nowIso();
        this.database
          .prepare(
            `INSERT INTO operation_journal (
            operation_id, idempotency_key, type, status, amount, source_customer_id,
            destination_customer_id, correlation_id, tx_signature, failure_code,
            steps, created_at, updated_at
          ) VALUES (?, ?, 'tokenize', 'confirmed', ?, ?, NULL, ?, NULL, NULL, ?, ?, ?)`,
          )
          .run(
            payload.operationId,
            payload.idempotencyKey,
            payload.amount,
            payload.customerId,
            payload.correlationId,
            JSON.stringify(["reserve-funded"]),
            timestamp,
            timestamp,
          );

        return this.getOperation(payload.operationId)!;
      },
    );

    return execute(request);
  }

  public releaseReserve(request: ReserveMovementRequest): OperationRecord {
    const existingOperation = this.getOperation(request.operationId);
    if (existingOperation) {
      return existingOperation;
    }

    const destinationCustomerId =
      request.destinationCustomerId ?? request.customerId;

    const execute = this.database.transaction(
      (payload: ReserveMovementRequest): OperationRecord => {
        this.getCustomerRow(destinationCustomerId);
        const reserveBalance = this.getReserveBalance();
        if (reserveBalance < payload.amount) {
          throw new AppError(
            ERROR_CODES.INSUFFICIENT_FUNDS,
            "Reserve balance is insufficient",
            409,
            false,
            {
              available: reserveBalance,
              required: payload.amount,
            },
          );
        }

        this.database
          .prepare(
            "UPDATE system_state SET value = value - ? WHERE key = 'reserve_balance'",
          )
          .run(payload.amount);
        this.database
          .prepare(
            "UPDATE customers SET deposit_balance = deposit_balance + ? WHERE customer_id = ?",
          )
          .run(payload.amount, destinationCustomerId);

        const timestamp = nowIso();
        this.database
          .prepare(
            `INSERT INTO operation_journal (
            operation_id, idempotency_key, type, status, amount, source_customer_id,
            destination_customer_id, correlation_id, tx_signature, failure_code,
            steps, created_at, updated_at
          ) VALUES (?, ?, 'redeem', 'confirmed', ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
          )
          .run(
            payload.operationId,
            payload.idempotencyKey,
            payload.amount,
            payload.customerId,
            destinationCustomerId,
            payload.correlationId,
            JSON.stringify(["reserve-released"]),
            timestamp,
            timestamp,
          );

        return this.getOperation(payload.operationId)!;
      },
    );

    return execute(request);
  }

  public getReconciliationSnapshot(): {
    reserveBalance: number;
    totalCustomerDeposits: number;
    customers: Array<Omit<BalanceView, "tokenBalance">>;
  } {
    const rows = this.database
      .prepare(
        "SELECT customer_id, deposit_balance, wallet_address, wallet_secret FROM customers ORDER BY customer_id ASC",
      )
      .all([]) as CustomerRow[];

    const reserveBalance = this.getReserveBalance();
    const customers = rows.map((row) => ({
      customerId: row.customer_id,
      depositBalance: row.deposit_balance,
      reserveBalance,
      walletAddress: row.wallet_address,
      updatedAt: nowIso(),
    }));

    return {
      reserveBalance,
      totalCustomerDeposits: rows.reduce(
        (sum, row) => sum + row.deposit_balance,
        0,
      ),
      customers,
    };
  }

  private mapOperation(row: OperationRow): OperationRecord {
    return {
      operationId: row.operation_id,
      idempotencyKey: row.idempotency_key,
      type: row.type as OperationRecord["type"],
      status: row.status as OperationRecord["status"],
      amount: row.amount,
      sourceCustomerId: row.source_customer_id ?? undefined,
      destinationCustomerId: row.destination_customer_id ?? undefined,
      correlationId: row.correlation_id,
      txSignature: row.tx_signature ?? undefined,
      failureCode: row.failure_code ?? undefined,
      steps: JSON.parse(row.steps) as string[],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapSagaOperation(row: SagaOperationRow): PersistedOperation {
    return {
      fingerprint: row.payload_fingerprint,
      record: operationRecordSchema.parse(JSON.parse(row.record_json)),
    };
  }
}
