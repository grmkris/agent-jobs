/** All economic evidence is reconstructed from receipts, including reverted attempts. */
import {
  type Address,
  type Hex,
  type TransactionReceipt,
  erc20Abi,
  formatEther,
  parseTransaction,
} from "viem";
import * as sdk from "../../../src/index.ts";
import { CAP_WEI, budgetRemaining, required } from "./guards.ts";
import { RunState } from "./state.ts";

export interface ReceiptEvidence {
  txHash: Hex;
  status: string;
  gasUsed: string;
  effectiveGasPrice: string;
  costWei: string;
  nativeValueWei: string;
  blockNumber: string;
  from: Address;
  nonce: number;
}

export class Chain {
  readonly ctx = sdk.context("monad-testnet", "main", required("MONAD_TESTNET_RPC_URL"));
  readonly journal: sdk.FlowJournal;

  constructor(readonly run: RunState) {
    this.journal = new sdk.FlowJournal(
      this.ctx,
      run.state,
      () => run.save(),
      () => {},
    );
  }

  async initialize(): Promise<void> {
    if ((await this.ctx.publicClient.getChainId()) !== 10143) throw new Error("P8_WRONG_CHAIN");
    const block = await this.ctx.publicClient.getBlockNumber();
    if (this.run.get("firstBlock") === undefined) this.run.set("firstBlock", block);
    await this.audit();
  }

  get receipts(): ReceiptEvidence[] {
    return (this.run.budget.values.receipts as ReceiptEvidence[]) ?? [];
  }

  get reservations(): Record<string, string> {
    return (this.run.budget.values.reservations as Record<string, string>) ?? {};
  }

  async record(hash: Hex): Promise<TransactionReceipt> {
    const receipt = await this.ctx.publicClient.waitForTransactionReceipt({
      hash,
      timeout: 60_000,
    });
    if (!this.receipts.some((item) => item.txHash === hash)) {
      const tx = await this.ctx.publicClient.getTransaction({ hash });
      if (this.receipts.some((item) => item.txHash === hash)) return receipt;
      this.run.budgetSet("receipts", [
        ...this.receipts,
        {
          txHash: hash,
          status: receipt.status,
          gasUsed: receipt.gasUsed.toString(),
          effectiveGasPrice: receipt.effectiveGasPrice.toString(),
          costWei: (
            receipt.gasUsed * receipt.effectiveGasPrice +
            (receipt.status === "success" ? tx.value : 0n)
          ).toString(),
          nativeValueWei: (receipt.status === "success" ? tx.value : 0n).toString(),
          blockNumber: receipt.blockNumber.toString(),
          from: tx.from,
          nonce: tx.nonce,
        },
      ]);
    }
    return receipt;
  }

  /** Count all relay traffic conservatively; no attribution guess can undercount a fixture. */
  async audit(): Promise<void> {
    const start = this.run.get<bigint>("auditBlock") ?? this.run.get<bigint>("firstBlock");
    if (start === undefined) return;
    const end = await this.ctx.publicClient.getBlockNumber();
    const senders = new Set(
      [this.ctx.deployment.relay, ...(this.run.get<Address[]>("actors") ?? [])].map((item) =>
        item.toLowerCase(),
      ),
    );
    for (let number = start; number <= end; number++) {
      const block = await this.ctx.publicClient.getBlock({
        blockNumber: number,
        includeTransactions: true,
      });
      for (const tx of block.transactions) {
        if (senders.has(tx.from.toLowerCase())) await this.record(tx.hash);
      }
      this.run.set("auditBlock", number + 1n);
    }
    budgetRemaining(this.receipts, this.reservations);
  }

  addActor(address: Address): void {
    const actors = this.run.get<Address[]>("actors") ?? [];
    if (!actors.some((item) => item.toLowerCase() === address.toLowerCase()))
      this.run.set("actors", [...actors, address]);
  }

