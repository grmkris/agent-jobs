# ADR-0008: Tenant boards and the embeddable marketplace

**V1 scope note (2 Oct):** tenant routing, origins and token policies remain. New hires use the per-offer windows/arbitrator and stake reservations in [ADR-0011](0011-sidequest-v1.md). Mainnet admission is authenticated and rate-limited with an emergency drain, not an invitation allowlist.

Date: 2026-09-29. Status: **in progress (overnight run 29/30 Sep); tenant boards implemented and tested, the rest lands
step by step in this run** (`docs/reality-check.md`).

## Context

Every job so far went through one hosted board (`public`) and one site (Explore). Kris's direction: a host app, first
the Monad Pet game, embeds the protocol so its own users can commission work and post quests, and
hire agents from a directory. That needs boards a host owns, browser access from the host's origin, a wallet story for
players who have no MON, and packages a host can integrate. Decisions D1–D18 in the run plan; this ADR records the ones
that shape the code.

## Decisions

- **A board is a tenant.** A row in the registry (`boards` in the API's D1) plus one Durable Object keyed by its slug.
  Routes `/b/<slug>/api/<tool>`, `/b/<slug>/mcp` and `/data/jobs?board=<slug>`; without the prefix the `public`
  board, byte-for-byte as before. Self-serve: `create_board` by any signed-in wallet, which becomes the owner;
  `update_board` by the owner. A board's config names its stacks and default stack, a subset of the deployment's
  reward tokens, a default deliverable spec and approver, the origins that may embed it, whether it drips MON, a
  reserved `sponsor` mode, the evidence producers it trusts, and a webhook URL. **Nothing in a board config moves
  money**: it narrows what an offer may say and where it may be used from.
- **Offers are attributed off-chain.** `board_offers(terms_hash → board_id, task_id)` is written when `create_task` or
  `pick_quote` freezes an offer; the listing's on-chain `policyHash` is that hash, so chain jobs join to boards without
  a board field in the contracts or in the terms. No existing `termsHash` changes.
- **One session store, the page's domain.** SIWE sign-in moved from each board's SQLite to one D1 table for every
  board (`sessions`, `siwe_nonces`, `mcp_sessions`), so a wallet signed in on Monad Pet's board is signed in on
  Explore. The SIWE `domain`/`uri` are the requesting page's origin when the board allows it, else the API host, so
  wallets see the site they are on.
- **CORS per board.** A page at one of the board's allowed origins gets `access-control-allow-origin` on `/b/<slug>`
  and `/data`; any other origin gets none and the browser refuses the reply. Explore keeps proxying same-origin.
- **A testnet MON drip.** With `drip` on, the relay sends each address that signs in through the board 0.05 MON once
  (`drips` row reserved before the transfer, R114-07; a lost send is reconciled by the recipient's balance). Testnet
  only; the relay keeps a floor for rulings and evidence. `sponsor` is reserved for Privy's native sponsorship (Monad
  Testnet is on its list; a dashboard toggle and `sponsor: true`) or a paymaster, without an SDK change.
- **The Worker owns the registry, the indexer owns its tables.** The API Worker creates and writes the registry and
  session tables; the indexer stays the only writer of chain facts.

_(The `@sidequest/react` package, the hosted widget, webhooks, the agent directory and direct hire are added to
this ADR by their steps.)_

## Consequences

- The API Worker now writes D1 (registry, sessions, drips). A bug there cannot touch chain facts.
- A board owner controls listing policy for its slug and never a wallet: publish, select, approve stay the creator's.
- `create_board` is unmoderated: the worst case is a spam listing, since no money is involved.
- A third-party page needs an explicit origin on the board; a page that is not listed cannot even sign in.
