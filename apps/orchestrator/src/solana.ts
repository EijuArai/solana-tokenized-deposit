import { readFileSync } from "node:fs";
import { AnchorProvider, Program, Wallet, type Idl } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createBurnCheckedInstruction,
  createMintToCheckedInstruction,
  createTransferCheckedWithTransferHookInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  AppError,
  ERROR_CODES,
  defaultAuthorityKeypairPath,
  loadDemoConfig,
  readSolanaDemoState,
  type SolanaDemoState,
} from "@tokenized-deposit/shared";

export interface SolanaAdapter {
  listWhitelistedWallets(): Promise<string[]>;
  addWallet(walletAddress: string): Promise<void>;
  removeWallet(walletAddress: string): Promise<void>;
  getTokenBalance(walletAddress: string): Promise<number>;
  mint(walletAddress: string, amount: number): Promise<string>;
  transfer(
    fromWalletAddress: string,
    toWalletAddress: string,
    amount: number,
  ): Promise<string>;
  burn(walletAddress: string, amount: number): Promise<string>;
}

function signature(counter: number): string {
  return `sig-${counter.toString().padStart(6, "0")}`;
}

function keypairFromFile(path: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]),
  );
}

function keypairFromSecretKey(secretKey: number[]): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

function findCustomerKeypair(
  state: SolanaDemoState,
  walletAddress: string,
): Keypair {
  const customer = state.customers.find(
    (candidate) => candidate.walletAddress === walletAddress,
  );
  if (!customer) {
    throw new AppError(
      ERROR_CODES.NOT_FOUND,
      `Custody wallet not found: ${walletAddress}`,
      404,
    );
  }

  return keypairFromSecretKey(customer.secretKey);
}

