# ADR-0010: Permissionless payment tokens

**V1 scope note (2 Oct):** permissionless rewards remain. `HirelingHolding` extends exact inflow and owed payouts to fees and top-ups, while FACTORY v2 stake reservations isolate bonds. A recorded deferred outcome is recovered, not reversed into a refund. The dated deployment statements below are legacy receipts; [ADR-0011](0011-hireling-v1.md) governs v1.

Date: 2026-09-29 (overnight). Status: **live on testnet** (`main` pair, job 60, `docs/reality-check.md`); `demo`
awaits a redeploy; mainnet unchanged until Kris decides.

## Context

Kris (Telegram, 29 Sep): "chomp was a token made by one of the users … potentially there would be 100 of these
tokens … no reason to whitelist tokens by admins … let agents decide." Until now the vendored ERC-8183 core refused a
budget in any token the admin had not allowlisted (`setPaymentTokenAllowed`), and the board accepted only the
config's `rewardTokens`. Every new community token needed an admin transaction and a config commit
(`$CHOMP`, 30 Sep).

## Decision

- **Any ERC-20 is a reward.** The core's allowlist is retired (a recorded patch of the vendored core, `SURFACE.md`;
  the storage slot stays so the testnet proxy upgrades in place). The board accepts any address that answers
  `decimals` and `symbol`. The config's `knownTokens` (and the faucet tokens) are only what the apps list first.
- **Agents decide.** A worker applies to a hire in the token it names, or quotes in the token it chooses; a quote
  request's `tokens` lists what the requester will pay in. Explore labels any token it does not know "unverified"
  with its address, and reads symbol and decimals from the chain. A tenant board may still restrict its own tokens:
  that is the board owner's policy, not the protocol's.
- **Escrow safety, since the token is now anyone's contract:**
  - *Fee-on-transfer:* the reward must arrive in full, at `JobHolding.publish` (`RewardTokenShortfall`) and at the
    core's `fund` (`UnexpectedFundedAmount`). A short token is refused before it can be made up from another
    listing's escrow.
  - *Transfer hooks and reentrancy:* every state-changing entry point of `JobHolding` and of the core is
    non-reentrant, and both follow checks-effects-interactions.
  - *Blocklists and pauses:* a reward the token refuses to send at `settle` is recorded as `owed` and withdrawn later
    with `withdraw(token)`; the bonds (FACTORY) settle regardless, so a token cannot hold them hostage. A paused token
    freezes its own jobs until it unpauses.
  - *Isolation:* escrow is pooled per token, so a hostile or broken token can only affect listings in that same token.
  - *Rebasing down:* the last listing in such a token can come up short. That risk belongs to whoever chose the
    token, and the "unverified" label says so.
  - FACTORY stays the only bond token; bonds never depend on the reward token.

## Consequences

- No admin step for a new token; the admin keeps pause and upgrade only.
- Testnet rollout (29 Sep): the core upgraded in place (`script/UpgradeCore.s.sol`), then the `main` pair redeployed
  with the hardened `JobHolding` (`script/DeployStacks.s.sol`, `STACKS=main`), marked `openTokens` in the config.
  Pairs without the mark (`demo` until it is redeployed, every legacy pair) take only known tokens through the board,
  because their Holding lacks the publish check and the owed-reward path. On-chain anyone can still call an old
  Holding directly, but the harm stays inside the token they chose.
- Mainnet needs the same patch in its first deploy (it has not been deployed), so the recipe carries no allowlist.
