#!/usr/bin/env bash
# R7: the mainnet launch, end to end, on a throwaway anvil fork of Monad mainnet (chain 143), Monad gas pricing.
# Steps, in launch order (docs/mainnet-runbook.md, D16):
#   1. a 1-of-2 Safe from the canonical v1.4.1 SafeProxyFactory + SafeL2 singleton (their code is checked first);
#   2. DeployHireling with a fresh core and MAINNET_GO;
#   3. PromoteHireling (no transactions), then the D16 launch gate, which must refuse: the six are only pending;
#   4. SafeAccept (six execTransactions from an owner), then the D16 gate, which must pass;
#   5. SeedPool (helper, approvals, seed) and its receipt-based verify();
#   6. one direct hire through the v1 pair (register, stake, publish, activate, submit, accept, settle);
#   7. mining: warp past epoch 0; a Safe owner signs the price list (a throwaway keystore), scripts/mining computes the
#      epoch from the fork's logs, the Safe sends the tool's fund + setRoot, and the worker's and creator's claims stake.
# Every step's gas (the limits actually sent, which Monad charges, and gasUsed) is printed as the launch budget.
# Sends nothing to a real chain: anvil's public dev keys sign everything, against a local fork. Writes a scratch
# config/rehearsal-mainnet.json and chain-143 broadcast logs, and removes both on exit; refuses to start if any
# chain-143 broadcast log already exists (a real deploy's). Needs anvil, forge, cast, jq, bun.
#   RPC=https://rpc.monad.xyz bash script/rehearse-launch.sh
set -euo pipefail
{ # parsed whole before it runs, so an edit to this file mid-run cannot change what runs
cd "$(dirname "$0")/.."

FORK_RPC="${RPC:-https://rpc.monad.xyz}"
PORT="${PORT:-8598}"
LOCAL="http://127.0.0.1:$PORT"
export NETWORK=rehearsal-mainnet
CONFIG="config/$NETWORK.json"
CANDIDATE="broadcast/hireling/$NETWORK.candidate.json"
CHAIN=143
SCRIPTS=(DeployHireling PromoteHireling SafeAccept SeedPool RehearseHireAndMine)
BUDGET="$(mktemp)"
GATE_TS="$(mktemp --suffix=.ts)"
MINING="$(mktemp -d)"
REPO="$(cd .. && pwd)"

# Canonical Safe v1.4.1 on chain 143.
SAFE_FACTORY=0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67
SAFE_L2=0x29fcB43b46531BcA003ddC8FCB67FFE91900C762
FALLBACK_HANDLER=0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99
ZERO=0x0000000000000000000000000000000000000000
USDC=$(jq -r .liquidity.quote config/monad-mainnet.json)

# anvil's public development keys, derived from its well-known mnemonic; never real funds.
MNEMONIC="test test test test test test test test test test test junk"
devkey() { cast wallet private-key --mnemonic "$MNEMONIC" --mnemonic-index "$1"; }
K_DEPLOYER=$(devkey 0); K_OWNER1=$(devkey 1); K_OWNER2=$(devkey 2); K_ARBITRATOR=$(devkey 3); K_RELAY=$(devkey 4)
K_ATTESTER=$(devkey 5); K_CREATOR=$(devkey 6); K_WORKER=$(devkey 7); K_TEAM=$(devkey 8)
addr() { cast wallet address --private-key "$1"; }

for s in "${SCRIPTS[@]}"; do
  if [[ -e "broadcast/$s.s.sol/$CHAIN" || -e "cache/$s.s.sol/$CHAIN" ]]; then
    echo "refusing: broadcast/ or cache/$s.s.sol/$CHAIN exists (a real chain-143 log?); move it away first" >&2
    exit 1
  fi
done
[[ ! -e "$CONFIG" ]] || { echo "refusing: $CONFIG exists" >&2; exit 1; }

ANVIL_PID= SAFE=
. script/rehearse-owned.sh
# Only what this run created: a real launch from the same checkout writes the same chain-143 broadcast paths.
cleanup() {
  [[ -n "$ANVIL_PID" ]] && kill "$ANVIL_PID" 2>/dev/null || true
  owned_runs "$CHAIN" "$LOCAL" $(for i in $(seq 0 9); do addr "$(devkey "$i")"; done)
  owned_file "$CONFIG" .hireling.safe "$SAFE"
  owned_file "$CANDIDATE" .safe "$SAFE"
  rm -f "$GATE_TS" "$BUDGET"
  rm -rf "$MINING"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }
log() { local f=$1; shift; "$@" >"$f" 2>&1 || { tail -30 "$f"; return 1; }; }

# Gas of one broadcast run, from the node: the limit each transaction was sent with (charged on Monad) and gasUsed.
record() { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >>"$BUDGET"; }
budget_hashes() {
  local label=$1 tl=0 tu=0 n=0 h
  shift
  for h in "$@"; do
    case "$(cast receipt --rpc-url "$LOCAL" "$h" status)" in true | 1 | "1 (success)") ;; *) fail "$label: a failed receipt" ;; esac
    tl=$((tl + $(cast tx --rpc-url "$LOCAL" "$h" gas)))
    tu=$((tu + $(cast receipt --rpc-url "$LOCAL" "$h" gasUsed)))
    n=$((n + 1))
  done
  record "$label" "$n" "$tl" "$tu"
}
budget_run() { mapfile -t hashes < <(jq -r '.receipts[].transactionHash' "broadcast/$2.s.sol/$CHAIN/run-latest.json"); budget_hashes "$1" "${hashes[@]}"; }

