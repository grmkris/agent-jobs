# Recovery credential exposure — 1 October 2026

During recovery, an Alchemy state inspection printed secret binding values into
tool output. The affected names were `AI_GATEWAY_API_KEY`, `ATTESTER_PRIVATE_KEY`,
`RELAY_PRIVATE_KEY`, `GITHUB_APP_PRIVATE_KEY`, and `HYPERSYNC_API_TOKEN`. Values are
not reproduced here. Local Alchemy state stores secret binding data; treat state
and its backups as sensitive, never as a safe-to-print deployment manifest.

Kris explicitly chose to continue **testnet recovery with the current credentials**.
This does not rotate or revoke those credentials, and does not authorize mainnet.

Outstanding: replace and revoke the affected provider credentials, coordinate
GitHub App key replacement, and prepare coordinated testnet signer/role changes
before replacing signing keys. Do not change an immutable or active role blindly,
or claim that deleting local output revokes exposed credentials. Verify restored
service health and signing-role consistency after rotation. The release tooling
uses explicit safe fields for state/cloud inventory and suppresses raw provider
causes, which can contain request bodies.
