#!/usr/bin/env bash
# Rehearses the two-step Hireling v1 deploy (review C8-001) against a throwaway anvil fork of Monad testnet:
#   1. a dry run writes nothing;
#   2. a --broadcast run cut off after a few transactions leaves config/ untouched, and promotion refuses it;
#   3. --resume finishes the sequence, promotion verifies it live and records it once, with receipt blocks;
#   4. promotion again changes nothing.
# Sends nothing to a real chain (the deployer is impersonated on the fork). Needs anvil, forge, cast and jq.
#   RPC=https://testnet-rpc.monad.xyz bash script/rehearse-hireling-pipeline.sh
set -euo pipefail
cd "$(dirname "$0")/.."

FORK_RPC="${RPC:-https://testnet-rpc.monad.xyz}"
PORT="${PORT:-8599}"
LOCAL="http://127.0.0.1:$PORT"
export NETWORK=pipeline-rehearsal
CONFIG="config/$NETWORK.json"
CANDIDATE="broadcast/hireling/$NETWORK.candidate.json"
CHAIN=$(jq -r .chainId config/monad-testnet.json)
LOGDIR="broadcast/DeployHireling.s.sol/$CHAIN"
CACHEDIR="cache/DeployHireling.s.sol/$CHAIN"
ADMIN=$(jq -r .roles.admin config/monad-testnet.json)

if [[ -e "$LOGDIR" || -e "$CACHEDIR" ]]; then
  echo "refusing: $LOGDIR or $CACHEDIR exists (a real deploy log?); move it away first" >&2
  exit 1
fi

ANVIL_PID=
cleanup() {
  [[ -n "$ANVIL_PID" ]] && kill "$ANVIL_PID" 2>/dev/null || true
  rm -rf "$LOGDIR" "$CACHEDIR" "broadcast/PromoteHireling.s.sol/$CHAIN" "cache/PromoteHireling.s.sol/$CHAIN"
  rm -f "$CONFIG" "$CANDIDATE"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

cp config/monad-testnet.json "$CONFIG"
anvil --fork-url "$FORK_RPC" --port "$PORT" --block-time 1 --silent &
ANVIL_PID=$!
for _ in $(seq 60); do cast chain-id --rpc-url "$LOCAL" >/dev/null 2>&1 && break; sleep 1; done
[[ "$(cast chain-id --rpc-url "$LOCAL")" == "$CHAIN" ]] || fail "anvil fork not up"
cast rpc --rpc-url "$LOCAL" anvil_impersonateAccount "$ADMIN" >/dev/null
cast rpc --rpc-url "$LOCAL" anvil_setBalance "$ADMIN" 0x56bc75e2d63100000 >/dev/null # 100 MON

before=$(sha256sum "$CONFIG")

# 1. Dry run.
forge script script/DeployHireling.s.sol --rpc-url "$LOCAL" --sender "$ADMIN" >/tmp/rehearse-dry.log 2>&1 \
  || { tail -20 /tmp/rehearse-dry.log; fail "dry run"; }
[[ "$(sha256sum "$CONFIG")" == "$before" ]] || fail "dry run changed the config"
[[ ! -e "$CANDIDATE" ]] || fail "dry run wrote a candidate"
ok "dry run wrote nothing"

# 2. A broadcast cut off after three transactions: the deployer runs out of gas money.
start=$(cast nonce --rpc-url "$LOCAL" "$ADMIN")
forge script script/DeployHireling.s.sol --rpc-url "$LOCAL" --unlocked --sender "$ADMIN" --broadcast --slow \
  >/tmp/rehearse-cut.log 2>&1 &
FORGE_PID=$!
while (( $(cast nonce --rpc-url "$LOCAL" "$ADMIN") < start + 3 )); do
  kill -0 "$FORGE_PID" 2>/dev/null || { tail -20 /tmp/rehearse-cut.log; fail "broadcast ended early"; }
  sleep 0.2
done
cast rpc --rpc-url "$LOCAL" anvil_setBalance "$ADMIN" 0x0 >/dev/null
if wait "$FORGE_PID"; then fail "the cut-off broadcast succeeded"; fi
sent=$(( $(cast nonce --rpc-url "$LOCAL" "$ADMIN") - start ))
[[ "$(sha256sum "$CONFIG")" == "$before" ]] || fail "a failed broadcast changed the config"
[[ -e "$CANDIDATE" ]] || fail "no candidate after a broadcast run"
if forge script script/PromoteHireling.s.sol --rpc-url "$LOCAL" >/tmp/rehearse-promote-early.log 2>&1; then
  fail "promotion accepted an incomplete deploy"
fi
[[ "$(sha256sum "$CONFIG")" == "$before" ]] || fail "a refused promotion changed the config"
ok "broadcast cut off after $sent transactions; config untouched; promotion refused ($(grep -oE 'NotLive\("[^"]*"\)|BadBroadcast\("[^"]*"\)' /tmp/rehearse-promote-early.log | head -1))"

# 3. Resume, then promote.
cast rpc --rpc-url "$LOCAL" anvil_setBalance "$ADMIN" 0x56bc75e2d63100000 >/dev/null
forge script script/DeployHireling.s.sol --rpc-url "$LOCAL" --unlocked --sender "$ADMIN" --broadcast --slow --resume \
  >/tmp/rehearse-resume.log 2>&1 || { tail -20 /tmp/rehearse-resume.log; fail "resume"; }
[[ "$(sha256sum "$CONFIG")" == "$before" ]] || fail "the deploy itself changed the config"
forge script script/PromoteHireling.s.sol --rpc-url "$LOCAL" >/tmp/rehearse-promote.log 2>&1 \
  || { tail -20 /tmp/rehearse-promote.log; fail "promotion"; }
first=$(jq '[.receipts[].blockNumber | ltrimstr("0x") | ascii_downcase] | map(explode | reduce .[] as $c (0; . * 16 + (if $c >= 97 then $c - 87 else $c - 48 end))) | min' "$LOGDIR/run-latest.json")
[[ "$(jq .deployment.hireling.block "$CONFIG")" == "$first" ]] || fail "hireling.block is not the first receipt block ($first)"
[[ "$(jq -r .deployment.main.kind "$CONFIG")" == "hireling-v1" ]] || fail "main is not the v1 pair"
[[ "$(jq -r .deployment.hireling.vault "$CONFIG")" == "$(jq -r .vault "$CANDIDATE")" ]] || fail "vault"
[[ "$(jq -r .deployment.hireling.safe "$CONFIG")" == "$(jq -r .hireling.safe config/monad-testnet.json)" ]] || fail "safe"
ok "resumed and promoted; hireling.block = $first (first receipt)"

# 4. Promotion is idempotent.
promoted=$(sha256sum "$CONFIG")
forge script script/PromoteHireling.s.sol --rpc-url "$LOCAL" >/tmp/rehearse-promote2.log 2>&1 \
  || { tail -20 /tmp/rehearse-promote2.log; fail "second promotion"; }
grep -q "already promoted" /tmp/rehearse-promote2.log || fail "second promotion did not recognise the record"
[[ "$(sha256sum "$CONFIG")" == "$promoted" ]] || fail "second promotion changed the config"
ok "second promotion changed nothing"
echo "PIPELINE REHEARSAL PASSED"