# D16 launch gate (apps/api/src/prod-config.ts) against the fork, with the scratch config and the shared
# RELAY_FLOOR_MAINNET (packages/sdk/src/relay.ts). Prints the failure labels; exit 3 when it refuses. Run with bun, as the
# prod preflight is (the SDK uses TypeScript that node's strip-only mode refuses).
cat >"$GATE_TS" <<EOF
import { readFileSync } from 'node:fs'
import { RELAY_FLOOR_MAINNET } from '$REPO/packages/sdk/src/relay.ts'
import { liveLaunchGate } from '$REPO/apps/api/src/prod-config.ts'
import { rpcReader } from '$REPO/apps/api/src/deploy-preflight.ts'
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const failures = await liveLaunchGate(config, rpcReader(process.argv[3]), RELAY_FLOOR_MAINNET)
console.log(JSON.stringify(failures))
process.exit(failures.length > 0 ? 3 : 0)
EOF
gate() { bun "$GATE_TS" "$CONFIG" "$LOCAL"; }

# The fork must be this run's own anvil: refuse a port something else already serves.
cast chain-id --rpc-url "$LOCAL" >/dev/null 2>&1 && fail "port $PORT already serves an RPC; stop it, or set PORT"
anvil --fork-url "$FORK_RPC" --network monad --port "$PORT" --block-time 1 --silent &
ANVIL_PID=$!
for _ in $(seq 60); do cast chain-id --rpc-url "$LOCAL" >/dev/null 2>&1 && break; sleep 1; done
[[ "$(cast chain-id --rpc-url "$LOCAL")" == "$CHAIN" ]] || fail "anvil fork of chain 143 not up"
kill -0 "$ANVIL_PID" 2>/dev/null || fail "the anvil this run started is not running (port $PORT taken?)"

DEPLOYER=$(addr $K_DEPLOYER); OWNER1=$(addr $K_OWNER1); OWNER2=$(addr $K_OWNER2)
ARBITRATOR=$(addr $K_ARBITRATOR); RELAY=$(addr $K_RELAY); ATTESTER=$(addr $K_ATTESTER); TEAM=$(addr $K_TEAM)
for k in $K_DEPLOYER $K_OWNER1 $K_OWNER2 $K_RELAY $K_CREATOR $K_WORKER; do
  cast rpc --rpc-url "$LOCAL" anvil_setBalance "$(addr "$k")" 0x21e19e0c9bab2400000 >/dev/null # 10,000 MON
