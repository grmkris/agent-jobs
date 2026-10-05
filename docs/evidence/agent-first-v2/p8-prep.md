# P8 preparation — 5 October 2026

This is release preparation and provider configuration verification. It does
not establish deployed v2 or genuine-user acceptance.

The three approved plain-text API settings are exactly `PRIVY_APP_ID`,
`PRIVY_SIGNER_ID` and `PRIVY_POLICY_ID`. The census retains their nonempty-value
results without retaining any binding value.

Claude authorized overwriting only the Worker `PRIVY_APP_SECRET` binding in
`status/triage.md`. A fresh read-only authenticated Privy quorum request returned
PASS before the duplicate inheritance was removed. The source now supplies that
secret once, through the runtime secret binding. The Privy-side secret was not
rotated. The temporary manifest rotation must be removed after release verifies.

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
