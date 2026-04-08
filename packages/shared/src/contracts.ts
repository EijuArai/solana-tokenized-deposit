import { z } from "zod";

export const customerIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]+$/);
export const operationIdSchema = z.string().min(1).max(128);
export const idempotencyKeySchema = z.string().min(8).max(128);
export const correlationIdSchema = z.string().min(8).max(128);
export const amountSchema = z.number().int().positive().max(1_000_000_000);
export const walletAddressSchema = z.string().min(16).max(96);

export const operationTypeSchema = z.enum(["tokenize", "transfer", "redeem"]);
export const operationStatusSchema = z.enum([
  "pending",
  "confirmed",
  "failed",
  "compensated",
]);

export const tokenizeRequestSchema = z.object({
  customerId: customerIdSchema,
  amount: amountSchema,
  idempotencyKey: idempotencyKeySchema,
  correlationId: correlationIdSchema.optional(),
});

export const transferRequestSchema = z.object({
  fromCustomerId: customerIdSchema,
  toCustomerId: customerIdSchema,
  amount: amountSchema,
  idempotencyKey: idempotencyKeySchema,
  correlationId: correlationIdSchema.optional(),
});

export const redeemRequestSchema = z.object({
  customerId: customerIdSchema,
  destinationCustomerId: customerIdSchema.optional(),
  amount: amountSchema,
  idempotencyKey: idempotencyKeySchema,
  correlationId: correlationIdSchema.optional(),
});

export const reserveMovementRequestSchema = z.object({
  operationId: operationIdSchema,
  idempotencyKey: idempotencyKeySchema,
  customerId: customerIdSchema,
  destinationCustomerId: customerIdSchema.optional(),
  amount: amountSchema,
  correlationId: correlationIdSchema,
});

export const custodyWalletSchema = z.object({
  customerId: customerIdSchema,
  walletAddress: walletAddressSchema,
  whitelisted: z.boolean(),
});

export const balanceViewSchema = z.object({
  customerId: customerIdSchema,
  depositBalance: amountSchema.or(z.literal(0)),
  reserveBalance: z.number().int().min(0),
  tokenBalance: z.number().int().min(0),
  walletAddress: walletAddressSchema,
  updatedAt: z.string(),
});

export const operationRecordSchema = z.object({
  operationId: operationIdSchema,
  idempotencyKey: idempotencyKeySchema,
  type: operationTypeSchema,
  status: operationStatusSchema,
  amount: amountSchema,
  sourceCustomerId: customerIdSchema.optional(),
  destinationCustomerId: customerIdSchema.optional(),
  correlationId: correlationIdSchema,
  txSignature: z.string().min(1).optional(),
  failureCode: z.string().min(1).optional(),
  steps: z.array(z.string().min(1)),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const reconciliationSnapshotSchema = z.object({
  reserveBalance: z.number().int().min(0),
  totalCustomerDeposits: z.number().int().min(0),
  customers: z.array(balanceViewSchema.omit({ tokenBalance: true })),
});

export const publicBalanceResponseSchema = z.object({
  customerId: customerIdSchema,
  depositBalance: z.number().int().min(0),
  reserveBalance: z.number().int().min(0),
  tokenBalance: z.number().int().min(0),
  walletAddress: walletAddressSchema,
  updatedAt: z.string(),
});

export const whitelistResponseSchema = z.object({
  wallets: z.array(walletAddressSchema),
});

export const persistedOperationSchema = z.object({
  fingerprint: z.string().min(1),
  record: operationRecordSchema,
});

export type TokenizeRequest = z.infer<typeof tokenizeRequestSchema>;
export type TransferRequest = z.infer<typeof transferRequestSchema>;
export type RedeemRequest = z.infer<typeof redeemRequestSchema>;
export type ReserveMovementRequest = z.infer<
  typeof reserveMovementRequestSchema
>;
export type CustodyWallet = z.infer<typeof custodyWalletSchema>;
export type BalanceView = z.infer<typeof balanceViewSchema>;
export type OperationType = z.infer<typeof operationTypeSchema>;
export type OperationStatus = z.infer<typeof operationStatusSchema>;
export type OperationRecord = z.infer<typeof operationRecordSchema>;
export type ReconciliationSnapshot = z.infer<
  typeof reconciliationSnapshotSchema
>;
export type PublicBalanceResponse = z.infer<typeof publicBalanceResponseSchema>;
export type WhitelistResponse = z.infer<typeof whitelistResponseSchema>;
export type PersistedOperation = z.infer<typeof persistedOperationSchema>;
