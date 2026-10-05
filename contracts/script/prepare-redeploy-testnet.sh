#!/usr/bin/env bash
# Coordinator-only reviewed testnet generation preparation. Read-only RPC check, local archive/config writes; no signing or broadcasts.
# Run at repo root after CLOCKS-PARAM review/merge, with MONAD_TESTNET_RPC_URL exported:
#   bash contracts/script/prepare-redeploy-testnet.sh --from g1b --check
#   bash contracts/script/prepare-redeploy-testnet.sh --from g1b
# A rehearsal can pass --config and --archive for its own scratch paths. Existing archives never overwrite.
set -euo pipefail
cd "$(dirname "$0")/.."
. script/launch-lock.sh
take_launch_lock
RPC_ENV="${RPC_ENV:-MONAD_TESTNET_RPC_URL}"
[[ -n "${!RPC_ENV:-}" ]] || { echo "refusing: set $RPC_ENV" >&2; exit 2; }
CHAIN=$(cast chain-id --rpc-url "${!RPC_ENV}" 2>/dev/null) \
  || { echo "refusing: RPC chain unreadable" >&2; exit 2; }
[[ "$CHAIN" == 10143 ]] || { echo "refusing: preparation requires RPC chain 10143" >&2; exit 2; }
exec python3 script/prepare_redeploy_testnet.py "$@"
