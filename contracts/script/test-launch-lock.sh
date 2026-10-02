#!/usr/bin/env bash
# The launch lock (script/launch-lock.sh, the G1-DRY-001 residual), with no chain, no keys and no fork:
#   1. while one run holds it, launch-testnet.sh and each of the four fork rehearsals, started separately, refuses at
#      once: exit 1, the refusal its only output, nothing written under config/, broadcast/ or cache/;
#   2. once that run ends, the lock is free;
#   3. a launch-testnet.sh started by a run holding the lock (as a rehearsal starts it) inherits the lock and goes on to
#      its own first check; one started by that run with fd 9 closed (anything else) refuses;
#   4. the real launch keeps forge's default paths: launch-testnet.sh on monad-testnet refuses FOUNDRY_BROADCAST.
# Refuses with exit 75 while a real launch or rehearsal holds the lock in this checkout (retry once it ends).
#   bash script/test-launch-lock.sh
set -euo pipefail
{ # parsed whole before it runs, so an edit to this file mid-run cannot change what runs
cd "$(dirname "$0")/.."
. script/launch-lock.sh
SCRIPTS=(launch-testnet.sh rehearse-launch.sh rehearse-launch-testnet.sh rehearse-flows-testnet.sh rehearse-hireling-pipeline.sh)
REFUSAL="refusing: another launch or rehearsal is running in this checkout (it holds $LAUNCH_LOCK)"
# Each script runs as an unrelated process would: fd 9 closed, no colour, and (should one ever not refuse) no reachable
# RPC to fork or send to.
CLEAN=(env -u FORCE_COLOR -u FOUNDRY_BROADCAST -u FOUNDRY_CACHE_PATH NO_COLOR=1 RPC=http://127.0.0.1:9
  MAINNET_RPC=http://127.0.0.1:9 RPC_ENV=LAUNCH_LOCK_TEST_NO_RPC)
NO_RPC="set LAUNCH_LOCK_TEST_NO_RPC in the environment (its name, from RPC_ENV)"
HOLDER=
trap '[[ -z "$HOLDER" ]] || kill "$HOLDER" 2>/dev/null || true' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }
free() { flock -n "$LAUNCH_LOCK" true 9>&-; }
listing() { ls -A config broadcast cache 2>/dev/null || true; }
run() { set +e; OUT=$("$@" 2>&1 9>&-); CODE=$?; set -e; }

free || { echo "a launch or rehearsal is running in this checkout; retry once it ends" >&2; exit 75; }

# 1. A run in progress: take_launch_lock, then wait (exec keeps fd 9, and with it the lock).
bash -c '. script/launch-lock.sh && take_launch_lock && exec sleep 300' 9>&- &
HOLDER=$!
for _ in $(seq 50); do free || break; sleep 0.1; done
! free || fail "the holder did not take the lock"
before=$(listing)
for s in "${SCRIPTS[@]}"; do
  run "${CLEAN[@]}" bash "script/$s"
  [[ $CODE -eq 1 && "$OUT" == "$REFUSAL" ]] || fail "$s, started while another run held the lock, did not refuse at once (exit $CODE): $OUT"
done
[[ "$(listing)" == "$before" ]] || fail "a refused run wrote under config/, broadcast/ or cache/"
ok "while one run holds the lock, ${SCRIPTS[*]} each refuse at once (exit 1, nothing written)"

# 2. It ends; the lock is free.
kill "$HOLDER"; wait "$HOLDER" 2>/dev/null || true; HOLDER=
for _ in $(seq 50); do free && break; sleep 0.1; done
free || fail "the lock is still held after its run ended"
ok "once that run ends, the lock is free"

# 3. Inherited by the run's own children, and only by them. The holder outlives the child, as a rehearsal does (bash
# would otherwise exec its last command in place, handing over its only fd 9), and must still hold the lock after.
holder() { # <command run by the holder>
  run "${CLEAN[@]}" bash -c '. script/launch-lock.sh && take_launch_lock && { '"$1"'; code=$?
    flock -n "$LAUNCH_LOCK" true 9>&- && { echo "the holder lost the lock"; exit 99; }; exit $code; }'
}
holder 'bash script/launch-testnet.sh'
[[ $CODE -eq 2 && "$OUT" == "$NO_RPC" ]] || fail "launch-testnet.sh started by the lock's holder did not get past the lock (exit $CODE): $OUT"
holder 'bash script/launch-testnet.sh 9>&-'
[[ $CODE -eq 1 && "$OUT" == "$REFUSAL" ]] || fail "launch-testnet.sh started without the holder's fd 9 did not refuse (exit $CODE): $OUT"
free || fail "the lock is still held after the holder's children ended"
ok "a launch-testnet.sh started by the holder inherits the lock; one started with fd 9 closed refuses"

# 4. The real launch keeps the default paths.
for v in FOUNDRY_BROADCAST FOUNDRY_CACHE_PATH; do
  run "${CLEAN[@]}" "$v=broadcast/elsewhere" bash script/launch-testnet.sh
  [[ $CODE -eq 2 && "$OUT" == "refusing: FOUNDRY_BROADCAST/FOUNDRY_CACHE_PATH are set, but monad-testnet is no rehearsal; unset them" ]] \
    || fail "launch-testnet.sh on monad-testnet took $v (exit $CODE): $OUT"
done
run "${CLEAN[@]}" NETWORK=rehearsal-lock-test FOUNDRY_BROADCAST=broadcast/elsewhere bash script/launch-testnet.sh
[[ $CODE -eq 2 && "$OUT" == "$NO_RPC" ]] || fail "launch-testnet.sh on a rehearsal network refused FOUNDRY_BROADCAST (exit $CODE): $OUT"
ok "launch-testnet.sh on monad-testnet refuses FOUNDRY_BROADCAST and FOUNDRY_CACHE_PATH; a rehearsal network takes them"
echo "LAUNCH LOCK TEST PASSED"
exit
}
