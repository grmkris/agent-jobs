#!/usr/bin/env bash
# G1-DRY: backend's B11 runner (packages/sdk/scripts/v1-flows.ts) against a real v1 deploy, on a throwaway anvil fork of
# Monad testnet (chain 10143). Steps:
#   1. a fresh 1-of-2 Safe; launch-testnet.sh deploys, promotes, accepts, grants the Safe the core's ADMIN_ROLE, deploys
#      odd tokens and makes the fee proposal and Holding probe, all with fresh keys, promoting into a scratch
#      config/rehearsal-<pid>-<random>.json (gitignored). The tracked config/monad-testnet.json is only ever read: at G1 the real
#      launch promotes into it, possibly in this same checkout (G1-DRY-001);
#   2. the wallets get MON, fresh-stack FACTORY and legacy FACTORY and the reward token (mUSD) on the fork, and deployment.oddTokens is
#      recorded;
#   3. the runner, which reads the SDK's bundled monad-testnet config, runs from a private mirror: byte-identical copies
#      of packages/sdk/src and scripts (without any journal), the real node_modules, and the scratch config as its
#      contracts/config/monad-testnet.json. Each case is its own `bun --no-env-file v1-flows.ts <case>` process, under
#      `env -i` with only fresh keys and the loopback RPC, so neither .env.local nor any real key or RPC can reach it.
#      Its journal stays in the mirror. The runner's chain-time waits are warped on the fork;
#   4. a pass/fail table per case and the gas limits (which Monad charges) per wallet, from the hashes the runner prints.
# Sends nothing to a real chain. Holds the launch lock (script/launch-lock.sh), so it refuses while another launch or
# rehearsal runs in this checkout. Forge writes under broadcast/ and cache/rehearsal-<pid>-<random> only, never a real
# launch's chain-10143 run-latest.json; on exit it deletes only what this run created, after checking it still owns it
# (script/rehearse-owned.sh). Needs anvil, forge, cast, jq, bun.
#   bash script/rehearse-flows-testnet.sh [cases]     # default: every case that needs no board (FLOW_CASES)
#   HOLD=<file> pauses after funding, with the fork up, until <file> is removed (to debug against it).
set -euo pipefail
{ # parsed whole before it runs, so an edit to this file mid-run cannot change what runs
cd "$(dirname "$0")/.."
. script/launch-lock.sh
take_launch_lock
. script/rehearse-owned.sh
REPO="$(cd .. && pwd)"

FORK_RPC="${RPC:-https://testnet-rpc.monad.xyz}"
PORT="${PORT:-8601}"
LOCAL="http://127.0.0.1:$PORT"
CHAIN=10143
TRACKED="config/monad-testnet.json" # read only
# Order matters: admin-vault-refusal must cancel the still-timelocked Holding probe before any wait. admin-fees executes
# the unchanged launch schedule next, before job windows and delegated cooldowns can expire its proposal grace.
# stake-cooldown runs last. legacy-dispute is left out: it signs
# with the real legacy arbitrator key, the evaluator's immutable, which a fork cannot stand in for.
DEFAULT_CASES="admin-ownership,admin-vault-refusal,admin-fees,hire,cancel,topup-paid,topup-refund,silence,ruling-worker,ruling-worker-slash,ruling-creator,ruling-creator-slash,violation,missed,arbitration-timeout,delegate,slash-pro-rata,undelegate-pending-slash,fees,owed-blocklist,owed-gas,legacy-contest,admin-pause,stake-cooldown"
CASES="${1:-${FLOW_CASES:-$DEFAULT_CASES}}"
PROFILE="g1dry-$(date +%s)"
WORK="$(mktemp -d)"
chmod 700 "$WORK"
MIRROR="$WORK/mirror"
SAFE_FACTORY=0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67
SAFE_L2=0x29fcB43b46531BcA003ddC8FCB67FFE91900C762
FALLBACK_HANDLER=0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99
ZERO=0x0000000000000000000000000000000000000000

# Fresh keys every run, never printed. Not the anvil dev keys: on Monad testnet every one of them carries an EIP-7702
# delegation to a sweeper (code 0xef0100…), which the fork inherits; it forwards any MON sent to it and breaks
# onERC721Received, so the worker's ERC-8004 registration reverts.
newkey() { cast wallet new --json 2>/dev/null | jq -r '(.data? // .) | (if type == "array" then .[0] else . end) | .private_key'; }
addr() { cast wallet address --private-key "$1" 2>/dev/null; }
K_DEPLOYER=$(newkey); K_OWNER1=$(newkey); K_OWNER2=$(newkey); K_ARBITRATOR=$(newkey); K_RELAY=$(newkey)
K_ATTESTER=$(newkey); K_CREATOR=$(newkey); K_WORKER=$(newkey)
for k in "$K_DEPLOYER" "$K_OWNER1" "$K_OWNER2" "$K_ARBITRATOR" "$K_RELAY" "$K_ATTESTER" "$K_CREATOR" "$K_WORKER"; do
  [[ "$k" =~ ^0x[0-9a-fA-F]{64}$ ]] || { echo "could not make a fresh key with cast wallet new" >&2; exit 1; }
done
DEPLOYER=$(addr "$K_DEPLOYER"); OWNER1=$(addr "$K_OWNER1"); OWNER2=$(addr "$K_OWNER2"); ARBITRATOR=$(addr "$K_ARBITRATOR")
RELAY=$(addr "$K_RELAY"); ATTESTER=$(addr "$K_ATTESTER"); CREATOR=$(addr "$K_CREATOR"); WORKER=$(addr "$K_WORKER")

cp "$TRACKED" "$WORK/config.base"
TRACKED_SUM=$(sha256sum <"$TRACKED")

ANVIL_PID= WARPER_PID= SAFE= CONFIG=
cleanup() {
  [[ -n "$WARPER_PID" ]] && kill "$WARPER_PID" 2>/dev/null || true
  [[ -n "$ANVIL_PID" ]] && kill "$ANVIL_PID" 2>/dev/null || true
  owned_file "$CONFIG" .hireling.safe "$SAFE"
  owned_run_dirs
  rm -rf "$WORK"
  [[ "$(sha256sum <"$TRACKED")" == "$TRACKED_SUM" ]] || echo "WARNING: $TRACKED changed during the run (not by it); check it" >&2
}
trap cleanup EXIT
rehearsal_run
REAL_LOGS=$(real_logs "$CHAIN")
CONFIG="config/$NETWORK.json"
[[ ! -e "$CONFIG" ]] || { echo "refusing: $CONFIG exists" >&2; exit 1; }
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }
rpc() { cast rpc --rpc-url "$LOCAL" "$@" >/dev/null 2>&1 || { echo "fork RPC $1 failed" >&2; return 1; }; }

