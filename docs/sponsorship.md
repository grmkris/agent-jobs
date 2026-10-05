# Gas sponsorship

Hireling v1 uses a root ERC-7710 delegation from the user's EIP-7702 DeleGator account to the configured relay.
The wallet signs its own delegation. The board holds only the operational relay key, never a user key.

The permission lasts 24 hours and allows at most 100 calls. Its known on-chain enforcers restrict targets to the
current v1 Holding, Evaluator, Vault and core, restrict methods to decision D15, forbid native value, and enforce
call count and expiry. It grants no permission to approve tokens, publish, top up, stake, request unstaking,
change a Holding veto, change a payout receiver, or perform owner, arbitrator or verifier actions.

Managed-agent publishing is a separate allowance-funded exception. The operator
signs a token allowance with a fixed-period spending cap and expiry. Within that
cap the relay atomically redeems the exact reward, approves Holding under B2 and
publishes under B1. A failed publish reverts the pull and approval. Over-limit or
unknown-token hires wait in Approvals for an operator-signed exact one-off
allowance. For an unknown token, only after verifying that decision may the routine
signer sign agent-approve-once: that token, Holding spender, exact calldata, one
call and ten-minute expiry.

Agent B1 covers D15 plus publish and delegation redemption/disable; B2 approves
known reward tokens to Holding (FACTORY is excluded); B3 transfers configured
tokens, including FACTORY, only to the operator. The browser always uses the
operator wallet. Emergency recovery signs a fresh short-lived agent grant to the
operator without switching wagmi, and the operator pays to redeem it. These
authorities and the executor's checks are recorded in [ADR-0013](decisions/0013-agent-authority.md).

Within the permitted methods, a compromised relay could still accept, reject, dispute, cancel or settle jobs as the
user until the delegation expires or the user disables it on-chain. The wallet reviews the actual typed-data
limits before signing. `sponsor_revoke` stops board sends immediately and returns `disableDelegation`; until
that transaction is mined, the signed permission remains usable on-chain.

REST tools return unsigned output for self-custody wallets; hosted OAuth MCP runs the managed-agent executor.
`sponsor_submit({wallet,key,calls})` accepts up to 8 ordered zero-value calls. The internal desk validates each
grant entry, counts calls per entry and decodes nested allowance redemption against the publish token and reward.
The client creates and persists one key per action, and reuses it only for retries. An existing key always reconciles the original
operation before any policy or grant check, even if replacement calls differ. Another key can represent a new action. The result is
`{operationId,status: "pending"|"confirmed"|"reverted"|"dropped",txHash,callsUsed}`.
Poll `sponsor_operation({wallet,operationId})` to read the receipt and counter without sending anything.
An original submission retry reconciles the saved hash, counter baseline and relay nonce before it can rebroadcast
the identical persisted signed bytes. It never creates another transaction for that action.

Every relay sender recovers pending rows in both ledgers before allocating another nonce. A crash before broadcast
replays the exact saved bytes while the grant is live. If the grant was revoked, replaced or expired, recovery
persists a zero-value relay self-send at the same nonce with increased fees before broadcasting it. If the original
mines first, its receipt confirms or reverts the action. If the replacement mines first, the original becomes
`dropped`; its `txHash` remains the original hash. Polling never broadcasts. Replacement gas is charged from its
receipt toward the same daily cap. Its 100k gas limit uses the original operation's reservation, bounding the
fee cap within that reservation when current fees and the replacement bump permit. Recovery still sends if
fees have risen beyond it, even when the daily cap is full: the receipt's overshoot counts against that day,
so further sponsorships refuse until the budget is available again. Fresh operations can proceed only once the nonce is reconciled.

The reserved management object `__hosted_sponsor_v1__` in the existing Board binding stores grants and operation records for all boards. Before
broadcast, it validates canonical calldata against D15, simulates the whole redemption, reserves caps, and persists
its signed bytes and hash. An unresolved operation blocks another sponsored nonce. Limits are keyed by the operator:
20 calls per rolling hour and 100 publishes per day. The relay's daily budget is 10 MON: mined charges are `gasUsed * effectiveGasPrice` from receipts,
and unresolved sends reserve their worst-case cost. Gas uses summed ADR-0011 floors plus overhead, raised when
estimation needs more, with a 6M transaction cap.

`RELAY_FLOOR_MAINNET` is defined once in `packages/sdk/src/relay.ts` (2 MON in native wei). A sponsored send must
leave at least the network's balance floor after its maximum gas cost. Normal sends and nonce recovery share
`sponsorRelayFloor` in `packages/board/src/sponsor-policy.ts`; current policy is 2 MON on both networks, so G1
also needs that testnet buffer. The production live launch gate uses the SDK mainnet constant.

Implementation has unit, local workerd admission and real local Monad fork tests. It is not a live sponsorship
claim: enabling and redeeming against a deployed v1 pair remains part of the coordinator's testnet flow gate.
