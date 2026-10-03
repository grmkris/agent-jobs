#!/usr/bin/env bash
# Sign -> compute -> ECDSA Safe fund -> setRoot -> staging publish -> claim.
# Default epoch 0; append --epoch N with prices for that ended earned epoch.
# Read-only refusal until the finalized epoch end; never accepts chain 143.
set -euo pipefail
cd "$(dirname "$0")/../.."
. contracts/script/launch-lock.sh
take_launch_lock
exec bun --no-env-file contracts/script/mine-epoch0-testnet.ts "$@"
