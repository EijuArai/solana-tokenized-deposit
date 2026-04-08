import { describe, expect, it } from "vitest";
import { BankCoreRepository } from "../apps/bank-core/src/db.js";

describe("bank core repository", () => {
  it("conserves customer deposits and reserve when funding reserve", () => {
    const repository = new BankCoreRepository();
    const before = repository.getReconciliationSnapshot();

    repository.fundReserve({
      operationId: "op-fund-1",
      idempotencyKey: "idem-fund-1",
      customerId: "user-a",
      amount: 10000,
      correlationId: "corr-fund-1",
    });

    const after = repository.getReconciliationSnapshot();
    expect(before.totalCustomerDeposits + before.reserveBalance).toBe(
      after.totalCustomerDeposits + after.reserveBalance,
    );
    expect(after.reserveBalance).toBe(10000);
    expect(repository.getBalance("user-a").depositBalance).toBe(90000);
  });

  it("rejects reserve funding when deposit balance is insufficient", () => {
    const repository = new BankCoreRepository();

    expect(() =>
      repository.fundReserve({
        operationId: "op-fund-2",
        idempotencyKey: "idem-fund-2",
        customerId: "user-a",
        amount: 999999,
        correlationId: "corr-fund-2",
      }),
    ).toThrow();
  });
});
