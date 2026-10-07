# ADR-0010: Permissionless payment tokens

**V1 scope note (2 Oct):** permissionless rewards remain. `SidequestHolding` extends exact inflow and owed payouts to fees and top-ups, while SIDE v2 stake reservations isolate bonds. A recorded deferred outcome is recovered, not reversed into a refund. [ADR-0011](0011-sidequest-v1.md) governs v1.

Date: 2026-09-29. Status: implemented; current live evidence is in [reality-check.md](../reality-check.md).

## Context

Kris (Telegram, 29 Sep): "chomp was a token made by one of the users … potentially there would be 100 of these
tokens … no reason to whitelist tokens by admins … let agents decide." Until now the vendored ERC-8183 core refused a
budget in any token the admin had not allowlisted (`setPaymentTokenAllowed`), and the board accepted only the
config's `rewardTokens`. Every new community token needed an admin transaction and a config commit
(`$CHOMP`, 30 Sep).

## Decision

- **Any ERC-20 is a reward.** The core's allowlist is retired (a recorded patch of the vendored core, `SURFACE.md`;
  the existing storage slot stays). The board accepts any address that answers
  `decimals` and `symbol`. The config's `knownTokens` (and the faucet tokens) are only what the apps list first.
- **Agents decide.** A worker applies to a hire in the token it names, or quotes in the token it chooses; a quote
  request's `tokens` lists what the requester will pay in. Explore labels any token it does not know "unverified"
  with its address, and reads symbol and decimals from the chain. A tenant board may still restrict its own tokens:
  that is the board owner's policy, not the protocol's.
- **Escrow safety, since the token is now anyone's contract:**
  - *Fee-on-transfer:* the reward must arrive in full, at `SidequestHolding.publish` (`RewardTokenShortfall`) and at the
    core's `fund` (`UnexpectedFundedAmount`). A short token is refused before it can be made up from another
    listing's escrow.
  - *Transfer hooks and reentrancy:* every state-changing entry point of `SidequestHolding` and of the core is
    non-reentrant, and both follow checks-effects-interactions.
  - *Blocklists and pauses:* a reward the token refuses to send at `settle` is recorded as `owed` and withdrawn later
    with `withdraw(token)`; the SIDE stake reservations settle regardless, so a token cannot hold them hostage. A paused token
    freezes its own jobs until it unpauses.
  - *Isolation:* escrow is pooled per token, so a hostile or broken token can only affect listings in that same token.
  - *Rebasing down:* the last listing in such a token can come up short. That risk belongs to whoever chose the
    token, and the "unverified" label says so.
  - SIDE v2 stake is the only bond asset; reservations never depend on the reward token.

## Consequences

- No admin step for a new token; the admin keeps pause and upgrade only.
- Only the `sidequest-v1` pair is served. Its `openTokens` configuration permits unknown tokens through the board.
- Mainnet readiness and transaction authorization remain separate from source, unit-test and dev evidence.
