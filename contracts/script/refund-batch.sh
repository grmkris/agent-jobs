#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
generation=g1d
args=("$@")
for ((i=0; i<${#args[@]}; i++)); do
  if [[ "${args[i]}" == --generation ]]; then
    [[ $((i+1)) -lt ${#args[@]} ]] || { echo 'refund: missing generation' >&2; exit 1; }
    generation="${args[i+1]}"
  fi
done
[[ "$generation" =~ ^[a-z][a-z0-9-]{1,31}$ ]] || { echo 'refund: invalid generation' >&2; exit 1; }
directory=".${generation}-refunds"
umask 077
if [[ -L "$directory" ]]; then echo 'refund: journal directory must not be a symlink' >&2; exit 1; fi
mkdir -p "$directory"
[[ -d "$directory" && "$(stat -c '%u:%a' "$directory")" == "$(id -u):700" ]] \
  || { echo 'refund: journal directory must be owned with mode 700' >&2; exit 1; }
[[ ! -L "$directory/journal.lock" ]] || { echo 'refund: lock must not be a symlink' >&2; exit 1; }
exec 9>"$directory/journal.lock"
flock -n 9 || { echo 'refund: another refund batch owns the journal' >&2; exit 75; }
export SIDEQUEST_REFUND_LOCKED="$generation"
exec bun --no-env-file contracts/script/refund-batch.mjs "$@"
