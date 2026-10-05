# Spec v2 build handoff — 5 October 2026

P1–P7 implementation is ready for Claude's review and P8 release preparation.
This is source, local/fork and provider-fixture evidence; it is not a deployed
spec v2 or genuine-user acceptance claim.

Recent phases:

- P5: `e363fdb`, `8884206` — managed-agent setup, approvals, operator recovery,
  one-agent OAuth consent, client commands and landing/activity presentation.
- P6: `149f6b1` — MCP-only skills, ADR-0013 authority matrix, sponsorship and
  wallet docs, sanitized live inventory and preserved relay ledgers.
- P7: `44294c7`, `66eb794`, `64aa081`, `2892314` — the definitive mining rule,
  [fixtures and read-only evidence](p7-mining.md).

The sole management object is `__hosted_sponsor_v1__`; the former fleet object
is retirement-only. Version 2 drops and creates final management tables in one
atomic transition, preserving `sponsor_operations`, `sponsor_replacements` and
`relay_operations` so pending sends can reconcile. Unknown-token hires require
a verified exact operator allowance decision before any agent-approve-once grant.

`heavy pnpm check` is green. Mining includes a real local contract fork and
historical pool reads. P5 browser smoke passed at 390×844 and 1440×900 with no
page errors, horizontal overflow or landing sidebar; this does not establish a
real Privy user's consent or client-side recovery.

The P3 provider/relay proof now passes with [p3-executor.json](p3-executor.json).
The single testnet receipt used 432,693 gas and 0.044134686 MON; retries reused
the confirmed operation without fresh signatures or nonce changes. Its runner
fixes are `c7d16df` and `72cf7c8`. Combined with P0, the measured fixture relay
cost is 0.676892808 MON, within the 1 MON fixture run budget. This proves the
executor integration, not deployed HTTP onboarding or genuine-user consent.

Claude owns P8:

1. Check/install the real Privy IDs and routine secret in the approved runtime
   bindings; keep policy-admin authority out of the Worker.
2. Run the guarded release sequence from the staging runbook, reviewing the
   exact source, resources, schema transition and rollback manifest.
3. Prove deployed A03–A07 fixture flows, then genuine-user A01/A02, recovery,
   over-limit approval and revocation. A08 includes fresh-client instructions
   and the mining fixtures. Never substitute a fixture for human consent.
4. Configure the featured job only after Kris approves its public brief and
   recorded flow; `FEATURED_JOB` currently remains null.
5. Select and record the official mining pool before launch. P7 supports
   constant-product and Uniswap v4 reads without silently picking a venue.
6. Record actual live results in `docs/reality-check.md`. Mainnet still requires
   Kris's explicit go after the testnet gate.

The test agent inventory remains bounded: no matching wallet among registry IDs
0..2099 and an empty public agent index, not proof of nonregistration. Its funds
and zero stake are recorded in [inventory.json](inventory.json). Operator
`sponsor_status` returned 401 without an authenticated session. Old DO row counts
remain unknown-live. These evidence boundaries should remain in the release review.

No deployment or mainnet transaction was run by the build agent. The unrelated
`.artifact-video/` and `packages/sdk/scripts/.local/` paths remain untouched.
