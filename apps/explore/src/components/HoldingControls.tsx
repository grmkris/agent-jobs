/** Holding vetoes belong to the account itself, never to an external delegator. */
import * as sdk from "@agent-jobs/sdk";
import { type Address, zeroAddress } from "viem";
import { useReadContracts } from "wagmi";
import { type HirelingContracts } from "../hireling.ts";
import { proposalState } from "../stake.ts";
import { chain } from "../wallet.ts";
import { Countdown, When, useNow } from "./Time.tsx";
import {
  Address as AddressText,
  Badge,
  Button,
  ErrorText,
  Group,
  ListRow,
  Section,
} from "./ui.tsx";

export function HoldingControls({
  contracts,
  account,
  disabled,
  onVeto,
}: {
  contracts: HirelingContracts;
  account: Address;
  disabled: boolean;
  onVeto: (holding: Address, denied: boolean) => void;
}) {
  const now = useNow();
  const reads = useReadContracts({
    contracts: [
      {
        address: contracts.vault,
        abi: sdk.stakeVaultAbi,
        functionName: "pendingHolding",
        chainId: chain.id,
      },
      {
        address: contracts.vault,
        abi: sdk.stakeVaultAbi,
        functionName: "holdingDenied",
        args: [account, contracts.holding],
        chainId: chain.id,
      },
      {
        address: contracts.vault,
        abi: sdk.stakeVaultAbi,
        functionName: "PROPOSAL_GRACE",
        chainId: chain.id,
      },
    ],
    query: { refetchInterval: 15_000 },
  });
  const pending = reads.data?.[0]?.status === "success" ? reads.data[0].result : undefined;
  const denied = reads.data?.[1]?.status === "success" ? reads.data[1].result : undefined;
  const grace = reads.data?.[2]?.status === "success" ? Number(reads.data[2].result) : undefined;
  const holding = pending?.[0] ?? zeroAddress;
  const proposal = holding.toLowerCase() !== zeroAddress;
  const veto = useReadContracts({
    contracts: [
      {
        address: contracts.vault,
        abi: sdk.stakeVaultAbi,
        functionName: "holdingDenied",
        args: [account, holding],
        chainId: chain.id,
      },
    ],
    query: { enabled: proposal, refetchInterval: 15_000 },
  });
  const refused = veto.data?.[0]?.status === "success" ? veto.data[0].result : undefined;
  const state = proposalState(Number(pending?.[1] ?? 0), now, grace ?? Number.POSITIVE_INFINITY);
  return (
    <>
      {proposal && (
        <Section
          title="A new Holding is proposed"
          note="This veto controls your own wallet's backing. An external delegator cannot change an agent's Holding permissions."
        >
          <Group className="grid gap-3 p-4">
            <ListRow>
              <span className="flex-1">Holding</span>
              <AddressText value={holding} />
            </ListRow>
            <p className="text-sm text-label-2">
              {state === "waiting" ? (
                <>
                  Can go live in <Countdown to={Number(pending![1])} />
                </>
              ) : state === "open" ? (
                "Can go live now, once accepted"
              ) : (
                "Proposal expired"
              )}
            </p>
            <p className="text-sm text-label-2">
              Expires{" "}
              {grace === undefined ? (
                "at an unreadable time"
              ) : (
                <When at={Number(pending![1]) + grace} show="time" />
              )}
            </p>
            {refused === true ? (
              <Badge tone="danger">Refused</Badge>
            ) : (
              <p className="text-sm text-label-2">
                A Holding you refuse can never reserve this account's backing.
              </p>
            )}
            {state !== "expired" && (
              <Button
                variant="tinted"
                disabled={disabled || reads.isError || veto.isError || refused === undefined}
                onClick={() => onVeto(holding, !refused)}
              >
                {refused ? "Allow it again" : "Refuse this Holding"}
              </Button>
            )}
          </Group>
        </Section>
      )}
      {denied === true && (
        <Section title="You refused the Holding in use">
          <Group className="grid gap-3 p-4">
            <p className="text-sm text-label-2">
              It cannot reserve this wallet's backing for new job bonds.
            </p>
            <Button
              variant="tinted"
              disabled={disabled || reads.isError}
              onClick={() => onVeto(contracts.holding, false)}
            >
              Allow it again
            </Button>
          </Group>
        </Section>
      )}
      {reads.isError && (
        <ErrorText>Holding permissions could not be read. Veto actions are unavailable.</ErrorText>
      )}
    </>
  );
}
