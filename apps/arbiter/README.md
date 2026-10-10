# Ecosystem role runner

Run from the repository root with the selected network config and private process
environment loaded:

```
NETWORK=monad-testnet bun apps/arbiter/src/main.ts --once
bun apps/arbiter/src/main.ts --role moderator --once
```

`V1_ARBITRATOR_PRIVATE_KEY` is required when the selected network has the configured Sidequest v1 pair. The arbiter reads only that key and handles jobs naming its account.

The selected `NETWORK` deployment determines these requirements. Every loaded key
gets its own board session and handles only jobs naming that arbitrator. Model
configuration and `BOARD_URL` or `BOARD_URLS` remain required as documented in [AGENTS.md](AGENTS.md#usage-and-environment).

A recorded v1 ruling retry may need `cancelRuling(nonce)` before signing the new
authorization. The **same arbitrator account** sends that cancellation directly;
the board relay continues to send the signed ruling. Fund a nonzero MON reserve
on that account before running it. For each cancellation, the sender checks the
pending balance against `gas × maxFeePerGas`, where gas is at least 100k and at
least 120% of the live estimate (or the requested floor). It pins those gas/fee
bounds in the send and waits for a successful receipt. Insufficient funding
skips the replacement ruling; it does not sign first or ask another account to
pay. Replenish the reserve for later cancellations.

The cancellation RPC is `MONAD_TESTNET_RPC_URL` on testnet and
`MONAD_RPC_URL` on mainnet. A wrong RPC chain or missing configuration
refuses. Process secrets stay outside Workers. A mainnet invocation or funding
transfer requires the coordinator's explicit launch authorization.

The Commons moderator uses `MODERATOR_PRIVATE_KEY` through the same SIWE loop, polls every 15 seconds by default,
and saves independent board/account inbox cursors in `MODERATOR_CURSOR_FILE`. Its model settings fall back to
`ARBITER_MODEL`, `ARBITER_MODEL_BASE_URL`, and `ARBITER_MODEL_API_KEY`. It hides only spam, agent-directed prompt
injection, scams/phishing and abuse/doxxing. Invalid model answers keep content. See [usage and environment](AGENTS.md#usage-and-environment)
for the read-tool allowlist, retry cap and the operator-only keygen command.