function readProgramIdl(): Idl {
  return JSON.parse(
    readFileSync(
      new URL(
        "../../../programs/solyen/target/idl/solyen.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Idl;
}

function errorDetails(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const details = [error.message];
  const logs = Reflect.get(error as object, "logs");
  if (Array.isArray(logs)) {
    for (const line of logs) {
      if (typeof line === "string") {
        details.push(line);
      }
    }
  }

  return details.join("\n");
}

export class InMemorySolanaAdapter implements SolanaAdapter {
  private readonly whitelist = new Set<string>();
  private readonly balances = new Map<string, number>();
  private txCounter = 1;

  public constructor(seedWallets: string[]) {
    for (const wallet of seedWallets) {
      this.whitelist.add(wallet);
      this.balances.set(wallet, 0);
    }
  }

  public async listWhitelistedWallets(): Promise<string[]> {
    return [...this.whitelist].sort();
  }

  public async addWallet(walletAddress: string): Promise<void> {
    this.whitelist.add(walletAddress);
    this.balances.set(walletAddress, this.balances.get(walletAddress) ?? 0);
  }

  public async removeWallet(walletAddress: string): Promise<void> {
    this.whitelist.delete(walletAddress);
  }

  public async getTokenBalance(walletAddress: string): Promise<number> {
    return this.balances.get(walletAddress) ?? 0;
  }

  public async mint(walletAddress: string, amount: number): Promise<string> {
    this.assertWhitelisted(walletAddress);
    this.balances.set(
      walletAddress,
      (this.balances.get(walletAddress) ?? 0) + amount,
    );
    return this.nextSignature();
  }

  public async transfer(
    fromWalletAddress: string,
    toWalletAddress: string,
    amount: number,
  ): Promise<string> {
    this.assertWhitelisted(fromWalletAddress);
    this.assertWhitelisted(toWalletAddress);
    const fromBalance = this.balances.get(fromWalletAddress) ?? 0;
    if (fromBalance < amount) {
      throw new AppError(
        ERROR_CODES.INSUFFICIENT_FUNDS,
        "Token balance is insufficient",
        409,
        false,
        {
          available: fromBalance,
          required: amount,
        },
      );
    }

    this.balances.set(fromWalletAddress, fromBalance - amount);
    this.balances.set(
      toWalletAddress,
      (this.balances.get(toWalletAddress) ?? 0) + amount,
    );
    return this.nextSignature();
  }

  public async burn(walletAddress: string, amount: number): Promise<string> {
    this.assertWhitelisted(walletAddress);
    const balance = this.balances.get(walletAddress) ?? 0;
    if (balance < amount) {
      throw new AppError(
        ERROR_CODES.INSUFFICIENT_FUNDS,
        "Token balance is insufficient",
        409,
        false,
        {
          available: balance,
          required: amount,
        },
      );
    }

    this.balances.set(walletAddress, balance - amount);
    return this.nextSignature();
  }

  private assertWhitelisted(walletAddress: string): void {
    if (!this.whitelist.has(walletAddress)) {
      throw new AppError(
        ERROR_CODES.WHITELIST_REQUIRED,
        "Wallet is not whitelisted for Token-2022 transfers",
        409,
      );
    }
  }

  private nextSignature(): string {
    const value = signature(this.txCounter);
    this.txCounter += 1;
    return value;
  }
}

export class ValidatorSolanaAdapter implements SolanaAdapter {
  private readonly connection: Connection;
  private readonly state: SolanaDemoState;
  private readonly authority: Keypair;
  private readonly provider: AnchorProvider;
  private readonly program: Program<Idl>;
  private readonly dynamicProgram: {
    account: Record<string, { fetch(address: PublicKey): Promise<unknown> }>;
    methods: Record<
      string,
      (...args: unknown[]) => {
        accounts(accounts: Record<string, PublicKey>): {
          rpc(): Promise<string>;
          instruction(): Promise<Transaction["instructions"][number]>;
        };
      }
    >;
  };
  private readonly mintAddress: PublicKey;
  private readonly registryAddress: PublicKey;

  public constructor(state = readSolanaDemoState()) {
    if (!state) {
      throw new AppError(
        ERROR_CODES.INTERNAL_ERROR,
        "Solana demo state file is missing; run the bootstrap flow first",
        500,
      );
    }

    this.state = state;
    this.connection = new Connection(state.rpcUrl, "confirmed");
    this.authority = keypairFromFile(
      state.authoritySecretKeyPath || defaultAuthorityKeypairPath(),
    );
    this.provider = new AnchorProvider(
      this.connection,
      new Wallet(this.authority),
      { commitment: "confirmed" },
    );
    this.program = new Program(readProgramIdl(), this.provider);
    this.dynamicProgram = this
      .program as unknown as ValidatorSolanaAdapter["dynamicProgram"];
    this.mintAddress = new PublicKey(state.mintAddress);
    this.registryAddress = new PublicKey(state.registryAddress);
  }

  private getMethod(name: string) {
    const method = this.dynamicProgram.methods[name];
    if (!method) {
      throw new AppError(
        ERROR_CODES.INTERNAL_ERROR,
        `Anchor method is not available in IDL: ${name}`,
        500,
      );
    }

    return method;
  }

  private getRegistryAccountFetcher() {
    const account = this.dynamicProgram.account.whitelistRegistry;
    if (!account) {
      throw new AppError(
        ERROR_CODES.INTERNAL_ERROR,
        "Anchor whitelistRegistry account is not available in IDL",
        500,
      );
    }

    return account;
  }

  public async listWhitelistedWallets(): Promise<string[]> {
    const registry = (await this.getRegistryAccountFetcher().fetch(
      this.registryAddress,
    )) as { wallets: PublicKey[] };
    return registry.wallets.map((wallet) => wallet.toBase58()).sort();
  }

  public async addWallet(walletAddress: string): Promise<void> {
    await this.getMethod("registerWallet")(new PublicKey(walletAddress))
      .accounts({
        authority: this.authority.publicKey,
        registry: this.registryAddress,
      })
      .rpc();
  }

  public async removeWallet(walletAddress: string): Promise<void> {
    await this.getMethod("unregisterWallet")(new PublicKey(walletAddress))
      .accounts({
        authority: this.authority.publicKey,
        registry: this.registryAddress,
      })
      .rpc();
  }

  public async getTokenBalance(walletAddress: string): Promise<number> {
    const owner = new PublicKey(walletAddress);
    const tokenAccount = getAssociatedTokenAddressSync(
      this.mintAddress,
      owner,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    try {
      const account = await getAccount(
        this.connection,
        tokenAccount,
        "confirmed",
        TOKEN_2022_PROGRAM_ID,
      );
      return Number(account.amount);
    } catch {
      return 0;
    }
  }

  public async mint(walletAddress: string, amount: number): Promise<string> {
    await this.assertWhitelisted(walletAddress);
    const owner = new PublicKey(walletAddress);
    const tokenAccount = getAssociatedTokenAddressSync(
      this.mintAddress,
      owner,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const transaction = new Transaction().add(
      createMintToCheckedInstruction(
        this.mintAddress,
        tokenAccount,
        this.authority.publicKey,
        BigInt(amount),
        0,
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
    );

    return sendAndConfirmTransaction(this.connection, transaction, [
      this.authority,
    ]);
  }

  public async transfer(
    fromWalletAddress: string,
    toWalletAddress: string,
    amount: number,
  ): Promise<string> {
    const fromTokenBalance = await this.getTokenBalance(fromWalletAddress);
    if (fromTokenBalance < amount) {
      throw new AppError(
        ERROR_CODES.INSUFFICIENT_FUNDS,
        "Token balance is insufficient",
        409,
        false,
        {
          available: fromTokenBalance,
          required: amount,
        },
      );
    }

    const fromOwner = findCustomerKeypair(this.state, fromWalletAddress);
    const fromTokenAccount = getAssociatedTokenAddressSync(
      this.mintAddress,
      fromOwner.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const toOwner = new PublicKey(toWalletAddress);
    const toTokenAccount = getAssociatedTokenAddressSync(
      this.mintAddress,
      toOwner,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const transferInstruction =
      await createTransferCheckedWithTransferHookInstruction(
        this.connection,
        fromTokenAccount,
        this.mintAddress,
        toTokenAccount,
        fromOwner.publicKey,
        BigInt(amount),
        0,
        [],
        "confirmed",
        TOKEN_2022_PROGRAM_ID,
      );
    const transaction = new Transaction().add(transferInstruction);
    transaction.feePayer = this.authority.publicKey;

    try {
      return await sendAndConfirmTransaction(this.connection, transaction, [
        this.authority,
        fromOwner,
      ]);
    } catch (error) {
      const details = errorDetails(error);
      if (
        details.includes("WalletNotWhitelisted") ||
        details.includes("Wallet is not whitelisted")
      ) {
        throw new AppError(
          ERROR_CODES.WHITELIST_REQUIRED,
          "Wallet is not whitelisted for Token-2022 transfers",
          409,
        );
      }

      throw error;
    }
  }

  public async burn(walletAddress: string, amount: number): Promise<string> {
    const owner = findCustomerKeypair(this.state, walletAddress);
    const tokenAccount = getAssociatedTokenAddressSync(
      this.mintAddress,
      owner.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const balance = await this.getTokenBalance(walletAddress);
    if (balance < amount) {
      throw new AppError(
        ERROR_CODES.INSUFFICIENT_FUNDS,
        "Token balance is insufficient",
        409,
        false,
        {
          available: balance,
          required: amount,
        },
      );
    }

    const transaction = new Transaction().add(
      createBurnCheckedInstruction(
        tokenAccount,
        this.mintAddress,
        owner.publicKey,
        BigInt(amount),
        0,
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
    );

    return sendAndConfirmTransaction(this.connection, transaction, [
      this.authority,
      owner,
    ]);
  }

  private async assertWhitelisted(walletAddress: string): Promise<void> {
    const whitelist = await this.listWhitelistedWallets();
    if (!whitelist.includes(walletAddress)) {
      throw new AppError(
        ERROR_CODES.WHITELIST_REQUIRED,
        "Wallet is not whitelisted for Token-2022 transfers",
        409,
      );
    }
  }
}

export function createRuntimeSolanaAdapter(): SolanaAdapter {
  const config = loadDemoConfig();
  if (config.solanaRuntime === "validator") {
    return new ValidatorSolanaAdapter();
  }

  return new InMemorySolanaAdapter(
    config.seedCustomers.map((customer) => customer.walletAddress),
  );
}
