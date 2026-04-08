import { describe, expect, it } from "vitest";
import {
  operationStatusSchema,
  tokenizeRequestSchema,
  transferRequestSchema,
  redeemRequestSchema,
} from "@tokenized-deposit/shared";

describe("shared contracts", () => {
  it("accepts canonical tokenize requests", () => {
    const result = tokenizeRequestSchema.parse({
      customerId: "user-a",
      amount: 10000,
      idempotencyKey: "idem-tokenize-0001",
    });

    expect(result.customerId).toBe("user-a");
  });

  it("rejects invalid transfer amounts", () => {
    expect(() =>
      transferRequestSchema.parse({
        fromCustomerId: "user-a",
        toCustomerId: "user-b",
        amount: 0,
        idempotencyKey: "idem-transfer-0001",
      }),
    ).toThrow();
  });

  it("allows redeem requests with implicit destination and covers operation states", () => {
    expect(
      redeemRequestSchema.parse({
        customerId: "user-b",
        amount: 10000,
        idempotencyKey: "idem-redeem-0001",
      }).destinationCustomerId,
    ).toBeUndefined();

    expect(operationStatusSchema.options).toEqual([
      "pending",
      "confirmed",
      "failed",
      "compensated",
    ]);
  });
});