done
# The dev keys are public, and on Monad (mainnet and testnet) each carries someone's EIP-7702 delegation; the fork
# inherits it. Clear it, so they behave as the plain EOAs the real launch signs from.
for k in $K_DEPLOYER $K_OWNER1 $K_OWNER2 $K_ARBITRATOR $K_RELAY $K_ATTESTER $K_CREATOR $K_WORKER $K_TEAM; do
  cast rpc --rpc-url "$LOCAL" anvil_setCode "$(addr "$k")" 0x >/dev/null
done

# 1. The Safe.
for c in $SAFE_FACTORY $SAFE_L2 $FALLBACK_HANDLER; do
  [[ "$(cast code --rpc-url "$LOCAL" $c)" != "0x" ]] || fail "no code at canonical Safe contract $c on chain 143"
done
SETUP=$(cast calldata "setup(address[],uint256,address,bytes,address,address,uint256,address)" "[$OWNER1,$OWNER2]" 1 $ZERO 0x $FALLBACK_HANDLER $ZERO 0 $ZERO)
SALT=$(date +%s)
SAFE=$(cast call --rpc-url "$LOCAL" --from "$DEPLOYER" $SAFE_FACTORY "createProxyWithNonce(address,bytes,uint256)(address)" $SAFE_L2 "$SETUP" "$SALT")
TX=$(cast send --rpc-url "$LOCAL" --private-key $K_DEPLOYER --json $SAFE_FACTORY "createProxyWithNonce(address,bytes,uint256)" $SAFE_L2 "$SETUP" "$SALT" | jq -r .transactionHash)
budget_hashes "1. Safe (1-of-2, SafeProxyFactory)" "$TX"
[[ "$(cast call --rpc-url "$LOCAL" "$SAFE" "getThreshold()(uint256)")" == "1" ]] || fail "Safe threshold"
[[ "$(cast call --rpc-url "$LOCAL" "$SAFE" "VERSION()(string)")" == '"1.4.1"' ]] || fail "Safe version"
ok "Safe $SAFE (1.4.1, owners $OWNER1 $OWNER2, threshold 1)"

# The scratch config: mainnet's, with the fork's roles, the Safe and a v1 hireling block.
jq --arg safe "$SAFE" --arg admin "$DEPLOYER" --arg relay "$RELAY" --arg attester "$ATTESTER" \
  --arg arbitrator "$ARBITRATOR" --arg team "$TEAM" '
  .roles = { admin: $admin, relay: $relay, attester: $attester, arbitrator: $arbitrator }
  | .hireling = {
      reuseCore: false, safe: $safe, defaultArbitrator: $arbitrator, margin: 3600,
      schedule: { thresholds: [0, 10000, 100000, 1000000], bps: [3000, 1000, 300, 100], treasury: $safe },
      allocation: { treasury: $safe, ecosystem: $safe, liquidity: $admin },
      vesting: { beneficiary: $team, startOffset: 31536000, duration: 94608000, cliff: 0 },
      mining: { genesis: 0 } }
  | .liquidity.positionOwner = $safe
  | .deployment = {}' config/monad-mainnet.json >"$CONFIG"

# 2. DeployHireling (fresh core).
log /tmp/r7-deploy.log env MAINNET_GO=yes forge script script/DeployHireling.s.sol --rpc-url "$LOCAL" \
  --private-key $K_DEPLOYER --broadcast --slow || fail "DeployHireling"
budget_run "2. DeployHireling (fresh core)" DeployHireling
ok "deployed ($(jq '.transactions | length' broadcast/DeployHireling.s.sol/$CHAIN/run-latest.json) transactions)"

