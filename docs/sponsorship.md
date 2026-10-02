# Gas sponsorship

Hireling v1 uses a root ERC-7710 delegation from the user's EIP-7702 DeleGator account to the configured relay.
The wallet signs its own delegation. The board holds only the operational relay key, never a user key.

The permission lasts 24 hours and allows at most 100 calls. Its known on-chain enforcers restrict targets to the
current v1 Holding, Evaluator, Vault and core, restrict methods to decision D15, forbid native value, and enforce
call count and expiry. It grants no permission to approve tokens, publish, top up, stake, request unstaking,
change a Holding veto, change a payout receiver, or perform owner, arbitrator or verifier actions.

Within the permitted methods, a compromised relay could still accept, reject, dispute, cancel or settle jobs as the
user until the delegation expires or the user disables it on-chain. The wallet reviews the actual typed-data
limits before signing. `sponsor_revoke` stops board sends immediately and returns `disableDelegation`; until
that transaction is mined, the signed permission remains usable on-chain.

REST and MCP share the same tools. `sponsor_submit({wallet,key,calls})` accepts 1–4 ordered zero-value calls.
The client creates and persists one key per action, and reuses it only for retries. Reusing the key with different
calls refuses; another key can represent a legitimate identical action. The result is
`{operationId,status: "pending"|"confirmed"|"reverted",txHash,callsUsed}`.
Poll `sponsor_operation({wallet,operationId})` to read the receipt and counter without sending anything.
An original submission retry reconciles the saved hash, counter baseline and relay nonce before it can rebroadcast
the identical persisted signed bytes. It never creates another transaction for that action.

One reserved object in the existing Board binding stores grants and operation records for all boards. Before
broadcast, it validates canonical calldata against D15, simulates the whole redemption, reserves caps, and persists
its signed bytes and hash. An unresolved operation blocks another sponsored nonce. Per wallet it allows 20 calls
per rolling hour. The relay's daily budget is 10 MON: mined charges are `gasUsed * effectiveGasPrice` from receipts,
and unresolved sends reserve their worst-case cost. Gas uses summed ADR-0011 floors plus overhead, raised when
estimation needs more, with a 6M transaction cap.

`RELAY_FLOOR_MAINNET` is defined once in `packages/sdk/src/relay.ts` (2 MON in native wei). A sponsored send must
leave at least that balance after its maximum gas cost. The production live launch gate uses the same constant.

Implementation has unit, local workerd admission and real local Monad fork tests. It is not a live sponsorship
claim: enabling and redeeming against a deployed v1 pair remains part of the coordinator's testnet flow gate.