# The fork must be this run's own anvil: refuse a port something else already serves.
cast chain-id --rpc-url "$LOCAL" >/dev/null 2>&1 && fail "port $PORT already serves an RPC; stop it, or set PORT"
anvil --fork-url "$FORK_RPC" --network monad --port "$PORT" --block-time 1 --silent 9>&- &
ANVIL_PID=$!
for _ in $(seq 60); do cast chain-id --rpc-url "$LOCAL" >/dev/null 2>&1 && break; sleep 1; done
[[ "$(cast chain-id --rpc-url "$LOCAL" 2>/dev/null)" == "$CHAIN" ]] || fail "anvil fork of chain $CHAIN not up"
kill -0 "$ANVIL_PID" 2>/dev/null || fail "the anvil this run started is not running (port $PORT taken?)"
for a in $DEPLOYER $OWNER1 $ARBITRATOR $RELAY $CREATOR $WORKER; do rpc anvil_setBalance "$a" 0x3635c9adc5dea00000; done # 1,000 MON

# 1. Safe, then the launch into the scratch config.
SETUP=$(cast calldata "setup(address[],uint256,address,bytes,address,address,uint256,address)" "[$OWNER1,$OWNER2]" 1 $ZERO 0x $FALLBACK_HANDLER $ZERO 0 $ZERO)
SALT=$(date +%s)
SAFE=$(cast call --rpc-url "$LOCAL" --from "$DEPLOYER" $SAFE_FACTORY "createProxyWithNonce(address,bytes,uint256)(address)" $SAFE_L2 "$SETUP" "$SALT" 2>/dev/null)
cast send --rpc-url "$LOCAL" --private-key "$K_DEPLOYER" $SAFE_FACTORY "createProxyWithNonce(address,bytes,uint256)" $SAFE_L2 "$SETUP" "$SALT" >/dev/null 2>&1
# On testnet the deployer is roles.admin, which holds the reused core's DEFAULT_ADMIN_ROLE, so launch-testnet.sh's
# pauser step can grant the Safe ADMIN_ROLE. Here the deployer is a fresh key, so roles.admin (impersonated, on the fork
# only) first makes it the core's admin too; the grant to the Safe is then launch-testnet.sh's own transaction.
CORE=$(jq -r .deployment.core "$WORK/config.base")
REAL_ADMIN=$(jq -r .roles.admin "$WORK/config.base")
DEFAULT_ADMIN_ROLE=0x0000000000000000000000000000000000000000000000000000000000000000
[[ "$(cast call --rpc-url "$LOCAL" "$CORE" "hasRole(bytes32,address)(bool)" $DEFAULT_ADMIN_ROLE "$REAL_ADMIN" 2>/dev/null)" == true ]] \
  || fail "roles.admin $REAL_ADMIN is not the core's DEFAULT_ADMIN_ROLE on testnet"