# 3. PromoteHireling, then the D16 gate: pending ownership must not open.
log /tmp/r7-promote.log forge script script/PromoteHireling.s.sol --rpc-url "$LOCAL" || fail "PromoteHireling"
record "3. PromoteHireling (reads; writes config)" 0 0 0
[[ "$(jq -r .deployment.main.kind "$CONFIG")" == "hireling-v1" ]] || fail "promotion did not record the v1 pair"
[[ "$(jq -r .deployment.hireling.safe "$CONFIG")" == "$SAFE" ]] || fail "promotion did not record the Safe"
set +e; REFUSED=$(gate); CODE=$?; set -e
[[ $CODE -eq 3 ]] || fail "D16 gate opened before the Safe accepted ($REFUSED)"
[[ "$(jq length <<<"$REFUSED")" == 6 && "$(jq '[.[] | select(endswith("is not the Safe"))] | length' <<<"$REFUSED")" == 6 ]] \
  || fail "D16 gate refused for other reasons: $REFUSED"
ok "promoted; D16 gate refuses with the six handovers pending"

# 4. SafeAccept, then the D16 gate passes.
log /tmp/r7-accept.log env MAINNET_GO=yes forge script script/SafeAccept.s.sol --rpc-url "$LOCAL" \
  --private-key $K_OWNER1 --broadcast --slow || fail "SafeAccept"
budget_run "4. SafeAccept (6 execTransactions)" SafeAccept
log /tmp/r7-accept-check.log forge script script/SafeAccept.s.sol --sig "check()" --rpc-url "$LOCAL" || fail "SafeAccept check"
gate >/tmp/r7-gate.log || fail "D16 gate refused after SafeAccept: $(cat /tmp/r7-gate.log)"
ok "the Safe owns all six; D16 gate passes (Safe custody, core roles, verifier, relay above RELAY_FLOOR_MAINNET)"

# 5. SeedPool and its receipt-based verification. The seeder holds the liquidity allocation; USDC is dealt.
# Monad's USDC is Circle's FiatToken v2 (balances at storage slot 9); anvil_dealERC20 cannot find the slot.
cast rpc --rpc-url "$LOCAL" anvil_setStorageAt "$USDC" "$(cast index address "$DEPLOYER" 9)" \
  "$(cast to-uint256 1000000000)" >/dev/null
[[ "$(cast call --rpc-url "$LOCAL" "$USDC" "balanceOf(address)(uint256)" "$DEPLOYER" | awk '{print $1}')" == 1000000000 ]] \
  || fail "could not give the seeder 1000 USDC on the fork"
log /tmp/r7-seed.log env MAINNET_GO=yes forge script script/SeedPool.s.sol --rpc-url "$LOCAL" \
  --private-key $K_DEPLOYER --broadcast --slow || fail "SeedPool"
budget_run "5. SeedPool (helper, 2 approvals, seed)" SeedPool
log /tmp/r7-seed-verify.log forge script script/SeedPool.s.sol --sig "verify()" --rpc-url "$LOCAL" || fail "SeedPool verify"
ok "pool seeded; $(grep -o 'position token id [0-9]*' /tmp/r7-seed-verify.log) verified from the receipts"

# 6. One direct hire.
log /tmp/r7-hire.log env MAINNET_GO=yes DEPLOYER_KEY=$K_DEPLOYER CREATOR_KEY=$K_CREATOR WORKER_KEY=$K_WORKER \
  forge script script/RehearseHireAndMine.s.sol --tc RehearseHire --rpc-url "$LOCAL" --broadcast --slow || fail "hire"
budget_run "6. One hire (fund, register, stake, publish, activate, submit, accept, settle)" RehearseHireAndMine
ok "hire settled ($(grep -o 'net to worker [0-9]*' /tmp/r7-hire.log))"

