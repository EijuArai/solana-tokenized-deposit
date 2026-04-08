import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AnchorProvider, Program, Wallet, type Idl } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  createInitializeTransferHookInstruction,
  createInitializeMintInstruction,
  getExtraAccountMetaAddress,
  getMintLen,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  defaultAuthorityKeypairPath,
  defaultSolanaDemoStatePath,
  loadDemoConfig,
  type SolanaDemoState,
} from "@tokenized-deposit/shared";

const config = loadDemoConfig();
const statePath = config.solanaDemoStatePath || defaultSolanaDemoStatePath();
const authorityKeypairPath = defaultAuthorityKeypairPath();
const programId = new PublicKey("HzLFTDqqkeNzhrAB4rAPvTjzgjp2288stSmDLWQuKTNt");
const seedBalances = new Map([
  ["user-a", 100000],
  ["user-b", 50000],
]);

function keypairToArray(keypair: Keypair): number[] {
  return Array.from(keypair.secretKey);
}

function persistKeypair(path: string, keypair: Keypair): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(keypairToArray(keypair)));
}

function readProgramIdl(): Idl {
  return JSON.parse(
    readFileSync(
      resolve(
        dirname(statePath),
        "..",
        "programs",
        "solyen",
        "target",
        "idl",
        "solyen.json",
      ),
      "utf8",
    ),
  ) as Idl;
}

async function airdrop(
  connection: Connection,
  address: PublicKey,
): Promise<void> {
  const signature = await connection.requestAirdrop(
    address,
    2 * LAMPORTS_PER_SOL,
  );
  await connection.confirmTransaction(signature, "confirmed");
}

async function main(): Promise<void> {
  const connection = new Connection(config.rpcUrl, "confirmed");
  const authority = Keypair.generate();
  persistKeypair(authorityKeypairPath, authority);

  await airdrop(connection, authority.publicKey);

  const provider = new AnchorProvider(connection, new Wallet(authority), {
    commitment: "confirmed",
  });
  const program = new Program(readProgramIdl(), provider);
  const [registryAddress] = PublicKey.findProgramAddressSync(
    [Buffer.from("registry")],
    programId,
  );

  await program.methods
    .initializeRegistry()
    .accounts({
      authority: authority.publicKey,
      registry: registryAddress,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  const mint = Keypair.generate();
  const mintSize = getMintLen([ExtensionType.TransferHook]);
  const mintLamports =
    await connection.getMinimumBalanceForRentExemption(mintSize);
  const extraMetasAddress = getExtraAccountMetaAddress(
    mint.publicKey,
    programId,
  );
  const mintTransaction = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: authority.publicKey,
      newAccountPubkey: mint.publicKey,
      lamports: mintLamports,
      space: mintSize,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeTransferHookInstruction(
      mint.publicKey,
      authority.publicKey,
      programId,
      TOKEN_2022_PROGRAM_ID,
    ),
    createInitializeMintInstruction(
      mint.publicKey,
      0,
      authority.publicKey,
      null,
      TOKEN_2022_PROGRAM_ID,
    ),
  );
  await sendAndConfirmTransaction(connection, mintTransaction, [
    authority,
    mint,
  ]);

  await program.methods
    .initializeExtraAccountMetaList()
    .accounts({
      extraMetasAccount: extraMetasAddress,
      mint: mint.publicKey,
      authority: authority.publicKey,
      registry: registryAddress,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  const customers = await Promise.all(
    [
      { customerId: "user-a", name: "User A" },
      { customerId: "user-b", name: "User B" },
    ].map(async (customer) => {
      const wallet = Keypair.generate();
      const tokenAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        authority,
        mint.publicKey,
        wallet.publicKey,
        false,
        "confirmed",
        undefined,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      await program.methods
        .registerWallet(wallet.publicKey)
        .accounts({
          authority: authority.publicKey,
          registry: registryAddress,
        })
        .rpc();

      return {
        customerId: customer.customerId,
        name: customer.name,
        depositBalance: seedBalances.get(customer.customerId) ?? 0,
        walletAddress: wallet.publicKey.toBase58(),
        tokenAccountAddress: tokenAccount.address.toBase58(),
        secretKey: keypairToArray(wallet),
      };
    }),
  );

  const state: SolanaDemoState = {
    rpcUrl: config.rpcUrl,
    programId: programId.toBase58(),
    registryAddress: registryAddress.toBase58(),
    mintAddress: mint.publicKey.toBase58(),
    extraMetasAddress: extraMetasAddress.toBase58(),
    authoritySecretKeyPath: authorityKeypairPath,
    customers,
  };

  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  console.log(`Solana demo state written to ${statePath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
