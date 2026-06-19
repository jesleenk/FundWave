// Typed wrapper around the deployed FundWave Soroban contract.
// All public contract methods are exposed as plain TS functions that return
// decoded values and accept the standard `tx` signers from the wallet kit.

import {
  Contract,
  nativeToScVal,
  scValToNative,
  Transaction,
  TransactionBuilder,
  Account,
  Operation,
  Address,
  xdr,
  rpc as SorobanRpc,
} from "@stellar/stellar-sdk";
import { NETWORK, CONTRACT_ID, SOROBAN_RPC_URL, NATIVE_TOKEN_ADDRESS } from "./network";

export type CampaignStatus = "Active" | "Successful" | "Failed" | "Withdrawn";

export interface Campaign {
  id: number;
  creator: string;
  goal: string;       // raw i128 as string to avoid BigInt serialization
  raised: string;
  deadline: number;   // unix seconds
  title: string;
  description: string;
  status: CampaignStatus;
}

let _server: SorobanRpc.Server | null = null;
let _contract: Contract | null = null;

function server(): SorobanRpc.Server {
  if (!_server) {
    _server = new SorobanRpc.Server(SOROBAN_RPC_URL[NETWORK], {
      allowHttp: NETWORK === "local",
    });
  }
  return _server;
}

export function contract(): Contract {
  if (!CONTRACT_ID) {
    throw new Error(
      "Contract not configured. Run `./scripts/deploy.sh` and restart the dev server.",
    );
  }
  if (!_contract) {
    _contract = new Contract(CONTRACT_ID);
  }
  return _contract;
}

// --- helpers --------------------------------------------------------------

function addrScVal(s: string) {
  return new Address(s).toScVal();
}

function u64ScVal(n: number | bigint) {
  return nativeToScVal(BigInt(n), { type: "u64" });
}

function i128ScVal(s: string | number | bigint) {
  return nativeToScVal(BigInt(s), { type: "i128" });
}

function strScVal(s: string) {
  return nativeToScVal(s, { type: "string" });
}

// `raw` is already a native JS value produced by `scValToNative`: a plain
// object for a ScvMap (Campaign struct) or one element of a ScvVec.
function decodeCampaign(raw: unknown): Campaign {
  const c = raw as Record<string, unknown>;
  return {
    id: Number(c.id),
    creator: String(c.creator),
    goal: String(c.goal),
    raised: String(c.raised),
    deadline: Number(c.deadline),
    title: String(c.title),
    description: String(c.description),
    status: String(c.status) as CampaignStatus,
  };
}

// --- simulate + send ------------------------------------------------------

export interface SendOptions {
  /** Address of the connected wallet (also the transaction source). */
  publicKey: string;
  /** Wallet adapter's signAndSend / signTransaction. */
  signTransaction: (txXdr: string, opts?: { networkPassphrase?: string }) => Promise<{
    signedTxXdr: string;
  }>;
}

async function simulate<T>(method: string, args: xdr.ScVal[]): Promise<T> {
  const c = contract();
  const tx = new TransactionBuilder(
    new Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "0"),
    { fee: "100", networkPassphrase: networkPassphrase() },
  )
    .addOperation(c.call(method, ...args))
    .setTimeout(30)
    .build();
  return server().simulateTransaction(tx) as unknown as T;
}

async function invoke(
  method: string,
  args: xdr.ScVal[],
  opts: SendOptions,
): Promise<SorobanRpc.Api.GetTransactionResponse> {
  const c = contract();
  const account = await server().getAccount(opts.publicKey);
  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(c.call(method, ...args))
    .setTimeout(60)
    .build();
  const prepared = await server().prepareTransaction(tx);
  const signed = await opts.signTransaction(prepared.toXDR(), {
    networkPassphrase: networkPassphrase(),
  });
  const txObj = TransactionBuilder.fromXDR(
    signed.signedTxXdr,
    networkPassphrase(),
  ) as Transaction;
  const result = await server().sendTransaction(txObj);
  // Poll for completion
  let attempts = 0;
  while (attempts++ < 30) {
    await new Promise((r) => setTimeout(r, 1000));
    const status = await server().getTransaction(result.hash);
    // status is one of: NOT_FOUND, SUCCESS, FAILED, PENDING
    if (status.status !== "NOT_FOUND" && (status as { status: string }).status !== "PENDING") {
      return status;
    }
  }
  // Timed out — return what we have
  return server().getTransaction(result.hash);
}