# 7. Mining epoch 0.
RESERVE=$(jq -r .deployment.hireling.miningReserve "$CONFIG")
END=$(cast call --rpc-url "$LOCAL" "$RESERVE" "epochEnd(uint256)(uint256)" 0 | awk '{print $1}')
NOW=$(cast block --rpc-url "$LOCAL" latest -f timestamp)
cast rpc --rpc-url "$LOCAL" evm_increaseTime $((END - NOW + 60)) >/dev/null
cast rpc --rpc-url "$LOCAL" evm_mine >/dev/null
# mining:epoch reads only up to the finalized head, which on anvil trails latest by 64 blocks.
cast rpc --rpc-url "$LOCAL" anvil_mine 0x41 >/dev/null
# The B8 tool, as the coordinator runs it: the price list signed from a keystore (USDC at $1, FACTORY at $0.0001), then
# the epoch from chain logs alone.
chmod 700 "$MINING"
(umask 077; printf 'r7-%s%s' "$RANDOM" "$RANDOM" >"$MINING/password")
cast wallet import --keystore-dir "$MINING" owner --private-key "$K_OWNER1" --unsafe-password "$(cat "$MINING/password")" >/dev/null 2>&1
printf '{"epoch":"0","tokens":[{"token":"%s","decimals":6,"usdPrice":"1000000000000000000"}],"factoryUsdPrice":"100000000000000"}\n' \
  "$USDC" >"$MINING/unsigned.json"
log /tmp/r7-prices.log bun ../scripts/mining/sign-prices.ts "$MINING/unsigned.json" --network monad-mainnet --config "$PWD/$CONFIG" \
  --out "$MINING/prices.json" --keystore "$MINING/owner" --password-file "$MINING/password" || fail "sign the price list"
log /tmp/r7-epoch.log bun ../scripts/mining/epoch.ts 0 --network monad-mainnet --config "$PWD/$CONFIG" --rpc "$LOCAL" \
  --prices "$MINING/prices.json" --out "$MINING" || fail "mining:epoch"
EPOCH="$MINING/epoch-0.json"
[[ "$(jq '[.inputs.fees[] | select(.status == "counted")] | length' "$EPOCH")" -ge 1 ]] || fail "the tool counted no fee from the hire"
claim() { jq -r --arg a "$(addr "$1" | tr 'A-F' 'a-f')" ".claims[\$a].$2 | if type == \"array\" then join(\",\") else . end" "$EPOCH"; }
log /tmp/r7-mine.log env MAINNET_GO=yes SAFE_OWNER_KEY=$K_OWNER1 WORKER_KEY=$K_WORKER CREATOR_KEY=$K_CREATOR \
  FUND_DATA="$(jq -r .calls.fund.data "$EPOCH")" SETROOT_DATA="$(jq -r .calls.setRoot.data "$EPOCH")" \
  WORKER_AMOUNT="$(claim $K_WORKER amount)" WORKER_PROOF="$(claim $K_WORKER proof)" \
  CREATOR_AMOUNT="$(claim $K_CREATOR amount)" CREATOR_PROOF="$(claim $K_CREATOR proof)" \
  forge script script/RehearseHireAndMine.s.sol --tc RehearseMining --rpc-url "$LOCAL" --broadcast --slow || fail "mining"
budget_run "7. Mining epoch 0 (fund + setRoot via Safe, two claims → stake)" RehearseHireAndMine
ok "epoch 0 by scripts/mining: $(jq -r .total "$EPOCH") FACTORY wei over $(jq '.claims | length' "$EPOCH") leaves, root $(jq -r .root "$EPOCH" | cut -c1-14)…; funded, root set, both claims staked"

echo
echo "LAUNCH BUDGET (Monad charges the gas limit; MON at 102 gwei now, and at forge's 203 gwei max fee)"
printf '%-78s %4s %12s %12s %10s %10s\n' step txs "gas limit" "gas used" "MON@102" "MON@203"
awk -F'\t' '{ printf "%-78s %4d %12d %12d %10.4f %10.4f\n", $1, $2, $3, $4, $3*102e-9, $3*203e-9; n+=$2; l+=$3; u+=$4 }
  END { printf "%-78s %4d %12d %12d %10.4f %10.4f\n", "total", n, l, u, l*102e-9, l*203e-9 }' "$BUDGET"
echo "LAUNCH REHEARSAL PASSED"
exit
}
