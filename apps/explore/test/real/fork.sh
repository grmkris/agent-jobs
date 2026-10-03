#!/usr/bin/env bash
# U-REAL: a throwaway anvil fork of Monad testnet with Hireling v1 deployed on it, left running for real.e2e.mjs.
#   bash apps/explore/test/real/fork.sh up     # KEEP=1 rehearse-launch-testnet.sh, then one hire; prints the state file
#   bash apps/explore/test/real/fork.sh down   # stop the fork, remove this run's scratch config and forge directories
# The launch is contracts' own G1 rehearsal (contracts/script/rehearse-launch-testnet.sh with KEEP=1): a fresh 1-of-2
# Safe of anvil's public dev keys, launch-testnet.sh from throwaway keystores, the Safe granted the core's ADMIN_ROLE,
# a fee proposal and a Holding probe left pending. It runs under the launch lock (contracts/script/launch-lock.sh),
# which this script takes first and holds through its own forge run, and writes only its per-run scratch config
# config/rehearsal-<run>.json and forge logs under broadcast/ and cache/rehearsal-<run>: never the chain-10143 paths a
# real launch writes (UI-FORK-PATHS). RehearseHire (one direct hire in mUSD, settled, so epoch 0 has a fee) runs with the
# same NETWORK, FOUNDRY_BROADCAST and FOUNDRY_CACHE_PATH. Dev keys only, a local fork only; nothing reaches testnet.
# Needs anvil, forge, cast, jq, bun. RPC = the testnet RPC to fork (default the public one), PORT (default 8611).
set -euo pipefail
cd "$(dirname "$0")/../../../../contracts"

PORT="${PORT:-8611}"
STATE_DIR="${STATE_DIR:-/tmp/hireling-real}"
CHAIN=10143
LOCAL="http://127.0.0.1:$PORT"

