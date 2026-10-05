import type * as sdk from "@agent-jobs/sdk";
import { Address, Group, ListRow } from "./ui.tsx";

export function AgentGrantReview({
  description,
}: {
  description: ReturnType<typeof sdk.describeGrant>;
}) {
  return (
    <div className="grid gap-3">
      <p className="text-sm leading-relaxed text-label-2">
        Review the permission before your wallet signs. It expires on{" "}
        {new Date(description.expiresAt * 1000).toLocaleString()}.
      </p>
      <Group>
        <ListRow>
          <span className="flex-1">From your wallet</span>
          <Address value={description.delegator} />
        </ListRow>
        <ListRow>
          <span className="flex-1">Granted to</span>
          <Address value={description.delegate} />
        </ListRow>
        {description.recipient !== null && (
          <ListRow>
            <span className="flex-1">Pinned recipient or spender</span>
            <Address value={description.recipient} />
          </ListRow>
        )}
        {description.token !== null && (
          <ListRow>
            <span className="flex-1">Token</span>
            <Address value={description.token} />
          </ListRow>
        )}
        {description.amount !== null && (
          <ListRow>
            <span className="flex-1">Maximum in base units</span>
            <span className="max-w-[60%] break-all font-mono text-xs">{description.amount}</span>
          </ListRow>
        )}
        <ListRow>
          <span className="flex-1">Native value</span>
          <span>{description.nativeValue} MON</span>
        </ListRow>
        <ListRow>
          <span className="flex-1">Calls</span>
          <span>{description.calls ?? "Limited by the spending cap"}</span>
        </ListRow>
        {description.periodSeconds !== null && (
          <ListRow>
            <span className="flex-1">Fixed period</span>
            <span>7 days from {new Date(description.validAfter * 1000).toLocaleString()}</span>
          </ListRow>
        )}
      </Group>
      <details className="rounded-xl border border-sep p-3 text-sm">
        <summary className="min-h-8 cursor-pointer font-medium">
          Allowed contracts and methods
        </summary>
        <div className="mt-2 grid gap-3">
          {description.targets.map((target) => (
            <div key={target.address} className="grid gap-1">
              <Address value={target.address} />
              <p className="break-words text-xs text-label-2">{target.methods.join(", ")}</p>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
