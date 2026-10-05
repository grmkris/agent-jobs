# P8 preparation — 5 October 2026

This is release preparation and provider configuration verification. It does
not establish deployed v2 or genuine-user acceptance.

The plain-text API settings `PRIVY_APP_ID`, `PRIVY_SIGNER_ID` and
`PRIVY_POLICY_ID`, plus the `PRIVY_SIGNER_KEY` secret, were applied in the
released stack and have been removed from the follow-up approval manifest. The
census retains their nonempty-value results without retaining any binding value.

Claude authorized overwriting only the Worker `PRIVY_APP_SECRET` binding in
`status/triage.md`. A fresh read-only authenticated Privy quorum request returned
PASS before the duplicate inheritance was removed. The source now supplies that
secret once, through the runtime secret binding. The Privy-side secret was not
rotated. Claude recorded release and readback for `f2dc8ed` in
`status/triage.md`; the temporary Privy overwrite and stale Telegram additions
have now been removed from the approved manifest. Directive 13:15 also retired
the applied Privy additions and the stale `RELAY_PRIVATE_KEY` rotation approval.
The apex domain-release entry remains pending; Claude verifies these bindings
are unchanged in the next read-only release plan.

`pnpm exec bun packages/sdk/scripts/privy/setup.ts --verify` passed against the
real Privy API, using only GET requests. Both authorization thresholds remain
one, with the expected single keys and no extra user/quorum members. The policy
owner, chain type and complete rules match the checked-in policy:

| Authority | ID |
| --- | --- |
| Routine quorum | `qetyy57hy4cc69q8xjonwlc3` |
| Policy-admin quorum | `q4bhp78wp2ialt6ffv2pv3mg` |
| Policy | `s06i5eramn0plwdunkvxf8aj` |

The local Privy test email and fixed OTP are present. App settings did not expose
test credentials, and the test-account API route returned 404. No credential
value was printed or included in evidence. These are fixture credentials;
browser and MCP acceptance remain separate checks after Claude's release.

`pnpm dlx node@24` reported v24.21.0 for both its process and a `node` child. The
system executable was preserved. Exact coordinator invocations are documented
in the staging release runbook.

All fifteen existing local Chromium suites passed through `heavy`, serially:
`admin`, `collect`, `directory`, `hire-again`, `launch`, `live-ui-plan`,
`mainnet-empty`, `onboarding`, `publish-v1`, `selection`, `sponsored`, `stake`,
`ux`, `v1-flows` and `v1-job`. Logs and screenshots are retained locally under
`/tmp/hireling-p8-browser/`. Each suite closed its browser and local Vite server.

These results are mocked-browser coverage (the UI-plan suite uses local DOM),
separate from deployed fixture acceptance. Fixtures now supply current stats,
v1 reads and grant-keyed sponsor entries. The UX run found a real public Jobs
backlink still targeting the landing page; the shared route helper now returns
`/jobs`, and the list-detail-list click assertion verifies the fix. Uncertain-send
fault injection waits for the wallet prompt before taking the fixture RPC down.

`heavy pnpm check` passed after the browser and navigation changes. The mining
unit suite reported 47 pass, one fork test skipped without its RPC opt-in.
