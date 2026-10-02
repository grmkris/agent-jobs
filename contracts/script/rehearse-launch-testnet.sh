#!/usr/bin/env bash
# The G1 rehearsal: script/launch-testnet.sh, unchanged, against a throwaway anvil fork of Monad testnet (chain 10143,
# Monad gas pricing), signing from throwaway encrypted keystores of anvil's public dev keys (as mainnet signs), with a
# fresh 1-of-2 Safe in a scratch config; dev0 stands in for roles.admin as the reused core's admin, so the launch's
# pauser step grants the Safe ADMIN_ROLE. Then, on the fork:
#   - no signer, or a password file others can read, refuses; a chain-143 RPC refuses before anything is sent (with
#     the --private-keys fallback); a second launch refuses;
#   - --from pauser --to sdk re-reads cleanly (the Safe already holds ADMIN_ROLE: nothing sent);
#   - 3 days later anyone executes the proposed fee schedule; 8 days later anyone accepts the probed Holding.
# Prints the gas limits each sender is charged. Writes config/rehearsal-testnet.json and chain-10143 broadcast logs
# and removes both on exit; refuses to start if any already exist (a real testnet run's). Needs anvil, forge, cast,
# jq, bun, bc, perl.
#   bash script/rehearse-launch-testnet.sh            # RPC=<testnet RPC to fork>, default the public one
#   KEEP=1 bash script/rehearse-launch-testnet.sh     # stop after the launch, leaving the fork running and the promoted
#                                                     # scratch config in place (it prints both; fee proposal and Holding
#                                                     # probe still pending), for a harness to run against
# The anvil dev accounts' EIP-7702 delegation code (every one has some on Monad testnet) is cleared on the fork first.
set -euo pipefail
cd "$(dirname "$0")/.."

FORK_RPC="${RPC:-https://testnet-rpc.monad.xyz}"
MAINNET_RPC="${MAINNET_RPC:-https://rpc.monad.xyz}"
PORT="${PORT:-8599}"
export REHEARSAL_RPC="http://127.0.0.1:$PORT"
export NETWORK=rehearsal-testnet
CONFIG="config/$NETWORK.json"
CANDIDATE="broadcast/hireling/$NETWORK.candidate.json"
CHAIN=10143
SCRIPTS=(DeployHireling PromoteHireling SafeAccept DeployOddTokens)
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
  SAFE_OWNER_ACCOUNT="$KEYSTORES/safe-owner" SAFE_OWNER_PASSWORD_FILE="$PASSWORD_FILE" bash script/launch-testnet.sh)

for s in "${SCRIPTS[@]}"; do
  if [[ -e "broadcast/$s.s.sol/$CHAIN" || -e "cache/$s.s.sol/$CHAIN" ]]; then
    echo "refusing: broadcast/ or cache/$s.s.sol/$CHAIN exists (a real testnet log?); move it away first" >&2
    exit 1
  fi
done
[[ ! -e "$CONFIG" && ! -e "$CANDIDATE" ]] || { echo "refusing: $CONFIG or $CANDIDATE exists" >&2; exit 1; }

