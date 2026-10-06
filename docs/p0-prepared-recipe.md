# Prepared Monad 143 recipe — not a launch authorization

The committed `contracts/config/monad-mainnet.json` and `Recipe.sol` are the proposed
recipe: chain 143, real configured registries and USDC, SIDE with no faucet,
zero hold gates, one main stack, and zero platform/evaluator fees. The deployment
object is intentionally empty. No deployment addresses, wallet keys, or production
resources were invented or created for preparation.

The first deployment writer now records `openTokens: true` for every newly deployed
Holding/evaluator pair. Existing testnet main metadata is already true; older
testnet pairs remain closed. Do not mark a legacy pair open just because a new
core implementation is open: the Holding bytecode also matters.

Run the unit tests and the mainnet fork rehearsal with a read-only RPC. Fork-only
account/signature fixtures are deterministic test identities, not deployable wallet
key generation. No command here sends to mainnet. Deploy/broadcast commands in
the mainnet runbook remain behind Kris's separate go, and custody, audit risk,
gas budget, funding ceilings, and final domain/Privy/secret mappings remain pending.
