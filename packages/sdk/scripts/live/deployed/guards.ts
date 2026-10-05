import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseEther } from "viem";

export const ORIGIN = "https://testnet.hireling.xyz";
export const CAP_WEI = parseEther("2");
export const IDS = ["A01f", "A02f", "A03f", "A04f", "A05f", "A06f", "A07f", "A08f"] as const;
export type CaseId = (typeof IDS)[number];

export function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

export function sourceCommit(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

export function assertReleased(sha: string, status: string): void {
  if (!/^[0-9a-f]{40}$/.test(sha))
    throw new Error("P8_RELEASED_SHA must be the complete released commit");
  const released = status
    .split("\n")
    .some((line) => new RegExp(`^RELEASED ${sha}(?:\\s|$)`).test(line));
  if (!released) throw new Error("Claude has not recorded RELEASED for the selected commit");
}

export function releaseAuthorization(): string {
  const sha = required("P8_RELEASED_SHA");
  const file = required("P8_RELEASE_STATUS_FILE");
  assertReleased(sha, readFileSync(file, "utf8"));
  execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`]);
  return sha;
}

/** A reservation stays spent until every original send has a receipt. */
export function budgetRemaining(
  costs: readonly { costWei: string }[],
  reservations: Record<string, string>,
): bigint {
  if (
    [...costs.map((item) => item.costWei), ...Object.values(reservations)].some(
      (cost) => !/^(0|[1-9][0-9]*)$/.test(cost),
    )
  )
    throw new Error("P8_INVALID_BUDGET_LEDGER");
  const spent = costs.reduce((sum, item) => sum + BigInt(item.costWei), 0n);
  const pending = Object.values(reservations).reduce((sum, cost) => sum + BigInt(cost), 0n);
  if (spent < 0n || pending < 0n || spent + pending > CAP_WEI)
    throw new Error("2 MON fixture budget is exhausted");
  return CAP_WEI - spent - pending;
}

export function publicFailure(error: unknown): string {
  // Provider, Playwright and MCP errors can contain tokens, email, URLs or signatures.
  // Only our own short machine-stage codes enter evidence; raw errors stay unprinted.
  if (error instanceof Error && /^P8_[A-Z0-9_]+$/.test(error.message)) return error.message;
  return "P8_SCENARIO_FAILED_DETAILS_SUPPRESSED";
}
