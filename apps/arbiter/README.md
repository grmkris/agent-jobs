# Portable arbiter

Run from the repository root with the selected network config and private process
environment loaded:

```
NETWORK=monad-testnet bun apps/arbiter/src/main.ts --once
```

`V1_ARBITRATOR_PRIVATE_KEY` is required only when that network has a Sidequest v1
pair. `ARBITRATOR_PRIVATE_KEY` is required only when a current or archived legacy
pair remains. A mixed testnet deployment needs both keys; a testnet with only
legacy pairs needs only the legacy key. Mainnet with v1 only needs
`V1_ARBITRATOR_PRIVATE_KEY` and does not read the legacy secret.

The selected `NETWORK` deployment determines these requirements. Every loaded key
gets its own board session and handles only jobs naming that arbitrator. Model
configuration and `BOARD_URL` remain required as documented in `src/main.ts`.

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
`SIDEQUEST_PROD_MONAD_RPC_URL` on mainnet. A wrong RPC chain or missing configuration
refuses. Process secrets stay outside Workers. A mainnet invocation or funding
transfer requires the coordinator's explicit launch authorization.
