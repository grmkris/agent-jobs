# Agent wallet compatibility matrix (spike S3, 2026-09-25)

What a worker needs to participate (spec §7): sign a SIWE message for the board's wallet sign-in,
send one Monad testnet transaction (`setBudget` to accept, `submit` to finalize) **or** sign the
EIP-712 authorization the relay submits for it, register once on ERC-8004, and call the board's remote
MCP with a bearer header (a harness concern, not a wallet one). Coding harnesses (Claude Code, Codex,
Grok Build) hold no keys; every row is a wallet tool the harness drives.

"tested" = exercised today, "documented" = read in the vendor's docs on the date shown, "unclear" = the
docs do not say. Chain 10143 = Monad testnet.

| Wallet | SIWE / EIP-191 sign | EIP-712 sign | Raw tx on 10143 | ERC-8004 `register` path | Policies / limits | Verdict for the demo |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Foundry `cast`** (plain EOA on the worker's machine) | **tested** `cast wallet sign` + `cast wallet verify` | **tested** `cast wallet sign --data --from-file` (SetBudgetAuthorization) | **tested** `cast send` on anvil; Monad is any-RPC | direct tx `cast send <identity> "register()"` | none (the key is the policy) | **Demo path 1.** Zero integration cost. |
| **MetaMask Agent Wallet** (`mm` CLI + agent skills) | documented 2026-09-25: `mm wallet sign-message --message … --chain-id 10143` | documented: `mm wallet sign-typed-data --chain-id 10143 --payload '<domain,types,primaryType,message>'` | documented: `mm wallet send-transaction --chain-id 10143 --payload '{to,data,value}'`; **Monad testnet 10143 is in the supported-chains table** (Monad 143 too, "Covered" by Transaction Shield) | direct tx via `send-transaction` | Guard/Beast trading modes, 2FA approval, outflow limits; mandatory simulation + Blockaid scan on every tx | **Demo path 2.** Integration cost: install the CLI and skills on the worker machine, sign in, fund with testnet MON. The skill wraps three `mm` commands. Untested until B2. Closes spec §11. |
| **Privy server wallet** | documented: wallet RPC `personal_sign` (policy source `personal_sign` exists) | documented: `eth_signTypedData_v4` (policy sources `ethereum_typed_data_domain` / `_message`) | documented: `POST /v1/wallets/<id>/rpc` with `method: eth_sendTransaction`, `caip2: "eip155:<id>"`; embedded wallets support any EVM chain via `defineChain` (Monad named in the docs); **server-wallet support for 10143 not stated** | direct tx, or relay | rich: chain allowlists, `to`, ABI-decoded function + args, value caps, cumulative windows, typed-data domain | **Demo path 3** (and the arbitrator agent). Verify `eip155:10143` on a server wallet first thing in B2; fall back to the relay (typed-data sign only) if raw sends are refused. |
| **Turnkey** | documented: "sign any payload" (raw payload activity; name not on the agent page) | unclear (not named on the agent page) | documented: `ACTIVITY_TYPE_SIGN_TRANSACTION_V2` / `ETH_SEND_TRANSACTION`, policies can pin `eth.tx.chain_id`; broadcasting is yours unless enterprise | direct tx | default-deny policy engine: wallet scope, `eth.tx.to` allowlist, value caps, function selectors / ABI, multi-party consensus; agent provisioning skill, docs MCP | documented only. Good fit later; not for the demo. |
| **Coinbase CDP server wallets / AgentKit** | documented (overview): message signing exists | unclear (README not reachable today) | documented: "all EVM-compatible networks"; unlisted chain via sign-and-broadcast-yourself is **unclear** | unclear | "policy-enforced spending limits" for agents | documented only. Confirm 10143 before promising. |
| **Crossmint agent wallets** (ERC-4337 smart wallets, TEE agent signer) | documented: message signing on `EVMWallet` | documented: EIP-712 on `EVMWallet` | **allowlist of chains, Monad not listed**; adding a chain is vendor-side | smart-wallet tx | on-chain policies: per-tx limits, rolling caps, recipient allowlists | not usable on Monad without the vendor. |
| **thirdweb server wallets** (Vault + Engine v3) | documented: `POST /sign/personal` | documented: `POST /sign/typedData` | documented: any EVM chain; custom chain override by id + RPC | direct tx | Vault access-token policies (`eoa:sign*`) | documented only. Viable alternative to Privy if needed. |

## What this changes in the spec

- §11 "MetaMask agent wallet: integration cost / direct or relay" is answered: native 10143 support,
  direct transactions, low cost. It stays second in the cut order only because it is untested.
- The relay (`setBudgetWithAuthorization` / `submitWithAuthorization`) is what makes a
  typed-data-only wallet sufficient; every row above can at least sign typed data or a raw payload.
- SIWE for the board sign-in needs only EIP-191; every row has it.

## Not covered

Harness-side MCP bearer support was verified for Claude Code and Codex in the Cloudflare OS Dispatch
spike (2026-09-25); Grok Build reads Claude Code's MCP configuration. ERC-1271 sign-in for contract
wallets (Crossmint) is not exercised anywhere yet.

Sources read 2026-09-25: docs.metamask.io/agent-wallet (index, supported-chains, sign-messages-and-transactions);
docs.privy.io (wallets/overview, overview/chains, configuring-evm-networks, ethereum/send-a-transaction,
controls/policies/overview); docs.turnkey.com (concepts/overview, agentic-wallets); docs.cdp.coinbase.com
(server-wallets/v2 welcome); crossmint.com docs and SDK PR #2061; portal.thirdweb.com (server wallets,
engine v3, custom chains, vault signing).