rpc anvil_impersonateAccount "$REAL_ADMIN"; rpc anvil_setBalance "$REAL_ADMIN" 0x3635c9adc5dea00000
cast send --rpc-url "$LOCAL" --unlocked --from "$REAL_ADMIN" "$CORE" "grantRole(bytes32,address)" $DEFAULT_ADMIN_ROLE "$DEPLOYER" \
  >/dev/null 2>&1 || fail "could not make the fork deployer the core's admin"
rpc anvil_stopImpersonatingAccount "$REAL_ADMIN"
# Prepare the pristine G1b copy before fixture overrides: the archive identity includes the original roles.
cp "$WORK/config.base" "$CONFIG"
export FLOW_RPC="$LOCAL"
prepare_rehearsal_redeploy "$CONFIG" "$FOUNDRY_BROADCAST/monad-testnet-g1b.json" "$WORK/config.base" FLOW_RPC \
  || fail "G1b redeploy preparation"
ok "G1b archived verbatim; fresh deployment outputs removed; core and legacy pairs preserved"
jq --arg safe "$SAFE" --arg admin "$DEPLOYER" --arg relay "$RELAY" --arg attester "$ATTESTER" --arg arb "$ARBITRATOR" \
  --arg c "$CREATOR" --arg w "$WORKER" '
  .roles = { admin: $admin, relay: $relay, attester: $attester, arbitrator: $arb }
  | .hireling.safe = $safe | .hireling.defaultArbitrator = $arb | .hireling.schedule.treasury = $safe
  | .hireling.allocation = { treasury: $safe, ecosystem: $admin, liquidity: $admin }
  | .oddTokens = { wallets: [$c, $w], mint: 1000 }' "$CONFIG" >"$WORK/prepared-fixture.json"
cp "$WORK/prepared-fixture.json" "$CONFIG"
export FLOW_RPC="$LOCAL" FLOW_DEPLOYER_KEY="$K_DEPLOYER" FLOW_SAFE_OWNER_KEY="$K_OWNER1"
env RPC_ENV=FLOW_RPC DEPLOYER_KEY_ENV=FLOW_DEPLOYER_KEY SAFE_OWNER_KEY_ENV=FLOW_SAFE_OWNER_KEY LAUNCH_LOGS="$WORK/launch" \
  bash script/launch-testnet.sh --yes --private-keys --fee-proposal --holding-probe >"$WORK/launch.out" 2>&1 \
  || { tail -30 "$WORK/launch.out"; fail "launch-testnet.sh"; }
grep -q "LAUNCH-TESTNET DONE" "$WORK/launch.out" || fail "launch-testnet.sh did not finish"
ADMIN_ROLE=$(cast call --rpc-url "$LOCAL" "$CORE" "ADMIN_ROLE()(bytes32)" 2>/dev/null)
[[ "$(cast call --rpc-url "$LOCAL" "$CORE" "hasRole(bytes32,address)(bool)" "$ADMIN_ROLE" "$SAFE" 2>/dev/null)" == true ]] \
  || fail "launch-testnet.sh did not give the Safe the core's ADMIN_ROLE"
