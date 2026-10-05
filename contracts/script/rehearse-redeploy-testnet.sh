#!/usr/bin/env bash
# Full G1c delegated-stake proof on an owned local Monad fork: prepare -> launch dry run -> fast recipe -> promote -> SDK.
# Uses only disposable fork keys and an isolated config/archive/Forge run. No live sends, no real config writes.
# From repo root: heavy bash contracts/script/rehearse-redeploy-testnet.sh
set -euo pipefail
export PREP_REDEPLOY=1
exec bash "$(dirname "$0")/rehearse-launch-testnet.sh" "$@"
