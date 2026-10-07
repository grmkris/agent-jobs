import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { type Hex } from "viem";
import { atomicHire } from "./atomic.ts";
import { limits } from "./limits.ts";
import { onboarding } from "./onboarding.ts";
import {
  IDS,
  ORIGIN,
  publicFailure,
  releaseAuthorization,
  required,
  type CaseId,
  sourceCommit,
} from "./guards.ts";
import { Runtime, type Proof } from "./runtime.ts";
import { worker } from "./worker.ts";
import { policyDenials } from "./policy.ts";
import { outage } from "./outage.ts";
import { restart } from "./restart.ts";
import { clients } from "./clients.ts";
import { RunState } from "./state.ts";

type Evidence = {
  id: CaseId;
  commit: string;
  release: string;
  network: "monad-testnet";
  chainId: 10143;
  fixture: true;
  result: "pass" | "blocked";
  checks: string[];
  txHashes: Hex[];
  gas: string[];
  spendMon: string;
  details?: Record<string, unknown>;
  error?: string;
  cleanupError?: string;
};
const evidenceDirectory = new URL(
  ORIGIN === "https://sidequest.exchange" ? "../../../../../docs/evidence/sidequest-prod/" : "../../../../../docs/evidence/agent-first-v2/",
  import.meta.url,
);
const scenarios: Record<CaseId, (runtime: Runtime) => Promise<Proof>> = {
  A01f: onboarding,
  A02f: worker,
  A03f: atomicHire,
  A04f: limits,
  A05f: policyDenials,
  A06f: outage,
  A07f: restart,
  A08f: clients,
};
// Revocation ends the real client connection. Run it after fresh-client and restart proofs.
const order: CaseId[] = ["A01f", "A02f", "A03f", "A04f", "A05f", "A07f", "A08f", "A06f"];

async function reportOperator(proof: Proof, harnessStatusFile: string): Promise<void> {
  const operator = proof.details.operator;
  if (typeof operator !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(operator))
    throw new Error("P8_VERIFIED_OPERATOR_MISSING");
  const note = `NOTE A01F-OPERATOR ${operator}`;
  const status = await readFile(harnessStatusFile, "utf8");
  if (!status.split("\n").includes(note)) await appendFile(harnessStatusFile, `${note}\n`);
}

async function main(): Promise<void> {
  const release = releaseAuthorization();
  const runId = required("P8_RUN_ID");
  const harnessStatusFile = required("P8_HARNESS_STATUS_FILE");
  // Fail before any browser or chain effect if the coordinator status file is unavailable.
  await readFile(harnessStatusFile, "utf8").catch(() => {
    throw new Error("P8_HARNESS_STATUS_UNAVAILABLE");
  });
  const selected = process.argv.slice(2);
  if (selected.some((item) => !IDS.includes(item as CaseId))) throw new Error("P8_UNKNOWN_CASE");
  const ids = selected.length === 0 ? order : order.filter((id) => selected.includes(id));
  const run = new RunState(runId, `${release}:${ORIGIN}`);
  run.freeze("run-id", runId);
  let runtime: Runtime | undefined;
  try {
    runtime = new Runtime(run);
    await runtime.chain.initialize();
    for (const id of ids) {
      const evidence: Evidence = {
        id,
        commit: sourceCommit(),
        release,
        network: "monad-testnet",
        chainId: 10143,
        fixture: true,
        result: "blocked",
        checks: [],
        txHashes: [],
        gas: [],
        spendMon: runtime.chain.summary().spentMon,
      };
      try {
        const proof = run.get<Proof>(`proof/${id}`) ?? (await scenarios[id](runtime));
        await runtime.chain.audit();
        run.set(`proof/${id}`, proof);
        if (id === "A01f") await reportOperator(proof, harnessStatusFile);
        evidence.result = "pass";
        evidence.checks = proof.checks;
        evidence.txHashes = [...new Set(proof.txHashes)];
        evidence.gas = evidence.txHashes.map(
          (hash) =>
            runtime!.chain.receipts.find((receipt) => receipt.txHash === hash)?.gasUsed ??
            "unavailable",
        );
        evidence.details = proof.details;
      } catch (error) {
        evidence.error = publicFailure(error);
        process.exitCode = 1;
        try {
          await runtime.chain.audit();
        } catch {
          /* Retain reservations and receipts; never resend to repair evidence. */
        }
        evidence.txHashes = runtime.chain.receipts.map((receipt) => receipt.txHash);
        evidence.gas = runtime.chain.receipts.map((receipt) => receipt.gasUsed);
      } finally {
        await runtime.close().catch((error: unknown) => {
          evidence.result = "blocked";
          const failure = publicFailure(error);
          evidence.cleanupError =
            failure === "P8_SCENARIO_FAILED_DETAILS_SUPPRESSED"
              ? "P8_BROWSER_CLEANUP_FAILED"
              : failure;
          process.exitCode = 1;
        });
      }
      evidence.spendMon = runtime.chain.summary().spentMon;
      await mkdir(evidenceDirectory, { recursive: true });
      await writeFile(
        new URL(`p8-${id}.json`, evidenceDirectory),
        `${JSON.stringify(evidence, null, 2)}\n`,
        { mode: 0o600 },
      );
      console.log(
        `${id} ${evidence.result.toUpperCase()} fixture${evidence.error === undefined ? "" : `: ${evidence.error}`}`,
      );
      if (evidence.cleanupError !== undefined) console.log(`cleanup: ${evidence.cleanupError}`);
      if (evidence.result !== "pass") break;
    }
    console.log(
      `fixture spend ${runtime.chain.summary().spentMon} MON; pending reservations ${runtime.chain.summary().reservedWei} wei`,
    );
  } finally {
    await runtime?.close().catch(() => {});
    run.close();
  }
}

if (import.meta.main) {
  await main().catch((error) => {
    console.error(publicFailure(error));
    process.exitCode = 1;
  });
}