ok "v1 deployed on the fork and promoted into $CONFIG (Safe $SAFE holds the core's ADMIN_ROLE; fee proposal and Holding probe made)"

# 2. deployment.oddTokens, and the wallets' tokens.
ODD="$FOUNDRY_BROADCAST/DeployOddTokens.s.sol/$CHAIN/run-latest.json"
jq --arg b "$(jq -r '[.transactions[] | select(.contractName == "BlocklistUSD")][0].contractAddress' "$ODD")" \
  --arg g "$(jq -r '[.transactions[] | select(.contractName == "GasBurnerUSD")][0].contractAddress' "$ODD")" \
  --argjson block "$(cast to-dec "$(jq -r '.receipts[0].blockNumber' "$ODD")")" \
  '.deployment.oddTokens = { blocklist: $b, gasBurner: $g, block: $block }' "$CONFIG" >"$WORK/config.next" && cp "$WORK/config.next" "$CONFIG"
FACTORY=$(jq -r .deployment.hireling.factory "$CONFIG")
for w in $CREATOR $WORKER; do
  cast send --rpc-url "$LOCAL" --private-key "$K_DEPLOYER" "$FACTORY" "transfer(address,uint256)" "$w" 50000000000000000000000 >/dev/null 2>&1 \
    || fail "FACTORY to $w"
done
MUSD=$(jq -r '.deployment.rewardTokens[0]' "$CONFIG")
rpc anvil_dealERC20 "$CREATOR" "$MUSD" 0x3b9aca00 # 1,000 mUSD (6 decimals)
[[ "$(cast call --rpc-url "$LOCAL" "$MUSD" "balanceOf(address)(uint256)" "$CREATOR" 2>/dev/null | awk '{print $1}')" -ge 1000000000 ]] \
  || fail "could not deal mUSD to the creator on the fork"
# Fund the actual legacy open-token pair preserved by preparation, rather than the archived G1b v1 main pair.
LEGACY_HOLDING=$(jq -r '[.deployment.legacy[] | select(.kind == "legacy" and .openTokens == true)][0].holding // empty' "$CONFIG")
[[ -n "$LEGACY_HOLDING" ]] || fail "no configured legacy open-token pair"
FACTORY_V1=$(cast call --rpc-url "$LOCAL" "$LEGACY_HOLDING" "factory()(address)" 2>/dev/null)
[[ "${FACTORY_V1,,}" != "${FACTORY,,}" ]] || fail "the legacy pair uses the new FACTORY?"
for w in $CREATOR $WORKER; do
  rpc anvil_dealERC20 "$w" "$FACTORY_V1" 0x56bc75e2d63100000 # 100 FACTORY v1
  [[ "$(cast call --rpc-url "$LOCAL" "$FACTORY_V1" "balanceOf(address)(uint256)" "$w" 2>/dev/null | awk '{print $1}')" == 100000000000000000000 ]] \
    || fail "could not deal FACTORY v1 to $w on the fork"
done
ok "creator and worker hold 50,000 fresh-stack FACTORY and 100 legacy FACTORY; the creator holds 1,000 mUSD; deployment.oddTokens recorded"
if [[ -n "${HOLD:-}" ]]; then # HOLD=<file>: pause here, fork up and config promoted, until the file is removed
  touch "$HOLD"; echo "holding: fork $LOCAL, config $PWD/$CONFIG; remove $HOLD to run the cases"
  while [[ -e "$HOLD" ]]; do sleep 2; done
fi

