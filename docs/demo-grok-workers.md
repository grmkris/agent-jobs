# Automated Grok image workers

The testnet demo supervisor runs two independent Grok workers: Grok Canvas and Grok Studio. Their wallets remain
separate, and each worker signs only for its own registered ERC-8004 agent. The runtime model uses the local Grok
proxy's `grok-imagine-image` endpoint for image work.

The workers watch quote requests, quote only image or simple-file requests, and wait for the publisher to pick one.
They do not select themselves or spend before selection. After the publisher publishes and signs the selection, the
selected worker activates, generates a JPEG or PNG (or a simple file), hosts the exact bytes in the dedicated public
`hireling-demo-deliveries` GitHub repository, hashes them, submits the artifact,
and reports the transaction. The creator still approves the work and releases payment.

Set up fresh demo wallets and registrations once, then start and inspect the supervisor from the repository root:

```bash
pnpm demo:workers setup
pnpm demo:workers start
pnpm demo:workers status
cat .demo-workers/status.json
```

The runner needs `CLIPROXY_API_KEY` from the interactive shell or `.env.local` and checks it before processing
jobs. For a persistent tmux launch that inherits this box's interactive-shell configuration:

```bash
tmux new-session -d -s agent-jobs-demo-workers -c "$PWD" "zsh -lic 'pnpm demo:workers start'"
```

Stop it after the demo:

```bash
pnpm demo:workers stop
```

Setup creates two fresh testnet wallets and registers them as demo workers, then transfers gas and FACTORY from the
configured ecosystem allocation and stakes 20 FACTORY in the current vault for each worker. The runner does not touch
mainnet and leaves creator selection and approval in the human's hands. The private journal is under `.demo-workers/`
and is gitignored; the generated artifact repository is dedicated to this demo.

The demo is scoped to creator `0xB9970A6371358F6C74DFb15A7cB2653E3AE3E471`, Monad testnet's current `main` v1
stack, and its configured mUSD reward token. Grok Canvas quotes 3 mUSD; Grok Studio quotes 5 mUSD. Each worker
handles one active delivery at a time, permits at most 5 FACTORY worker bond, and requires at least 15 minutes to
deliver. It supports an artifact or git deliverable, with the `test` CI check when requested, and declines named
delivery targets that need another adapter.

If a provider call is interrupted, generation stops for operator reconciliation instead of generating twice.
Transaction retries reconcile the saved signed operation; restarting does not fund or register the workers again.

## Live demo (4 Oct 2026)

Grok Canvas is agent **1994** and Grok Studio is agent **1995**. Both are enrolled, have gas, and each has
20 FACTORY staked plus 5 liquid FACTORY. The supervisor runs in tmux session `agent-jobs-demo-workers`.
Canvas completed the automated activation, image generation, hosting, verification and submission for
[job #106](https://testnet.hireling.xyz/job/106); the creator's review and approval remain manual. The
[sanitized live receipt](evidence/testnet-directory/2026-10-04-grok-demo-workers.json) records the wallets,
quotes, transaction hashes, hosted image hash and successful GitHub validation.

The creator subsequently approved the timely submission. The job is now `Completed`; Canvas received 2.1 mUSD net
and its 20 FACTORY stake is fully available again.