# Only what this harness's run made: the anvil it kept, the scratch config naming its Safe, the forge directories
# carrying its run mark (contracts/script/rehearse-owned.sh decides).
down() {
  local f="$STATE_DIR/state.json"
  if [[ -f "$f" ]]; then
    local pid; pid=$(jq -r '.anvilPid // empty' "$f")
    if [[ -n "$pid" ]] && tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q "anvil .*--port $(jq -r .port "$f")"; then kill "$pid"; fi
    (
      . script/rehearse-owned.sh
      NETWORK=$(jq -r .network "$f") FOUNDRY_BROADCAST=$(jq -r .broadcast "$f") FOUNDRY_CACHE_PATH=$(jq -r .cache "$f")
      RUN_ID=${NETWORK#rehearsal-}
      owned_file "config/$NETWORK.json" .hireling.safe "$(jq -r .safe "$f")"
      owned_run_dirs
    )
  fi
  rm -rf "$STATE_DIR"
  echo "fork down"
}
if [[ "${1:-}" == down ]]; then down; exit 0; fi
[[ "${1:-}" == up ]] || { echo "usage: fork.sh up|down" >&2; exit 2; }

[[ ! -e "$STATE_DIR" ]] || { echo "refusing: $STATE_DIR exists; run fork.sh down first" >&2; exit 1; }
! ss -ltn 2>/dev/null | grep -q "127.0.0.1:$PORT " || { echo "refusing: port $PORT is in use" >&2; exit 1; }
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
fail() { echo "FAIL: $*" >&2; down >/dev/null; exit 1; }
ok() { echo "ok: $*"; }

. script/launch-lock.sh
take_launch_lock
. script/rehearse-owned.sh
REAL_LOGS=$(real_logs "$CHAIN")

# The launch. Its own launch-testnet.sh runs inherit this script's lock (fd 9); the anvil it keeps does not.
PORT="$PORT" KEEP=1 bash script/rehearse-launch-testnet.sh >"$STATE_DIR/launch.log" 2>&1 || { tail -30 "$STATE_DIR/launch.log" >&2; fail "rehearse-launch-testnet.sh"; }
keep() { grep -m1 "^KEEP: $1" "$STATE_DIR/launch.log" || true; }
ANVIL_PID=$(keep fork | sed -n 's/.*anvil pid \([0-9]*\)).*/\1/p')
FORGE_ENV=$(keep "further forge runs")
NETWORK=$(sed -n 's/.* NETWORK=\([^ ]*\) .*/\1/p' <<<"$FORGE_ENV")
FOUNDRY_BROADCAST=$(sed -n 's/.* FOUNDRY_BROADCAST=\([^ ]*\) .*/\1/p' <<<"$FORGE_ENV")
FOUNDRY_CACHE_PATH=$(sed -n 's/.* FOUNDRY_CACHE_PATH=\([^ ]*\) .*/\1/p' <<<"$FORGE_ENV")
CONFIG="config/$NETWORK.json"
SAFE=$(jq -r .deployment.hireling.safe "$CONFIG" 2>/dev/null || true)
[[ -n "$ANVIL_PID" && "$NETWORK" == rehearsal-* && "$FOUNDRY_BROADCAST" == broadcast/rehearsal-* && "$FOUNDRY_CACHE_PATH" == cache/rehearsal-* && "$SAFE" == 0x* ]] \
  || { tail -10 "$STATE_DIR/launch.log" >&2; fail "could not read the KEEP lines"; }
# Recorded at once, so a failure from here on removes exactly this run's things.
jq -n --argjson pid "$ANVIL_PID" --arg port "$PORT" --arg network "$NETWORK" --arg broadcast "$FOUNDRY_BROADCAST" --arg cache "$FOUNDRY_CACHE_PATH" --arg safe "$SAFE" \
  '{ anvilPid: $pid, port: $port, network: $network, broadcast: $broadcast, cache: $cache, safe: $safe }' >"$STATE_DIR/state.json"
[[ "$(cast chain-id --rpc-url "$LOCAL" 2>/dev/null)" == "$CHAIN" ]] || fail "the kept fork is not on $LOCAL"
export NETWORK FOUNDRY_BROADCAST FOUNDRY_CACHE_PATH
ok "KEEP=1 launch on $LOCAL: $NETWORK, Safe $SAFE, forge logs under $FOUNDRY_BROADCAST and $FOUNDRY_CACHE_PATH"

MNEMONIC="test test test test test test test test test test test junk"
devkey() { cast wallet private-key --mnemonic "$MNEMONIC" --mnemonic-index "$1"; }
addr() { cast wallet address --private-key "$1" 2>/dev/null; }
# Anvil's public dev accounts, as the rehearsal assigns them (deployer 0, Safe owners 1 and 2), and three more for the
# pages. anvil keeps them unlocked, so the page's injected wallet signs and sends through it; the rehearsal cleared their
# EIP-7702 code on the fork.
K_DEPLOYER=$(devkey 0) K_CREATOR=$(devkey 4) K_WORKER=$(devkey 5)
DEPLOYER=$(addr "$K_DEPLOYER") OWNER1=$(addr "$(devkey 1)") OWNER2=$(addr "$(devkey 2)") STAKER=$(addr "$(devkey 3)")
CREATOR=$(addr "$K_CREATOR") WORKER=$(addr "$K_WORKER")
[[ "$(cast call --rpc-url "$LOCAL" "$SAFE" "getOwners()(address[])" | tr 'A-F' 'a-f')" == "$(echo "[$OWNER1, $OWNER2]" | tr 'A-F' 'a-f')" ]] \
  || fail "the rehearsal's Safe is not owned by dev accounts 1 and 2"
for a in $OWNER2 $STAKER $CREATOR $WORKER; do
  cast rpc --rpc-url "$LOCAL" anvil_setBalance "$a" 0x3635c9adc5dea00000 >/dev/null # 1,000 MON
done

# One direct hire in mUSD, settled inside epoch 0, so mining:epoch 0 counts a fee. RehearseHire pays in .liquidity.quote,
# which the run's scratch config gets here.
MUSD=$(jq -r '.deployment.rewardTokens[0]' config/monad-testnet.json)
jq --arg musd "$MUSD" '.liquidity = { quote: $musd }' "$CONFIG" >"$CONFIG.tmp" && mv "$CONFIG.tmp" "$CONFIG"
cast send --rpc-url "$LOCAL" --private-key "$K_DEPLOYER" "$MUSD" "mint(address,uint256)" "$DEPLOYER" 1000000000 >/dev/null
env DEPLOYER_KEY="$K_DEPLOYER" CREATOR_KEY="$K_CREATOR" WORKER_KEY="$K_WORKER" \
  forge script script/RehearseHireAndMine.s.sol --tc RehearseHire --rpc-url "$LOCAL" --broadcast --slow >"$STATE_DIR/hire.log" 2>&1 \
  || { tail -30 "$STATE_DIR/hire.log" >&2; fail "RehearseHire"; }
ok "one hire settled ($(grep -o 'net to worker [0-9]*' "$STATE_DIR/hire.log" || echo 'see hire.log'))"

# launch-testnet.sh's pauser step granted the Safe the reused core's ADMIN_ROLE, as the real G1 does.
CORE=$(jq -r .deployment.core "$CONFIG")
ADMIN_ROLE=$(cast call --rpc-url "$LOCAL" "$CORE" "ADMIN_ROLE()(bytes32)")
[[ "$(cast call --rpc-url "$LOCAL" "$CORE" "hasRole(bytes32,address)(bool)" "$ADMIN_ROLE" "$SAFE")" == true ]] || fail "the Safe does not hold the core's ADMIN_ROLE"
ok "the Safe holds the core's ADMIN_ROLE (launch-testnet.sh's pauser step)"

# The staker holds FACTORY (from the deployer's allocation) to stake from the page.
FACTORY=$(jq -r .deployment.hireling.factory "$CONFIG")
cast send --rpc-url "$LOCAL" --private-key "$K_DEPLOYER" "$FACTORY" "transfer(address,uint256)" "$STAKER" "$(cast to-wei 50000)" >/dev/null

[[ "$(real_logs "$CHAIN")" == "$REAL_LOGS" ]] || fail "a chain-$CHAIN forge log outside $FOUNDRY_BROADCAST and $FOUNDRY_CACHE_PATH changed"
ok "no chain-$CHAIN forge log outside this run's directories changed"

# Every real.e2e.mjs run starts from here: it reverts to this snapshot and takes a fresh one.
SNAPSHOT=$(cast rpc --rpc-url "$LOCAL" evm_snapshot | tr -d '"')
jq --arg rpc "$LOCAL" --arg config "$PWD/$CONFIG" --arg deployer "$DEPLOYER" --arg owner1 "$OWNER1" --arg owner2 "$OWNER2" \
  --arg staker "$STAKER" --arg creator "$CREATOR" --arg worker "$WORKER" --arg snapshot "$SNAPSHOT" \
  '. + { rpc: $rpc, chainId: 10143, config: $config, snapshot: $snapshot, accounts: { deployer: $deployer, owner1: $owner1, owner2: $owner2, staker: $staker, creator: $creator, worker: $worker } }' \
  "$STATE_DIR/state.json" >"$STATE_DIR/state.tmp" && mv "$STATE_DIR/state.tmp" "$STATE_DIR/state.json"
echo "FORK UP: $STATE_DIR/state.json"