ANVIL_PID= KEPT=0 SAFE=
. script/rehearse-owned.sh
# Only what this run created: G1 itself, run from the same checkout, writes the same chain-10143 broadcast paths.
cleanup() {
  [[ $KEPT -eq 0 && -n "$ANVIL_PID" ]] && kill "$ANVIL_PID" 2>/dev/null || true
  owned_runs "$CHAIN" "$LOCAL" "$DEPLOYER" "$OWNER1"
  [[ $KEPT -eq 1 ]] || owned_file "$CONFIG" .hireling.safe "$SAFE"
  owned_file "$CANDIDATE" .safe "$SAFE"
  rm -rf "$LAUNCH_LOGS" "$KEYSTORES"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

# The fork must be this run's own anvil: refuse a port something else already serves.
cast chain-id --rpc-url "$LOCAL" >/dev/null 2>&1 && fail "port $PORT already serves an RPC; stop it, or set PORT"
# No inherited stdout: with KEEP=1 anvil outlives this script, and must not hold a caller's pipe open.
anvil --fork-url "$FORK_RPC" --network monad --port "$PORT" --block-time 1 --silent </dev/null >/dev/null 2>&1 &
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

# The scratch config: testnet's, with the fork's deployer, the fresh Safe and odd-token wallets.
jq --arg safe "$SAFE" --arg admin "$DEPLOYER" --arg a "$WALLET_A" --arg b "$WALLET_B" '
  .roles.admin = $admin
  | .hireling.safe = $safe | .hireling.schedule.treasury = $safe | .hireling.allocation.treasury = $safe
  | .hireling.allocation.ecosystem = $admin | .hireling.allocation.liquidity = $admin
  | .oddTokens = (.oddTokens // { wallets: [$a, $b], mint: 1000 })' config/monad-testnet.json >"$CONFIG"

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

# The launch itself, with both optional flags.
"${LAUNCH[@]}" --yes --fee-proposal --holding-probe | tee "$LAUNCH_LOGS/launch.out"
grep -q "LAUNCH-TESTNET DONE" "$LAUNCH_LOGS/launch.out" || fail "launch-testnet.sh did not finish"
cp "$LAUNCH_LOGS/hashes.tsv" "$LAUNCH_LOGS/launch-hashes.tsv" # later runs start their own list
ok "launch-testnet.sh ran end to end"
if [[ "${KEEP:-0}" == 1 ]]; then
  KEPT=1
  echo "KEEP: fork $LOCAL (chain $CHAIN, anvil pid $ANVIL_PID)"
  echo "KEEP: config $PWD/$CONFIG (NETWORK=$NETWORK; Safe $SAFE; fee proposal and Holding probe pending)"
  echo "KEEP: signers are anvil's dev accounts: deployer = index 0, Safe owners = 1 and 2; odd-token wallets $(jq -r '.oddTokens.wallets | join(" ")' "$CONFIG")"
  echo "KEEP: stop it with: kill $ANVIL_PID; rm $PWD/$CONFIG"
  exit 0
fi

refused "already records a v1 deployment" "${LAUNCH[@]}" --yes || fail "a second launch was not refused: $OUT"
ok "a second launch refuses before sending"
"${LAUNCH[@]}" --from pauser --to sdk >"$LAUNCH_LOGS/readback.out" 2>&1 || { cat "$LAUNCH_LOGS/readback.out"; fail "--from pauser"; }
grep -q "already holds the core's ADMIN_ROLE" "$LAUNCH_LOGS/readback.out" || fail "--from pauser granted ADMIN_ROLE again"
ok "--from pauser --to sdk re-reads cleanly (the Safe already holds ADMIN_ROLE; nothing sent)"

# The timelocks, on the fork: 3 days for the fee schedule, 8 for the Holding; anyone executes.
FEES=$(jq -r .deployment.hireling.feeSchedule "$CONFIG")
VAULT=$(jq -r .deployment.hireling.vault "$CONFIG")
STRANGER=$(devkey 9)
cast rpc --rpc-url "$LOCAL" anvil_setBalance "$(addr "$STRANGER")" 0x3635c9adc5dea00000 >/dev/null 2>&1
cast rpc --rpc-url "$LOCAL" evm_increaseTime $((3 * 86400 + 60)) >/dev/null 2>&1
cast rpc --rpc-url "$LOCAL" evm_mine >/dev/null 2>&1
[[ "$(cast send --rpc-url "$LOCAL" --private-key "$STRANGER" --json "$FEES" "execute()" 2>/dev/null | jq -r .status)" == 0x1 ]] \
  || fail "the fee schedule did not execute after 3 days"
ok "3 days later, anyone executes the proposed fee schedule"
cast rpc --rpc-url "$LOCAL" evm_increaseTime $((5 * 86400)) >/dev/null 2>&1
cast rpc --rpc-url "$LOCAL" evm_mine >/dev/null 2>&1
[[ "$(cast send --rpc-url "$LOCAL" --private-key "$STRANGER" --json "$VAULT" "acceptHolding()" 2>/dev/null | jq -r .status)" == 0x1 ]] \
  || fail "the probed Holding was not acceptable after 8 days"
[[ "$(cast call --rpc-url "$LOCAL" "$VAULT" "isHolding(address)(bool)" "$PROBE" 2>/dev/null)" == true ]] || fail "isHolding($PROBE)"
ok "8 days later, anyone accepts the probed Holding"

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
echo "LAUNCH-TESTNET REHEARSAL PASSED"
