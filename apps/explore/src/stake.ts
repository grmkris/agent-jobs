/**
 * Shared FACTORY input, percentage and proposal-time helpers. Backing and position arithmetic lives in the SDK.
 */
import { parseUnits } from "viem";

/** "10 %", "2.5 %": a rate in basis points. */
export const percent = (bps: number) =>
  `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })} %`;

/** A FACTORY amount typed by a person, in wei; null when it is not a positive amount with at most 18 decimals. */
export function factoryAmount(text: string): bigint | null {
  const t = text.trim();
  if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return null;
  const [, frac = ""] = t.split(".");
  if (frac.length > 18) return null;
  const wei = parseUnits(t, 18);
  return wei > 0n ? wei : null;
}

/**
 * A timelocked proposal (a fee schedule, a Holding): still waiting for its eta, executable for `grace` seconds after
 * it (the contract's own `PROPOSAL_GRACE()`), then expired and refused by the contract.
 */
export function proposalState(
  eta: number,
  now: number,
  grace: number,
): "waiting" | "open" | "expired" {
  if (now < eta) return "waiting";
  return now > eta + grace ? "expired" : "open";
}
