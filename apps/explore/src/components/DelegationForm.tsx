import type { DirectoryAgent } from "@agent-jobs/sdk";
import { Link } from "@tanstack/react-router";
import type { Address } from "viem";
import { duration } from "../duration.ts";
import { factoryAmount } from "../stake.ts";
import { Address as AddressText, Button, ErrorText, Input, Section, Segmented } from "./ui.tsx";
import { factoryValue } from "./DelegationPositions.tsx";

export function DelegationForm({
  account,
  owner,
  agents,
  mode,
  text,
  wallet,
  active,
  cooldown,
  disabled,
  busy,
  error,
  onAccount,
  onMode,
  onText,
  onSubmit,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  account: Address;
  owner: Address;
  agents: DirectoryAgent[];
  mode: "add" | "leave";
  text: string;
  wallet: bigint | undefined;
  active: bigint | undefined;
  cooldown: number | undefined;
  disabled: boolean;
  busy: boolean;
  error: string | null;
  onAccount: (account: Address) => void;
  onMode: (mode: "add" | "leave") => void;
  onText: (text: string) => void;
  onSubmit: () => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const value = factoryAmount(text);
  const maximum = mode === "add" ? wallet : active;
  const invalid = text.trim() !== "" && value === null;
  const tooMuch = value !== null && maximum !== undefined && value > maximum;
  const known = agents.some((agent) => agent.wallet.toLowerCase() === account.toLowerCase());
  return (
    <Section title={mode === "add" ? "Delegate to an agent" : "Leave this position"}>
      <form
        className="grid gap-3 rounded-xl bg-surface p-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <label className="grid gap-1.5 text-sm">
          <span>Agent to back</span>
          <select
            aria-label="Agent to back"
            className="min-h-11 w-full rounded-xl bg-fill px-3 text-label"
            value={account}
            disabled={disabled || busy}
            onChange={(event) => onAccount(event.target.value as Address)}
          >
            <option value={owner}>My own wallet</option>
            {!known && account.toLowerCase() !== owner.toLowerCase() && (
              <option value={account}>{account}</option>
            )}
            {agents
              .filter((agent) => agent.wallet.toLowerCase() !== owner.toLowerCase())
              .map((agent) => (
                <option key={agent.agentId} value={agent.wallet}>
                  {agent.profile.name || `Agent #${agent.agentId}`} · #{agent.agentId}
                </option>
              ))}
          </select>
        </label>
        {hasMore && (
          <Button variant="gray" size="sm" busy={loadingMore} onClick={onLoadMore}>
            Load more agents
          </Button>
        )}
        <div className="grid gap-1 text-sm text-label-2">
          <span>
            Backing wallet <AddressText value={account} />
          </span>
          <span>
            Your position belongs to <AddressText value={owner} />. Only you can leave and withdraw
            it.
          </span>
        </div>
        <Segmented
          label="Add or leave"
          value={mode}
          onChange={onMode}
          options={[
            ["add", "Add backing"],
            ["leave", "Leave"],
          ]}
        />
        <label className="grid gap-1.5 text-sm">
          <span>Amount of FACTORY</span>
          <span className="flex gap-2">
            <Input
              id="stake-amount"
              inputMode="decimal"
              autoComplete="off"
              value={text}
              placeholder="0"
              onChange={(event) => onText(event.target.value)}
              className="min-w-0 flex-1 tabular"
            />
            <Button
              variant="gray"
              disabled={disabled || maximum === undefined}
              onClick={() => maximum !== undefined && onText(exactFactory(maximum))}
            >
              Max
            </Button>
          </span>
        </label>
        <p className="text-sm text-label-2">
          {mode === "add"
            ? "One permit signature lets the vault take exactly this amount. Then confirm the delegation in your wallet."
            : `Leaving starts ${cooldown === undefined ? "the vault cooldown" : `a ${duration(cooldown)} cooldown`} for all your queued shares, including any already leaving. Bonds do not prevent requesting to leave; they may delay withdrawal.`}
        </p>
        {invalid && (
          <ErrorText>Enter a positive FACTORY amount with up to 18 decimal places.</ErrorText>
        )}
        {tooMuch && (
          <ErrorText>
            {mode === "add"
              ? "That is more FACTORY than your wallet holds."
              : "That is more than your active position."}
          </ErrorText>
        )}
        {error !== null && <ErrorText>{error}</ErrorText>}
        <Button
          type="submit"
          size="lg"
          busy={busy}
          disabled={disabled || maximum === undefined || value === null || tooMuch}
        >
          {mode === "add" ? "Delegate" : "Leave"}
          {value === null ? "" : ` ${factoryValue(value)}`}
        </Button>
        <Link to="/workers" className="min-h-11 content-center text-sm text-tint">
          View the worker directory
        </Link>
      </form>
    </Section>
  );
}

export function exactFactory(value: bigint): string {
  const digits = value.toString().padStart(19, "0");
  const fraction = digits.slice(-18).replace(/0+$/, "");
  return `${digits.slice(0, -18)}${fraction === "" ? "" : `.${fraction}`}`;
}
