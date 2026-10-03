#!/usr/bin/env bash
# Sign -> compute -> ECDSA Safe fund -> setRoot -> staging publish -> claim.
# Read-only refusal until the finalized epoch end; never accepts chain 143.
set -euo pipefail
cd "$(dirname "$0")/../.."
. contracts/script/launch-lock.sh
take_launch_lock
exec bun --no-env-file contracts/script/mine-epoch0-testnet.ts "$@"
