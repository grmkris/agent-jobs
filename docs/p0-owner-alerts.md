# Owner alert preparation

The five alert classes are fake-sender tested but not live-enabled; Kris must authorize an owner myagent connection and one controlled receipt test before relying on phone alerts.

`apps/api/src/alerts.ts` defines uptime, stale indexer, failed/stuck publish, eligible stuck/owed escrow, and
unexpected administration observations. Ordinary refusals, expected administration, and ineligible escrows do
not alert. `monitorP0` turns observations into bounded incident records. The sender accepts only an owner OAuth
token for the fixed myagent MCP endpoint, never a caller-controlled chat, recipient, or webhook. It calls the
owner-only `send_message` tool; no Telegram token, API client, `getUpdates`, webhook mutation, or bot send is used
by these tests or this track.

The adapter matches the current local myagent protocol: a SHA-256-derived operation ID with only letters,
digits, hyphens/underscores and at most 100 characters; escaped Telegram HTML; and a `sent` receipt with a
positive message ID. Unknown/retryable/refused/malformed receipts are not confirmed. Reuse the exact operation
ID and payload only after reconciliation; never substitute a new ID to get around an uncertain outcome.

The dispatcher suppresses concurrent and repeated incident IDs in one process, including unknown deliveries.
An unconfirmed delivery does not suppress other independent incidents in the batch; the monitor reports the
failure count only after all incidents have been attempted, without echoing transport errors or secret values.
Myagent's durable operation ledger is the restart dedupe boundary. A changed payload under the same incident
ID conflicts rather than resending. The dispatcher must be cleared only after explicit incident resolution;
production collectors must persist incident state and recovery/reopen generations before scheduled operation.

This is a prepared adapter and signal contract, not running production monitoring: no collector/scheduler,
owner OAuth grant, real receipt, or week-long on-call/report cycle is claimed. Production uptime probes,
privileged-event inventory, escrow observations, durable incident state, and operator response drills remain
P1 launch/management work.
