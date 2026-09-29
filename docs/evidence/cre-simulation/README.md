# 29 September 2026 simulator proof

Public GitHub CI evidence reached Monad testnet through the CRE simulator and matches the board's stored statement exactly; Kris needs nothing now, and the coordinator can link this proof in the hackathon submission.

- `summary.json`: source revision, tool versions, deployed addresses, transaction hashes and fees.
- `simulate-dry-run.log` and `simulate-broadcast.log`: full unedited command output. A zero hash in the dry run means no report was broadcast.
- `preflight.json`: actual anonymous GitHub response, exact request, normalized check list, full ABI report bytes, report hash and EIP-712 digest.
- `proof.json`: successful broadcast receipt, decoded receiver/evaluator events and read-back evidence fields.
- `cast-reads.txt`: separate chain id, evidence, verifier permissions, gate binding and completed-job reads.
- `deploy-simulation-gate.json`, `enable-verifier.json`, `disable-verifier.json`: transaction intentions and receipts. No private keys or signed raw transactions.
- `replay-check.log`: repeat invocation returns `alreadyRecorded: true`, `newBroadcast: false`; deployer nonce remained 65 (cleanup used nonce 64).
- `cleanup.json`: simulation receiver disabled, original board attester still enabled.
- `job8-offer.json` and `job8-award-receipt.json`: real offer and finalized submission reused by this proof.

Both attesters store digest `0xbee95e08ac012e11a3e1093725daf5b9ce0f782b5a9500779a1f51650f897507`. Expiry is the original board statement's `1791132076` (4 October 2026, 16:41:16 UTC), preserved intentionally for exact parity.

The authoritative result is the receipt and contract state on **chain 10143**. This exercises the local workflow, not a hosted decentralized oracle network. The CLI's simulation timestamps are two hours ahead of the wrapper/chain UTC timestamps on this host; `observedAtUtc`, wrapper records and block timestamps give the UTC observation time. No CRE workflow was registered/deployed and no mainnet transaction occurred.