  async reserve(key: string, maxGas: bigint, nativeValue = 0n): Promise<void> {
    await this.audit();
    const scoped = `${this.run.runId}/${key}`;
    if (this.reservations[scoped] !== undefined) return;
    const fees = await sdk.transactionFees(this.ctx.publicClient);
    // Recheck immediately before an effect; reserve a 2x price margin above the product quote.
    const cost = maxGas * fees.maxFeePerGas * 2n + nativeValue;
    if (cost > budgetRemaining(this.receipts, this.reservations))
      throw new Error("P8_BUDGET_RESERVATION_REFUSED");
    this.run.budgetSet("reservations", { ...this.reservations, [scoped]: cost.toString() });
  }

  async finish(key: string, hashes: Hex[]): Promise<void> {
    for (const hash of hashes) await this.record(hash);
    // Never release a reservation after a lost response: the caller must first reconcile.
    const next = { ...this.reservations };
    delete next[`${this.run.runId}/${key}`];
    this.run.budgetSet("reservations", next);
    await this.audit();
  }

  async send(key: string, wallet: sdk.Wallet, tx: sdk.TxRequest): Promise<TransactionReceipt> {
    if (tx.chainId !== 10143 || tx.value !== "0") throw new Error("P8_FIXTURE_TRANSACTION_REFUSED");
    this.addActor(wallet.account.address);
    const saved = this.run.state.sends[key];
    if (saved !== undefined) {
      const mined = await this.journal.mined(key);
      if (mined !== undefined) {
        await this.finish(key, [mined.transactionHash]);
        return mined;
      }
    }
    const explicit = tx.gas === undefined ? undefined : BigInt(tx.gas);
    const prior = saved === undefined ? undefined : parseTransaction(saved.raw);
    const gas =
      prior?.gas ??
      (await sdk.transactionGas(
        this.ctx.publicClient,
        { account: wallet.account, to: tx.to, data: tx.data, value: 0n },
        sdk.stackGasSizing(this.ctx, tx.to, explicit),
      ));
    await this.reserve(key, gas);
    const sign = wallet.signTransaction.bind(wallet);
    const bounded = Object.assign(Object.create(Object.getPrototypeOf(wallet)), wallet, {
      signTransaction: async (request: Parameters<typeof sign>[0]) => {
        if (
          request.gas === undefined ||
          request.maxFeePerGas === undefined ||
          request.gas * request.maxFeePerGas >
            BigInt(this.reservations[`${this.run.runId}/${key}`]!)
        )
          throw new Error("P8_ACTUAL_TRANSACTION_BUDGET_REFUSED");
        return sign(request);
      },
    }) as sdk.Wallet;
    // Also inspect retained bytes; retries must not evade the run budget.
    if (saved !== undefined) {
      if (
        prior?.gas === undefined ||
        prior.maxFeePerGas === undefined ||
        prior.gas * prior.maxFeePerGas > BigInt(this.reservations[`${this.run.runId}/${key}`]!)
      )
        throw new Error("P8_RETAINED_TRANSACTION_BUDGET_REFUSED");
    }
    const receipt = await this.journal.send(key, bounded, tx);
    await this.finish(key, [receipt.transactionHash]);
    return receipt;
  }

  async balance(token: Address, address: Address, blockNumber?: bigint): Promise<bigint> {
    return this.ctx.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
      ...(blockNumber === undefined ? {} : { blockNumber }),
    });
  }

  summary() {
    const spent = this.receipts.reduce((sum, item) => sum + BigInt(item.costWei), 0n);
    return {
      capWei: CAP_WEI.toString(),
      spentWei: spent.toString(),
      spentMon: formatEther(spent),
      reservedWei: Object.values(this.reservations)
        .reduce((sum, cost) => sum + BigInt(cost), 0n)
        .toString(),
      accounting:
        "All relay receipts since run start and fixture wallet receipts include gas and successful native value, conservatively including unrelated relay traffic. ERC-20 rewards are separate.",
    };
  }
}
