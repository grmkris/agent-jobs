#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
directory=.g1c-refunds
umask 077
if [[ -L "$directory" ]]; then echo 'refund: journal directory must not be a symlink' >&2; exit 1; fi
mkdir -p "$directory"
[[ -d "$directory" && "$(stat -c '%u:%a' "$directory")" == "$(id -u):700" ]] \
  || { echo 'refund: journal directory must be owned with mode 700' >&2; exit 1; }
[[ ! -L "$directory/journal.lock" ]] || { echo 'refund: lock must not be a symlink' >&2; exit 1; }
exec 9>"$directory/journal.lock"
flock -n 9 || { echo 'refund: another refund batch owns the journal' >&2; exit 75; }
export G1C_REFUND_LOCKED=1
exec bun --no-env-file contracts/script/refund-batch.mjs "$@"