function networkPassphrase(): string {
  switch (NETWORK) {
    case "mainnet":
      return "Public Global Stellar Network ; September 2015";
    case "testnet":
      return "Test SDF Network ; September 2015";
    case "futurenet":
      return "Test Future Network ; October 2022";
    default:
      return "Standalone Network ; February 2017";
  }
}

// --- read methods --------------------------------------------------------

export async function listCampaigns(from = 0, limit = 50): Promise<Campaign[]> {
  const res = await simulate<{ result: { retval: xdr.ScVal } }>(
    "list_campaigns",
    [u64ScVal(from), nativeToScVal(limit, { type: "u32" })],
  );
  const arr = scValToNative(res.result.retval) as unknown[];
  return arr.map(decodeCampaign);
}

export async function getCampaign(id: number): Promise<Campaign | null> {
  try {
    const res = await simulate<{ result: { retval: xdr.ScVal } }>(
      "get_campaign",
      [u64ScVal(id)],
    );
    // scValToNative converts ScvVoid -> null, ScvSome(T) -> T, and maps
    // (Vec, Map) to (Array, Object). It does not call `.switch()` on the
    // xdr value, so it works across SDK versions where ScVal is exposed
    // as a different class shape.
    const native = scValToNative(res.result.retval);
    if (native == null) return null;
    return decodeCampaign(native);
  } catch {
    return null;
  }
}

export async function getDonorBalance(id: number, donor: string): Promise<string> {
  const res = await simulate<{ result: { retval: xdr.ScVal } }>(
    "donor_balance",
    [u64ScVal(id), addrScVal(donor)],
  );
  return String(scValToNative(res.result.retval));
}

// --- write methods -------------------------------------------------------

export async function createCampaign(
  p: {
    creator: string;
    goal: string;
    deadlineUnix: number;
    title: string;
    description: string;
  },
  opts: SendOptions,
) {
  return invoke(
    "create_campaign",
    [
      addrScVal(p.creator),
      addrScVal(defaultToken()),
      i128ScVal(p.goal),
      u64ScVal(p.deadlineUnix),
      strScVal(p.title),
      strScVal(p.description),
    ],
    opts,
  );
}

export async function donate(
  p: { id: number; donor: string; amount: string },
  opts: SendOptions,
) {
  return invoke(
    "donate",
    [u64ScVal(p.id), addrScVal(p.donor), i128ScVal(p.amount)],
    opts,
  );
}

export async function finalize(id: number, opts: SendOptions) {
  return invoke("finalize", [u64ScVal(id)], opts);
}

export async function withdraw(id: number, opts: SendOptions) {
  return invoke("withdraw", [u64ScVal(id)], opts);
}

export async function refund(id: number, donor: string, opts: SendOptions) {
  return invoke("refund", [u64ScVal(id), addrScVal(donor)], opts);
}

// --- helpers used by the UI ---------------------------------------------

export function defaultToken(): string {
  return NATIVE_TOKEN_ADDRESS[NETWORK] ?? NATIVE_TOKEN_ADDRESS.testnet;
}

export function pct(raised: string, goal: string): number {
  const r = Number(raised);
  const g = Number(goal);
  if (g === 0) return 0;
  return Math.min(100, Math.max(0, (r / g) * 100));
}

export function fmtStroops(value: string | number, decimals = 7): string {
  // Stroops are the smallest unit. 1 XLM = 10^7 stroops.
  const v = BigInt(value);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = v % base;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : whole.toString();
}
