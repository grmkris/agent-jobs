import { Link } from "@tanstack/react-router";
import type { Address } from "viem";
import { useIndexedBacking } from "../delegation-query.ts";
import { percent } from "../stake.ts";
import { hireling } from "../hireling.ts";
import { DELEGATION_RISK, factoryValue } from "./DelegationPositions.tsx";
import { Countdown, useNow } from "./Time.tsx";
import { Address as AddressText, Group, ListRow, LoadingRows, ErrorText, Section } from "./ui.tsx";

export function AgentBacking({ wallet, viewer }: { wallet: Address; viewer: Address | undefined }) {
  const read = useIndexedBacking(wallet, viewer);
  const now = useNow();
  if (hireling === null) return null;
  const snapshot = read.data;
  return (
    <Section
      title="Backing"
      note="The fee tier counts active backing, including reserved bonds. Leaving positions stop counting immediately and remain exposed to slashes."
    >
      {read.isPending ? (
        <LoadingRows rows={3} />
      ) : read.isError || snapshot === undefined ? (
        <ErrorText>This agent&apos;s backing index is unavailable right now.</ErrorText>
      ) : (
        <>
          <Group>
            <ListRow>
              <span className="flex-1">Total backing</span>
              <span className="tabular font-semibold">{factoryValue(snapshot.backing.assets)}</span>
            </ListRow>
            <ListRow>
              <span className="flex-1">Active backing</span>
              <span className="tabular">{factoryValue(snapshot.backing.active)}</span>
            </ListRow>
            <ListRow>
              <span className="flex-1">Reserved by live jobs</span>
              <span className="tabular">{factoryValue(snapshot.backing.reserved)}</span>
            </ListRow>
            <ListRow>
              <span className="flex-1">Available for new bonds</span>
              <span className="tabular">{factoryValue(snapshot.backing.available)}</span>
            </ListRow>
            <ListRow>
              <span className="flex-1">Leaving</span>
              <span className="tabular">{factoryValue(snapshot.backing.queued)}</span>
            </ListRow>
            <ListRow>
              <span className="flex-1">Delegators</span>
              <span className="tabular">{snapshot.delegatorCount}</span>
            </ListRow>
            <ListRow>
              <span className="flex-1">Worker fee</span>
              <span className="tabular">{percent(snapshot.backing.tier.feeBps)}</span>
            </ListRow>
            <ListRow>
              <span className="flex-1">Next fee tier</span>
              <span className="tabular text-right">
                {snapshot.backing.tier.nextThreshold === null
                  ? "Lowest fee reached"
                  : `${factoryValue(snapshot.backing.tier.needed)} more to pay ${percent(snapshot.backing.tier.nextFeeBps!)}`}
              </span>
            </ListRow>
          </Group>
          {snapshot.topDelegators.length > 0 && (
            <Section title="Top delegators" className="mt-3">
              <Group>
                {snapshot.topDelegators.map((position) => (
                  <ListRow key={position.delegator}>
                    <AddressText value={position.delegator} />
                    <span className="tabular ml-auto text-right">
                      {factoryValue(position.value)}
                      <span className="block text-xs text-label-2">
                        {percent(position.shareBps)} of backing
                      </span>
                    </span>
                  </ListRow>
                ))}
              </Group>
            </Section>
          )}
          {snapshot.position !== null && (
            <div className="mt-2 grid gap-1 rounded-xl bg-tint/10 p-4">
              <p className="text-sm font-semibold">Your position</p>
              <p className="tabular text-lg font-semibold">
                {factoryValue(snapshot.position.value)} · {percent(snapshot.position.shareBps)}
              </p>
              {snapshot.position.queuedShares > 0n && (
                <p className="text-sm text-label-2">
                  {factoryValue(snapshot.position.queued)} leaving ·{" "}
                  {snapshot.position.unlockAt > now ? (
                    <Countdown to={snapshot.position.unlockAt} />
                  ) : snapshot.backing.assets - snapshot.position.queued <
                    snapshot.backing.reserved ? (
                    "Waiting for bonds to clear"
                  ) : (
                    "Ready to withdraw"
                  )}
                </p>
              )}
            </div>
          )}
          <p className="mt-3 text-sm leading-relaxed text-label-2">{DELEGATION_RISK}</p>
          <Link
            to="/stake"
            search={{ account: wallet }}
            className="mt-2 inline-flex min-h-11 items-center justify-center rounded-xl bg-tint/14 px-4 font-semibold text-tint"
          >
            Delegate
          </Link>
        </>
      )}
    </Section>
  );
}