# 3. The runner, one case per process, isolated from every .env file and real key. It and the SDK import
# ../../../contracts/config/monad-testnet.json, so they run from a mirror where that path is the scratch config.
mkdir -p "$MIRROR/packages/sdk" "$MIRROR/contracts/config"
cp -r "$REPO/packages/sdk/src" "$MIRROR/packages/sdk/src"
cp "$REPO/packages/sdk/package.json" "$MIRROR/packages/sdk/"
# The runner and its siblings, never a real journal (.v1-flows holds signed transactions).
(cd "$REPO/packages/sdk" && tar --exclude=./scripts/.v1-flows -cf - ./scripts) | (cd "$MIRROR/packages/sdk" && tar -xf -)
[[ ! -e "$MIRROR/packages/sdk/scripts/.v1-flows" ]] || fail "a real flow journal reached the mirror"
ln -s "$REPO/packages/sdk/node_modules" "$MIRROR/packages/sdk/node_modules"
cp "$REPO/contracts/config/monad-mainnet.json" "$MIRROR/contracts/config/"
cp "$CONFIG" "$MIRROR/contracts/config/monad-testnet.json"
diff -r "$REPO/packages/sdk/src" "$MIRROR/packages/sdk/src" >/dev/null && diff -r -x .v1-flows "$REPO/packages/sdk/scripts" \
  "$MIRROR/packages/sdk/scripts" >/dev/null || fail "the SDK mirror differs from packages/sdk"
