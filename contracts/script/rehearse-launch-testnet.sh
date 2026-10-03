#!/usr/bin/env bash
# The G1 rehearsal: script/launch-testnet.sh, unchanged, against a throwaway anvil fork of Monad testnet (chain 10143,
# Monad gas pricing), signing from throwaway encrypted keystores of anvil's public dev keys (as mainnet signs), with a
# fresh 1-of-2 Safe in a scratch config; dev0 stands in for roles.admin as the reused core's admin, so the launch's
# pauser step grants the Safe ADMIN_ROLE. Then, on the fork:
#   - no signer, or a password file others can read, refuses; a chain-143 RPC refuses before anything is sent (with
#     the --private-keys fallback); a launch started from outside while this rehearsal runs refuses (the launch lock);
#     a second launch refuses;
#   - --from pauser --to sdk re-reads cleanly (the Safe already holds ADMIN_ROLE: nothing sent);
#   - a Safe with a module, or with a guard, refuses (the mining fund's nonce guard, D18, needs neither);
#   - at their immutable ETAs anyone executes the fee schedule and accepts the probed Holding.
# Prints the gas limits each sender is charged. Holds the launch lock (script/launch-lock.sh), so it refuses while
# another launch or rehearsal runs in this checkout. Writes only its own scratch config/rehearsal-<pid>-<random>.json
# and forge logs under broadcast/ and cache/rehearsal-<pid>-<random> (script/rehearse-owned.sh), never a real launch's
# chain-10143 run-latest.json, and removes them on exit. Needs anvil, forge, cast, jq, bun, bc, perl.
#   bash script/rehearse-launch-testnet.sh            # RPC=<testnet RPC to fork>, default the public one
#   KEEP=1 bash script/rehearse-launch-testnet.sh     # stop after the launch, leaving the fork running and the promoted
#                                                     # scratch config and forge directories in place (it prints them;
#                                                     # fee proposal and Holding probe still pending), for a harness to
#                                                     # run against; the lock is released
# The anvil dev accounts' EIP-7702 delegation code (every one has some on Monad testnet) is cleared on the fork first.
set -euo pipefail
{ # parsed whole before it runs, so an edit to this file mid-run cannot change what runs
cd "$(dirname "$0")/.."
. script/launch-lock.sh
take_launch_lock
. script/rehearse-owned.sh

FORK_RPC="${RPC:-${MONAD_TESTNET_RPC_URL:-https://testnet-rpc.monad.xyz}}"
MAINNET_RPC="${MAINNET_RPC:-https://rpc.monad.xyz}"
PORT="${PORT:-8599}"
export REHEARSAL_RPC="http://127.0.0.1:$PORT"
CHAIN=10143
export LAUNCH_LOGS
LAUNCH_LOGS="$(mktemp -d)"
LOCAL="$REHEARSAL_RPC"

SAFE_FACTORY=0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67
SAFE_L2=0x29fcB43b46531BcA003ddC8FCB67FFE91900C762
FALLBACK_HANDLER=0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99
ZERO=0x0000000000000000000000000000000000000000
PROBE=0x000000000000000000000000000000000000dEaD

MNEMONIC="test test test test test test test test test test test junk"
devkey() { cast wallet private-key --mnemonic "$MNEMONIC" --mnemonic-index "$1"; }
addr() { cast wallet address --private-key "$1" 2>/dev/null; }
# launch-testnet.sh reads keys by name; these names hold anvil dev keys only.
export REHEARSAL_DEPLOYER_KEY REHEARSAL_SAFE_OWNER_KEY
REHEARSAL_DEPLOYER_KEY=$(devkey 0)
REHEARSAL_SAFE_OWNER_KEY=$(devkey 1)
K_OWNER2=$(devkey 2)
DEPLOYER=$(addr "$REHEARSAL_DEPLOYER_KEY"); OWNER1=$(addr "$REHEARSAL_SAFE_OWNER_KEY"); OWNER2=$(addr "$K_OWNER2")
WALLET_A=$(addr "$(devkey 6)"); WALLET_B=$(addr "$(devkey 7)")
# Throwaway keystores for those dev keys, one password file of mode 600, all removed on exit.
KEYSTORES="$(mktemp -d)"
chmod 700 "$KEYSTORES"
PASSWORD_FILE="$KEYSTORES/password"
(umask 077; printf 'rehearsal-%s%s' "$RANDOM" "$RANDOM" >"$PASSWORD_FILE")
cast wallet import --keystore-dir "$KEYSTORES" deployer --private-key "$REHEARSAL_DEPLOYER_KEY" --unsafe-password "$(cat "$PASSWORD_FILE")" >/dev/null 2>&1
cast wallet import --keystore-dir "$KEYSTORES" safe-owner --private-key "$REHEARSAL_SAFE_OWNER_KEY" --unsafe-password "$(cat "$PASSWORD_FILE")" >/dev/null 2>&1
LAUNCH=(env RPC_ENV=REHEARSAL_RPC DEPLOYER_ACCOUNT="$KEYSTORES/deployer" DEPLOYER_PASSWORD_FILE="$PASSWORD_FILE"
  DEPLOYER_KEY_ENV=REHEARSAL_DEPLOYER_KEY SAFE_OWNER_KEY_ENV=REHEARSAL_SAFE_OWNER_KEY
  SAFE_OWNER_ACCOUNT="$KEYSTORES/safe-owner" SAFE_OWNER_PASSWORD_FILE="$PASSWORD_FILE" bash script/launch-testnet.sh)

ANVIL_PID= KEPT=0 SAFE= CONFIG=
# Only what this run created, and still owns.
cleanup() {
  [[ $KEPT -eq 0 && -n "$ANVIL_PID" ]] && kill "$ANVIL_PID" 2>/dev/null || true
  [[ $KEPT -eq 1 ]] || {
    # Preparation may fail before the Safe override. The unique scratch path and unchanged run marker still own it.
    if [[ -n "${RUN_ID:-}" && "$CONFIG" == "config/rehearsal-$RUN_ID.json" &&
      "$(cat "${FOUNDRY_BROADCAST:-}/.rehearsal-run" 2>/dev/null)" == "$RUN_ID" ]]; then
      rm -f -- "$CONFIG" "$CONFIG.next"
    fi
    owned_run_dirs
  }
  rm -rf "$LAUNCH_LOGS" "$KEYSTORES"
}
trap cleanup EXIT
rehearsal_run
REAL_LOGS=$(real_logs "$CHAIN")
CONFIG="config/$NETWORK.json"
[[ ! -e "$CONFIG" ]] || { echo "refusing: $CONFIG exists" >&2; exit 1; }
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

# The fork must be this run's own anvil: refuse a port something else already serves.
cast chain-id --rpc-url "$LOCAL" >/dev/null 2>&1 && fail "port $PORT already serves an RPC; stop it, or set PORT"
# No inherited stdout or lock: with KEEP=1 anvil outlives this script, and must not hold a caller's pipe or the lock.
anvil --fork-url "$FORK_RPC" --network monad --port "$PORT" --block-time 1 --silent </dev/null >/dev/null 2>&1 9>&- &
ANVIL_PID=$!
for _ in $(seq 60); do cast chain-id --rpc-url "$LOCAL" >/dev/null 2>&1 && break; sleep 1; done
[[ "$(cast chain-id --rpc-url "$LOCAL" 2>/dev/null)" == "$CHAIN" ]] || fail "anvil fork of chain $CHAIN not up"
kill -0 "$ANVIL_PID" 2>/dev/null || fail "the anvil this run started is not running (port $PORT taken?)"
for a in $DEPLOYER $OWNER1; do
  cast rpc --rpc-url "$LOCAL" anvil_setBalance "$a" 0x3635c9adc5dea00000 >/dev/null 2>&1 # 1,000 MON
done
# Every anvil dev account carries someone's EIP-7702 delegation on Monad testnet (a sweeper: it forwards MON it receives
# and breaks onERC721Received). Clear it on the fork, so they are plain EOAs.
for i in $(seq 0 9); do
  a=$(addr "$(devkey "$i")")
  cast rpc --rpc-url "$LOCAL" anvil_setCode "$a" 0x >/dev/null 2>&1
  [[ "$(cast code --rpc-url "$LOCAL" "$a" 2>/dev/null)" == 0x ]] || fail "dev account $i $a still has code"
done
ok "the dev accounts' EIP-7702 delegation code is cleared on the fork"

# A fresh 1-of-2 Safe from the canonical v1.4.1 contracts (the real testnet Safe's owners' keys are not used here).
for c in $SAFE_FACTORY $SAFE_L2 $FALLBACK_HANDLER; do
  [[ "$(cast code --rpc-url "$LOCAL" $c 2>/dev/null)" != "0x" ]] || fail "no code at canonical Safe contract $c"
done
SETUP=$(cast calldata "setup(address[],uint256,address,bytes,address,address,uint256,address)" "[$OWNER1,$OWNER2]" 1 $ZERO 0x $FALLBACK_HANDLER $ZERO 0 $ZERO)
SALT=$(date +%s)
SAFE=$(cast call --rpc-url "$LOCAL" --from "$DEPLOYER" $SAFE_FACTORY "createProxyWithNonce(address,bytes,uint256)(address)" $SAFE_L2 "$SETUP" "$SALT" 2>/dev/null)
cast send --rpc-url "$LOCAL" --private-key "$REHEARSAL_DEPLOYER_KEY" $SAFE_FACTORY "createProxyWithNonce(address,bytes,uint256)" $SAFE_L2 "$SETUP" "$SALT" >/dev/null 2>&1
ok "Safe $SAFE (1.4.1, owners $OWNER1 $OWNER2, threshold 1)"

# On testnet the deployer is roles.admin, the reused core's DEFAULT_ADMIN_ROLE, which launch-testnet.sh's pauser step
# needs to grant the Safe ADMIN_ROLE. Here the deployer is dev0, so roles.admin (impersonated, on the fork only) first
# makes it the core's admin too; the grant to the Safe is then launch-testnet.sh's own transaction.
CORE=$(jq -r .deployment.core config/monad-testnet.json)
REAL_ADMIN=$(jq -r .roles.admin config/monad-testnet.json)
DEFAULT_ADMIN_ROLE=0x0000000000000000000000000000000000000000000000000000000000000000
[[ "$(cast call --rpc-url "$LOCAL" "$CORE" "hasRole(bytes32,address)(bool)" $DEFAULT_ADMIN_ROLE "$REAL_ADMIN" 2>/dev/null)" == true ]] \
  || fail "roles.admin $REAL_ADMIN is not the core's DEFAULT_ADMIN_ROLE on testnet"
cast rpc --rpc-url "$LOCAL" anvil_impersonateAccount "$REAL_ADMIN" >/dev/null 2>&1
cast rpc --rpc-url "$LOCAL" anvil_setBalance "$REAL_ADMIN" 0x3635c9adc5dea00000 >/dev/null 2>&1
cast send --rpc-url "$LOCAL" --unlocked --from "$REAL_ADMIN" "$CORE" "grantRole(bytes32,address)" $DEFAULT_ADMIN_ROLE "$DEPLOYER" \
  >/dev/null 2>&1 || fail "could not make the fork deployer the core's admin"
cast rpc --rpc-url "$LOCAL" anvil_stopImpersonatingAccount "$REAL_ADMIN" >/dev/null 2>&1
ok "dev0 stands in for roles.admin as the core's admin (DEFAULT_ADMIN_ROLE, granted by an impersonated roles.admin)"

# The G1b rehearsal prepares a verbatim G1 copy before replacing signers/Safe with local fork stand-ins.
cp config/monad-testnet.json "$CONFIG"
if [[ "${PREP_REDEPLOY:-0}" == 1 ]]; then
  ARCHIVE="$FOUNDRY_BROADCAST/monad-testnet-g1.json"
  RPC_ENV=REHEARSAL_RPC bash script/prepare-redeploy-testnet.sh --config "$CONFIG" --archive "$ARCHIVE"
  jq -e --slurpfile original config/monad-testnet.json '
    del(.archive) == $original[0] and (.archive.reason | length > 0) and (.archive.date | length > 0)' "$ARCHIVE" >/dev/null \
    || fail "G1 archive differs from the original record"
  jq -e --slurpfile original config/monad-testnet.json '
    . == ($original[0] | del(.deployment.hireling, .deployment.main, .deployment.oddTokens))' "$CONFIG" >/dev/null \
    || fail "preparation changed more than the G1 deployment output"
  ok "G1 archived verbatim; main absent; legacy pairs, core, roles, oddTokens/liquidity/fast inputs preserved"
fi

# The scratch config: testnet's prepared input, with the fork's deployer, fresh Safe and odd-token wallets.
jq --arg safe "$SAFE" --arg admin "$DEPLOYER" --arg a "$WALLET_A" --arg b "$WALLET_B" '
  .roles.admin = $admin
  | .hireling.safe = $safe | .hireling.schedule.treasury = $safe | .hireling.allocation.treasury = $safe
  | .hireling.allocation.ecosystem = $admin | .hireling.allocation.liquidity = $admin
  | .oddTokens = (.oddTokens // { wallets: [$a, $b], mint: 1000 })' "$CONFIG" >"$CONFIG.next"
mv "$CONFIG.next" "$CONFIG"

# Signers: none configured refuses; a password file others can read refuses.
refused() { local want=$1; shift; set +e; OUT=$("$@" 2>&1); CODE=$?; set -e; [[ $CODE -ne 0 && "$OUT" == *"$want"* ]]; }
refused "set DEPLOYER_ACCOUNT and DEPLOYER_PASSWORD_FILE" env RPC_ENV=REHEARSAL_RPC bash script/launch-testnet.sh --yes \
  || fail "a run with no signer was not refused: $OUT"
cp "$PASSWORD_FILE" "$KEYSTORES/loose" && chmod 644 "$KEYSTORES/loose"
refused "must be a file you own with mode 600" env RPC_ENV=REHEARSAL_RPC DEPLOYER_ACCOUNT="$KEYSTORES/deployer" \
  DEPLOYER_PASSWORD_FILE="$KEYSTORES/loose" bash script/launch-testnet.sh --yes || fail "a loose password file was not refused: $OUT"
ok "no signer, or a password file others can read, is refused"

# Mainnet refused before anything is read beyond the chain id (the --private-keys fallback; nothing could be sent).
refused "refusing: the RPC is chain 143" env MAINNET_TEST_RPC="$MAINNET_RPC" RPC_ENV=MAINNET_TEST_RPC \
  DEPLOYER_KEY_ENV=REHEARSAL_DEPLOYER_KEY SAFE_OWNER_KEY_ENV=REHEARSAL_SAFE_OWNER_KEY \
  bash script/launch-testnet.sh --yes --private-keys || fail "a chain-143 RPC was not refused: $OUT"
ok "a chain-143 RPC is refused before anything else"

# The launch lock: a launch started from outside meanwhile (9>&-: it does not inherit this rehearsal's lock, as the
# launch-testnet.sh runs above do) refuses at once.
refused "refusing: another launch or rehearsal is running" "${LAUNCH[@]}" --yes 9>&- || fail "a concurrent launch was not refused: $OUT"
ok "a launch started while this rehearsal runs refuses (the launch lock); this rehearsal's own runs inherit the lock"

# The launch itself, with both optional flags.
if [[ "${PREP_REDEPLOY:-0}" == 1 ]]; then
  PRE_DRY=$(sha256sum "$CONFIG")
  PRE_NONCE=$(cast nonce --rpc-url "$LOCAL" "$DEPLOYER")
  "${LAUNCH[@]}" --private-keys --fee-proposal --holding-probe --dry-run \
    >"$LAUNCH_LOGS/prepared-dry.out" 2>&1 || { cat "$LAUNCH_LOGS/prepared-dry.out"; fail "prepared launch dry run"; }
  [[ "$(sha256sum "$CONFIG")" == "$PRE_DRY" && "$(cast nonce --rpc-url "$LOCAL" "$DEPLOYER")" == "$PRE_NONCE" ]] \
    || fail "prepared launch dry run mutated config or chain"
  ok "prepare -> launch-testnet.sh --dry-run passed; config and chain unchanged"
fi
LAUNCH_FLAGS=(--yes --fee-proposal --holding-probe)
[[ "${PREP_REDEPLOY:-0}" != 1 ]] || LAUNCH_FLAGS+=(--private-keys)
"${LAUNCH[@]}" "${LAUNCH_FLAGS[@]}" | tee "$LAUNCH_LOGS/launch.out"
grep -q "LAUNCH-TESTNET DONE" "$LAUNCH_LOGS/launch.out" || fail "launch-testnet.sh did not finish"
cp "$LAUNCH_LOGS/hashes.tsv" "$LAUNCH_LOGS/launch-hashes.tsv" # later runs start their own list
ok "launch-testnet.sh ran end to end"
if [[ "${PREP_REDEPLOY:-0}" == 1 ]]; then
  jq -e --slurpfile old "$ARCHIVE" '
    (.deployment.legacy | keys) == ($old[0].deployment.legacy | keys)
    and all(.deployment.legacy[]; .kind == "legacy")
    and .deployment.main.kind == "hireling-v1"
    and .deployment.main.holding != $old[0].deployment.main.holding
    and .deployment.factory != $old[0].deployment.factory
    and .deployment.hireling.clocks == .hireling.clocks
    and (.deployment.hireling.clocks | keys | length) == 9' "$CONFIG" >/dev/null \
    || fail "G1b promotion kept G1 as legacy or reused its FACTORY/pair"
  # The nine promoted values and all duplicated clocks must match deployed getters, not just the input file.
  H=$(jq -r .deployment.main.holding "$CONFIG")
  V=$(jq -r .deployment.hireling.vault "$CONFIG")
  F=$(jq -r .deployment.hireling.feeSchedule "$CONFIG")
  R=$(jq -r .deployment.hireling.miningReserve "$CONFIG")
  D=$(jq -r .deployment.hireling.distributor "$CONFIG")
  while read -r target getter key; do
    actual=$(cast call --rpc-url "$LOCAL" "$target" "$getter" | cut -d ' ' -f1)
    [[ "$actual" == "$(jq -r ".deployment.hireling.clocks.$key" "$CONFIG")" ]] || fail "promoted clock $key differs from $getter"
  done <<EOF
$H MIN_REVIEW_WINDOW()(uint32) minReviewWindow
$H MIN_DISPUTE_WINDOW()(uint32) minDisputeWindow
$H MIN_ARBITRATION_WINDOW()(uint32) minArbitrationWindow
$V UNSTAKE_DELAY()(uint48) unstakeDelay
$V HOLDING_DELAY()(uint48) holdingDelay
$V PROPOSAL_GRACE()(uint48) proposalGrace
$F DELAY()(uint48) feeDelay
$F PROPOSAL_GRACE()(uint48) proposalGrace
$R EPOCH_ZERO_DURATION()(uint48) epochZeroDuration
$R EPOCH_DURATION()(uint48) epochDuration
$D EPOCH_ZERO_DURATION()(uint48) epochZeroDuration
$D EPOCH_DURATION()(uint48) epochDuration
EOF
  SDK_CLOCKS="$LAUNCH_LOGS/sdk-clocks.ts"
  cat >"$SDK_CLOCKS" <<EOF
import { readFileSync } from 'node:fs'
import { deploymentFromConfig } from '$PWD/../packages/sdk/src/deployment.ts'
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const d = deploymentFromConfig('monad-testnet', config)
const loaded = Object.entries(d.hireling?.clocks ?? {})
if (loaded.length !== 9) throw new Error('SDK did not load all nine promoted clocks')
for (const [key, value] of loaded) {
  if (config.hireling.clocks[key] !== value) throw new Error('SDK clock differs: ' + key)
}
console.log('sdk: all nine fast promoted clocks loaded synchronously')
EOF
  bun --no-env-file "$SDK_CLOCKS" "$PWD/$CONFIG" || fail "SDK promoted clocks"
  ok "full fast recipe -> promotion -> SDK passed; G1 never enters legacy; nine clocks match twelve getters"
fi
if [[ "${KEEP:-0}" == 1 ]]; then
  [[ "$(real_logs "$CHAIN")" == "$REAL_LOGS" ]] || fail "a chain-$CHAIN forge log outside this run's directories changed"
  ok "no chain-$CHAIN forge log outside $FOUNDRY_BROADCAST and $FOUNDRY_CACHE_PATH was touched"
  KEPT=1
  echo "KEEP: fork $LOCAL (chain $CHAIN, anvil pid $ANVIL_PID)"
  echo "KEEP: config $PWD/$CONFIG (NETWORK=$NETWORK; Safe $SAFE; fee proposal and Holding probe pending)"
  echo "KEEP: signers are anvil's dev accounts: deployer = index 0, Safe owners = 1 and 2; odd-token wallets $(jq -r '.oddTokens.wallets | join(" ")' "$CONFIG")"
  echo "KEEP: further forge runs against it: NETWORK=$NETWORK FOUNDRY_BROADCAST=$FOUNDRY_BROADCAST FOUNDRY_CACHE_PATH=$FOUNDRY_CACHE_PATH (in $PWD)"
  echo "KEEP: stop it with: kill $ANVIL_PID; rm -r $PWD/$CONFIG $PWD/$FOUNDRY_BROADCAST $PWD/$FOUNDRY_CACHE_PATH"
  exit 0
fi

refused "already records a v1 deployment" "${LAUNCH[@]}" --yes || fail "a second launch was not refused: $OUT"
ok "a second launch refuses before sending"
"${LAUNCH[@]}" --from pauser --to sdk >"$LAUNCH_LOGS/readback.out" 2>&1 || { cat "$LAUNCH_LOGS/readback.out"; fail "--from pauser"; }
grep -q "already holds the core's ADMIN_ROLE" "$LAUNCH_LOGS/readback.out" || fail "--from pauser granted ADMIN_ROLE again"
ok "--from pauser --to sdk re-reads cleanly (the Safe already holds ADMIN_ROLE; nothing sent)"

# D18 holds only while execTransaction is the Safe's one way to act: a module or a guard is refused.
SENTINEL=0x0000000000000000000000000000000000000001
GUARD_SLOT=0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8
MODULE=0x000000000000000000000000000000000000bEEF
self_call() { # the Safe calling itself, sent by an owner with a pre-validated signature
  local sig; sig="$(cast abi-encode "f(address)" "$OWNER1")$(printf '%064d' 0)01"
  [[ "$(cast send --rpc-url "$LOCAL" --private-key "$REHEARSAL_SAFE_OWNER_KEY" --json "$SAFE" \
    "execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)" \
    "$SAFE" 0 "$(cast calldata "$@")" 0 0 0 0 $ZERO $ZERO "$sig" 2>/dev/null | jq -r .status)" == 0x1 ]]
}
self_call "enableModule(address)" $MODULE || fail "could not enable a module on the fork's Safe"
refused "has modules enabled" "${LAUNCH[@]}" --from readback --to readback || fail "a Safe with a module was not refused: $OUT"
self_call "disableModule(address,address)" $SENTINEL $MODULE || fail "could not disable the module again"
cast rpc --rpc-url "$LOCAL" anvil_setStorageAt "$SAFE" $GUARD_SLOT "$(cast abi-encode "f(address)" $MODULE)" >/dev/null 2>&1
refused "has a guard" "${LAUNCH[@]}" --from readback --to readback || fail "a Safe with a guard was not refused: $OUT"
cast rpc --rpc-url "$LOCAL" anvil_setStorageAt "$SAFE" $GUARD_SLOT "0x$(printf '%064d' 0)" >/dev/null 2>&1
"${LAUNCH[@]}" --from readback --to readback >"$LAUNCH_LOGS/plain.out" 2>&1 || { cat "$LAUNCH_LOGS/plain.out"; fail "readback after clearing"; }
ok "a Safe with a module, or with a guard, is refused before anything is sent (D18); cleared, it passes again"

# The immutable timelocks, on the fork; anyone executes at each pending ETA.
FEES=$(jq -r .deployment.hireling.feeSchedule "$CONFIG")
VAULT=$(jq -r .deployment.hireling.vault "$CONFIG")
STRANGER=$(devkey 9)
cast rpc --rpc-url "$LOCAL" anvil_setBalance "$(addr "$STRANGER")" 0x3635c9adc5dea00000 >/dev/null 2>&1
advance_to() {
  local eta=$1 now
  now=$(cast block --rpc-url "$LOCAL" latest --json | jq -r '.timestamp | if type == "string" then . else tostring end')
  now=$(cast to-dec "$now")
  if (( now < eta )); then cast rpc --rpc-url "$LOCAL" evm_setNextBlockTimestamp "$eta" >/dev/null 2>&1; fi
  cast rpc --rpc-url "$LOCAL" evm_mine >/dev/null 2>&1
}
FEE_ETA=$(cast call --rpc-url "$LOCAL" "$FEES" "pending()((uint256[4],uint16[4],address),uint48)" | tail -1 | cut -d ' ' -f1)
advance_to "$FEE_ETA"
[[ "$(cast send --rpc-url "$LOCAL" --private-key "$STRANGER" --json "$FEES" "execute()" 2>/dev/null | jq -r .status)" == 0x1 ]] \
  || fail "the fee schedule did not execute at its immutable delay"
ok "at the fee ETA, anyone executes the proposed fee schedule"
HOLDING_ETA=$(cast call --rpc-url "$LOCAL" "$VAULT" "pendingHolding()(address,uint48)" | tail -1 | cut -d ' ' -f1)
advance_to "$HOLDING_ETA"
[[ "$(cast send --rpc-url "$LOCAL" --private-key "$STRANGER" --json "$VAULT" "acceptHolding()" 2>/dev/null | jq -r .status)" == 0x1 ]] \
  || fail "the probed Holding was not acceptable at its immutable delay"
[[ "$(cast call --rpc-url "$LOCAL" "$VAULT" "isHolding(address)(bool)" "$PROBE" 2>/dev/null)" == true ]] || fail "isHolding($PROBE)"
ok "at the Holding ETA, anyone accepts the probed Holding"

# What each sender was charged: the gas limits of the hashes launch-testnet.sh printed.
echo
echo "GAS LIMITS (Monad charges the limit)"
declare -A LIMIT COUNT
while IFS=$'\t' read -r label hash; do
  case "$label" in
    DeployHireling*) k="DeployHireling (deployer)" ;;
    SafeAccept*) k="SafeAccept (Safe owner)" ;;
    DeployOddTokens*) k="DeployOddTokens (deployer)" ;;
    pauser*) k="core ADMIN_ROLE (deployer)" ;;
    *) k="proposals (Safe owner)" ;;
  esac
  LIMIT[$k]=$(( ${LIMIT[$k]:-0} + $(cast tx --rpc-url "$LOCAL" "$hash" gas 2>/dev/null) ))
  COUNT[$k]=$(( ${COUNT[$k]:-0} + 1 ))
done <"$LAUNCH_LOGS/launch-hashes.tsv"
for k in "DeployHireling (deployer)" "core ADMIN_ROLE (deployer)" "DeployOddTokens (deployer)" "SafeAccept (Safe owner)" "proposals (Safe owner)"; do
  printf '  %-28s %3s txs %12s gas  %s MON at 102 gwei\n' "$k" "${COUNT[$k]:-0}" "${LIMIT[$k]:-0}" \
    "$(bc <<<"scale=4; ${LIMIT[$k]:-0} * 102 / 1000000000")"
done
[[ "$(real_logs "$CHAIN")" == "$REAL_LOGS" ]] || fail "a chain-$CHAIN forge log outside this run's directories changed"
ok "no chain-$CHAIN forge log outside $FOUNDRY_BROADCAST and $FOUNDRY_CACHE_PATH was touched"
echo "LAUNCH-TESTNET REHEARSAL PASSED"
exit
}
