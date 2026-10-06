import { useState } from "react";
import { type Address, parseUnits } from "viem";
import { useSignTypedData } from "wagmi";
import { agentEndpoint, type ManagedAgent } from "../../api.ts";
import type { AgentApproval } from "../../agent-api.ts";
import { amount, localTime, relative, tokenInfo } from "../../format.ts";
import {
  expectedPermission,
  permissionRequest,
  reviewPermission,
  type PreparedPermission,
} from "../../permission-review.ts";
import { typedDataArgs } from "../../typed-data.ts";
import { useTokenList } from "../../useTokens.ts";
import { deployment } from "../../wallet.ts";
import { Badge, Button, ErrorText, Field, Input, Section } from "../ui.tsx";

const TYPE_WORDS: Record<string, string> = {
  "erc20-token-periodic": "Recurring token payments",
  "erc20-token-allowance": "One token allowance",
  "hireling:contract-call": "One exact contract call",
};

/**
 * A permission a managed agent asked for (ERC-7715 envelope, ADR-0015 draft). The operator may shorten the expiry or
 * lower the amount when the agent allowed it, reviews the template the server prepared against its own rebuild, and
 * signs the exact operator → agent delegation. Telegram links here; it never approves.
 */
export function PermissionApproval({
  approval,
  agent,
  operator,
  refresh,
}: {
  approval: AgentApproval;
  agent: ManagedAgent;
  operator: Address;
  refresh: () => Promise<unknown>;
}) {
  const request = permissionRequest(approval.request_json);
  const t = request.parsed;
  const token = t.type === "hireling:contract-call" ? null : t.token;
  useTokenList(token === null ? [] : [token]);
  const { signTypedDataAsync } = useSignTypedData();
  const [limit, setLimit] = useState("");
  const [days, setDays] = useState("");
  const [standing, setStanding] = useState(request.standing);
  const [review, setReview] = useState<ReturnType<typeof reviewPermission> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requested = t.type === "erc20-token-periodic" ? t.periodAmount : t.type === "erc20-token-allowance" ? t.amount : null;
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Decision is unavailable; retry");
    } finally {
      setBusy(false);
    }
  }
  /** The operator's adjustment in base units and unix seconds; empty fields keep the agent's request. */
  function adjustment(): { expiry?: number; amount?: bigint } {
    const lower = limit.trim() === "" || token === null ? undefined : parseUnits(limit.trim(), tokenInfo(token).decimals);
    const shorter = days.trim() === "" ? undefined : Math.floor(Date.now() / 1000) + Math.round(Number(days) * 86_400);
    if (shorter !== undefined && !Number.isFinite(shorter)) throw new Error("Days must be a number");
    return { ...(lower === undefined ? {} : { amount: lower }), ...(shorter === undefined ? {} : { expiry: Math.min(shorter, request.expiry) }) };
  }
  async function prepare() {
    if (agent.address === null) throw new Error("This agent has no wallet yet");
    const adjust = adjustment();
    // Rebuild what this card agreed to before asking the server; a wider choice is refused here too.
    const final = expectedPermission(request, adjust);
    const prepared = await agentEndpoint<PreparedPermission>(`/api/approvals/${approval.id}/prepare`, "POST", {
      ...(adjust.expiry === undefined ? {} : { expiry: adjust.expiry }),
      ...(adjust.amount === undefined ? {} : { amount: adjust.amount.toString() }),
    });
    const adjusted = final.expiry !== request.expiry || adjust.amount !== undefined && adjust.amount !== requested;
    setReview(reviewPermission(deployment, prepared, { operator, agent: agent.address as Address, terms: final.terms, expiry: final.expiry, adjusted }));
  }
  async function decide(approved: boolean) {
    let body: Record<string, unknown> = { approved };
    if (approved) {
      if (review === null) throw new Error("Review the exact permission first");
      const signature = await signTypedDataAsync(typedDataArgs(review.typedData));
      body = { approved, signature, hash: review.hash, standing };
    }
    await agentEndpoint(`/api/approvals/${approval.id}/decide`, "POST", body);
    setReview(null);
  }

  const shown = review?.description;
  return (
    <Section title={`${agent.name} · Permission request`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xl font-semibold">{TYPE_WORDS[t.type] ?? t.type}</p>
        <Badge tone={approval.status === "pending" ? "warning" : "neutral"}>{approval.status}</Badge>
      </div>
      <p className="text-sm leading-relaxed text-label-2">
        {t.type === "hireling:contract-call"
          ? `Your account makes this one call, once: ${t.callData.slice(0, 10)} on ${t.target}${t.value > 0n ? `, sending ${t.value.toString()} wei` : ""}.`
          : `Up to ${amount(shown !== undefined && "amount" in shown ? shown.amount : requested!.toString(), token)}${t.type === "erc20-token-periodic" ? ` every ${Math.round(t.periodDuration / 3600)} h` : " in total"} from your wallet, only to ${t.recipient}.`}{" "}
        It ends {localTime(shown?.expiresAt ?? request.expiry)} ({relative(shown?.expiresAt ?? request.expiry)}). The chain enforces every limit.
      </p>
      {request.justification !== null && (
        <p className="break-words text-sm text-label-2">Agent's reason (its own words): {request.justification}</p>
      )}
      <p className="break-all font-mono text-micro text-label-3">Operation {approval.operation_id}</p>
      {approval.status === "pending" && review === null && request.adjustable && (
        <div className="grid gap-3 sm:grid-cols-2">
          {token !== null && (
            <Field label={`Lower the amount (${tokenInfo(token).symbol})`} hint="Empty keeps the request; you can only lower it.">
              <Input inputMode="decimal" value={limit} onChange={(event) => setLimit(event.target.value)} />
            </Field>
          )}
          <Field label="End sooner (days from now)" hint="Empty keeps the requested end.">
            <Input inputMode="decimal" value={days} onChange={(event) => setDays(event.target.value)} />
          </Field>
        </div>
      )}
      {approval.status === "pending" && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={standing} onChange={(event) => setStanding(event.target.checked)} />
          Grant as a standing rule: later requests it covers are granted without asking you.
        </label>
      )}
      {review !== null && review.risks.length > 0 && (
        <ul className="grid gap-1 text-sm">
          {review.risks.map((risk) => (
            <li key={risk.code}>
              <Badge tone={risk.level === "high" ? "danger" : risk.level === "medium" ? "warning" : "neutral"}>{risk.level}</Badge> {risk.message}
            </li>
          ))}
        </ul>
      )}
      {approval.status === "pending" && (
        <div className="flex flex-wrap gap-2">
          <Button busy={busy} onClick={() => void run(review === null ? prepare : () => decide(true))}>
            {review === null ? "Review permission" : "Sign and grant permission"}
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => void run(() => decide(false))}>
            Reject
          </Button>
        </div>
      )}
      {error !== null && <ErrorText>{error}</ErrorText>}
    </Section>
  );
}