[[ "$LOCAL" == http://127.0.0.1:* ]] || fail "the runner RPC must be the loopback fork"
runner() { # <case> [profile]
  (cd "$WORK" && env -i PATH="$PATH" HOME="$HOME" NO_COLOR=1 MONAD_TESTNET_RPC_URL="$LOCAL" V1_FLOW_PROFILE="${2:-$PROFILE}" \
    TESTNET_CREATOR_PRIVATE_KEY="$K_CREATOR" TESTNET_WORKER_PRIVATE_KEY="$K_WORKER" RELAY_PRIVATE_KEY="$K_RELAY" \
    V1_ARBITRATOR_PRIVATE_KEY="$K_ARBITRATOR" SAFE_BACKUP_TESTNET_PRIVATE_KEY="$K_OWNER1" TESTNET_ODD_OWNER_PRIVATE_KEY="$K_DEPLOYER" \
    timeout 1200 bun --no-env-file "$MIRROR/packages/sdk/scripts/v1-flows.ts" "$1")
}
# Warp whatever chain time the runner says it is waiting for. run_case bumps case.id, which resets the count.
warper() {
  local seen=0 gen="" line count wait
  while true; do
    if [[ "$(cat "$WORK/case.id" 2>/dev/null)" != "$gen" ]]; then gen=$(cat "$WORK/case.id" 2>/dev/null); seen=0; fi
    count=$(grep -ac "waiting [0-9]*s of chain time" "$WORK/current.log" 2>/dev/null || true)
    if [[ "${count:-0}" -gt "$seen" ]]; then
      seen=$count
      line=$(grep -a "waiting [0-9]*s of chain time" "$WORK/current.log" | tail -1)
      wait=$(sed -E 's/.*waiting ([0-9]+)s of chain time.*/\1/' <<<"$line")
      rpc evm_increaseTime $((wait + 2)) && rpc evm_mine
    fi
    sleep 1
  done
}
: >"$WORK/current.log"
echo 0 >"$WORK/case.id"
warper 9>&- &
WARPER_PID=$!

: >"$WORK/results.tsv"
run_case() { # <case> [label] [profile]
  local name=$1 label=${2:-$1} start=$SECONDS status
  : >"$WORK/current.log"
  echo "$label" >"$WORK/case.id"
  if runner "$name" "${3:-}" >"$WORK/current.log" 2>&1; then status=PASS; else status=FAIL; fi
  local detail=""
  if [[ $status == FAIL ]]; then detail=$(grep -av '^\[' "$WORK/current.log" | grep -av "journal preserved" | tail -1 | cut -c1-160 || true); fi
  { grep -ao "monadscan.com/tx/0x[0-9a-f]\{64\}" "$WORK/current.log" || true; } | sed 's|.*/tx/||' | awk -v c="$label" '!s[$0]++ { print c "\t" $0 }' >>"$WORK/hashes.tsv"
  cp "$WORK/current.log" "$WORK/case-$label.log"
  printf '%s\t%s\t%s\t%s\n' "$label" "$status" "$((SECONDS - start))" "$detail" >>"$WORK/results.tsv"
  printf '  %-26s %s  (%ss) %s\n' "$label" "$status" "$((SECONDS - start))" "$detail"
}
: >"$WORK/hashes.tsv"; : >"$WORK/gas.tsv"
echo "cases (profile $PROFILE):"
IFS=',' read -ra LIST <<<"$CASES"
for name in "${LIST[@]}"; do
  run_case "$name"
done

# 4. Gas per wallet: the limit each transaction was sent with (charged on Monad) and gasUsed.
declare -A ROLE_OF=([${DEPLOYER,,}]="deployer / odd-token owner" [${OWNER1,,}]="Safe owner" [${CREATOR,,}]=creator
  [${WORKER,,}]=worker [${RELAY,,}]=relay [${ARBITRATOR,,}]=arbitrator)
gas_of() { # <hashes.tsv> <out.tsv>: label, wallet, gas limit, gas used, hash
  local label hash from gas used
  while IFS=$'\t' read -r label hash; do
    from=$(cast tx --rpc-url "$LOCAL" "$hash" from 2>/dev/null | tr 'A-F' 'a-f') || continue
    gas=$(cast tx --rpc-url "$LOCAL" "$hash" gas 2>/dev/null)
    used=$(cast receipt --rpc-url "$LOCAL" "$hash" gasUsed 2>/dev/null)
    printf '%s\t%s\t%s\t%s\t%s\n' "$label" "${ROLE_OF[$from]:-$from}" "$gas" "$used" "$hash" >>"$2"
  done <"$1"
}
gas_of "$WORK/hashes.tsv" "$WORK/gas.tsv"
: >"$WORK/launch-gas.tsv"
gas_of "$WORK/launch/hashes.tsv" "$WORK/launch-gas.tsv"
PRICE=$(cast gas-price --rpc-url "$FORK_RPC" 2>/dev/null || echo 0)
echo
per_wallet() {
  printf '  %-28s %5s %13s %13s %11s %11s\n' wallet txs "gas limit" "gas used" "MON@102" "MON@2xnow"
  awk -F'\t' -v p="$PRICE" '{ n[$2]++; l[$2]+=$3; u[$2]+=$4 } END { for (w in n) printf "  %-28s %5d %13d %13d %11.4f %11.4f\n", w, n[w], l[w], u[w], l[w]*102e-9, l[w]*2*p/1e18 }' \
    "$1" 2>/dev/null | sort
}
echo "GAS PER WALLET, LAUNCH (launch-testnet.sh; Monad charges the limit; testnet gas price now $(cast from-wei "$PRICE" gwei 2>/dev/null | cut -c1-6) gwei)"
per_wallet "$WORK/launch-gas.tsv"
awk -F'\t' '$1 ~ /^pauser/ { printf "  of which %s: gas limit %d, used %d\n", $1, $3, $4 }' "$WORK/launch-gas.tsv"
echo
echo "GAS PER WALLET, FLOWS"
per_wallet "$WORK/gas.tsv"
echo
echo "GAS PER CASE"
awk -F'\t' '{ n[$1]++; l[$1]+=$3 } END { for (c in n) printf "  %-30s %4d txs %12d gas\n", c, n[c], l[c] }' "$WORK/gas.tsv" 2>/dev/null | sort
echo
echo "DEPLOY (launch-testnet.sh): $(wc -l <"$WORK/launch/hashes.tsv") transactions, listed in its own output"
pass=$(awk -F'\t' '$2 == "PASS"' "$WORK/results.tsv" | wc -l); total=$(wc -l <"$WORK/results.tsv")
[[ "$(real_logs "$CHAIN")" == "$REAL_LOGS" ]] || fail "a chain-$CHAIN forge log outside this run's directories changed"
ok "no chain-$CHAIN forge log outside $FOUNDRY_BROADCAST and $FOUNDRY_CACHE_PATH was touched"
echo "RESULT: $pass/$total cases passed"
mkdir -p /tmp/g1-dry && cp "$WORK/results.tsv" "$WORK/gas.tsv" "$WORK/launch-gas.tsv" /tmp/g1-dry/ 2>/dev/null && cp "$WORK"/case-*.log /tmp/g1-dry/ 2>/dev/null || true
echo "per-case logs and tables copied to /tmp/g1-dry/"
[[ $pass -eq $total ]]
exit
}
