#!/usr/bin/env bash
# The G1 rehearsal: script/launch-testnet.sh, unchanged, against a throwaway anvil fork of Monad testnet (chain 10143,
# Monad gas pricing), with anvil's public dev keys and a fresh 1-of-2 Safe in a scratch config. Then, on the fork:
#   - a run against a chain-143 RPC refuses before it sends anything, and a second launch refuses;
#   - --from readback --to sdk re-reads cleanly;
#   - 3 days later anyone executes the proposed fee schedule; 8 days later anyone accepts the probed Holding.
# Prints the gas limits each sender is charged. Writes config/rehearsal-testnet.json and chain-10143 broadcast logs
# and removes both on exit; refuses to start if any already exist (a real testnet run's). Needs anvil, forge, cast,
# jq, bun, bc, perl.
#   bash script/rehearse-launch-testnet.sh            # RPC=<testnet RPC to fork>, default the public one
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
LAUNCH=(env RPC_ENV=REHEARSAL_RPC DEPLOYER_KEY_ENV=REHEARSAL_DEPLOYER_KEY SAFE_OWNER_KEY_ENV=REHEARSAL_SAFE_OWNER_KEY
  bash script/launch-testnet.sh)

for s in "${SCRIPTS[@]}"; do
  if [[ -e "broadcast/$s.s.sol/$CHAIN" || -e "cache/$s.s.sol/$CHAIN" ]]; then
    echo "refusing: broadcast/ or cache/$s.s.sol/$CHAIN exists (a real testnet log?); move it away first" >&2
    exit 1
  fi
done
[[ ! -e "$CONFIG" && ! -e "$CANDIDATE" ]] || { echo "refusing: $CONFIG or $CANDIDATE exists" >&2; exit 1; }

ANVIL_PID=
cleanup() {
  [[ -n "$ANVIL_PID" ]] && kill "$ANVIL_PID" 2>/dev/null || true
  for s in "${SCRIPTS[@]}"; do rm -rf "broadcast/$s.s.sol/$CHAIN" "cache/$s.s.sol/$CHAIN"; done
  rm -f "$CONFIG" "$CANDIDATE"
  rm -rf "$LAUNCH_LOGS"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

anvil --fork-url "$FORK_RPC" --network monad --port "$PORT" --block-time 1 --silent &
ANVIL_PID=$!
for _ in $(seq 60); do cast chain-id --rpc-url "$LOCAL" >/dev/null 2>&1 && break; sleep 1; done
[[ "$(cast chain-id --rpc-url "$LOCAL" 2>/dev/null)" == "$CHAIN" ]] || fail "anvil fork of chain $CHAIN not up"
for a in $DEPLOYER $OWNER1; do
  cast rpc --rpc-url "$LOCAL" anvil_setBalance "$a" 0x3635c9adc5dea00000 >/dev/null 2>&1 # 1,000 MON
done

# A fresh 1-of-2 Safe from the canonical v1.4.1 contracts (the real testnet Safe's owners' keys are not used here).
for c in $SAFE_FACTORY $SAFE_L2 $FALLBACK_HANDLER; do
  [[ "$(cast code --rpc-url "$LOCAL" $c 2>/dev/null)" != "0x" ]] || fail "no code at canonical Safe contract $c"
done
SETUP=$(cast calldata "setup(address[],uint256,address,bytes,address,address,uint256,address)" "[$OWNER1,$OWNER2]" 1 $ZERO 0x $FALLBACK_HANDLER $ZERO 0 $ZERO)
SALT=$(date +%s)
SAFE=$(cast call --rpc-url "$LOCAL" --from "$DEPLOYER" $SAFE_FACTORY "createProxyWithNonce(address,bytes,uint256)(address)" $SAFE_L2 "$SETUP" "$SALT" 2>/dev/null)
cast send --rpc-url "$LOCAL" --private-key "$REHEARSAL_DEPLOYER_KEY" $SAFE_FACTORY "createProxyWithNonce(address,bytes,uint256)" $SAFE_L2 "$SETUP" "$SALT" >/dev/null 2>&1
ok "Safe $SAFE (1.4.1, owners $OWNER1 $OWNER2, threshold 1)"

# The scratch config: testnet's, with the fork's deployer, the fresh Safe and odd-token wallets.
jq --arg safe "$SAFE" --arg admin "$DEPLOYER" --arg a "$WALLET_A" --arg b "$WALLET_B" '
  .roles.admin = $admin
  | .hireling.safe = $safe | .hireling.schedule.treasury = $safe | .hireling.allocation.treasury = $safe
  | .hireling.allocation.ecosystem = $admin | .hireling.allocation.liquidity = $admin
  | .oddTokens = (.oddTokens // { wallets: [$a, $b], mint: 1000 })' config/monad-testnet.json >"$CONFIG"

# Mainnet refused before anything is read beyond the chain id (dev keys; nothing could be sent anyway).
set +e
OUT=$(env MAINNET_TEST_RPC="$MAINNET_RPC" RPC_ENV=MAINNET_TEST_RPC DEPLOYER_KEY_ENV=REHEARSAL_DEPLOYER_KEY \
  SAFE_OWNER_KEY_ENV=REHEARSAL_SAFE_OWNER_KEY bash script/launch-testnet.sh --yes 2>&1)
CODE=$?
set -e
[[ $CODE -ne 0 && "$OUT" == *"refusing: the RPC is chain 143"* ]] || fail "a chain-143 RPC was not refused: $OUT"
ok "a chain-143 RPC is refused before anything else"

# The launch itself, with both optional flags.
"${LAUNCH[@]}" --yes --fee-proposal --holding-probe | tee "$LAUNCH_LOGS/launch.out"
grep -q "LAUNCH-TESTNET DONE" "$LAUNCH_LOGS/launch.out" || fail "launch-testnet.sh did not finish"
cp "$LAUNCH_LOGS/hashes.tsv" "$LAUNCH_LOGS/launch-hashes.tsv" # later runs start their own list
ok "launch-testnet.sh ran end to end"

set +e
OUT=$("${LAUNCH[@]}" --yes 2>&1)
CODE=$?
set -e
[[ $CODE -ne 0 && "$OUT" == *"already records a v1 deployment"* ]] || fail "a second launch was not refused: $OUT"
ok "a second launch refuses before sending"
"${LAUNCH[@]}" --from readback --to sdk >"$LAUNCH_LOGS/readback.out" 2>&1 || { cat "$LAUNCH_LOGS/readback.out"; fail "--from readback"; }
ok "--from readback --to sdk re-reads cleanly"

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
    *) k="proposals (Safe owner)" ;;
  esac
  LIMIT[$k]=$(( ${LIMIT[$k]:-0} + $(cast tx --rpc-url "$LOCAL" "$hash" gas 2>/dev/null) ))
  COUNT[$k]=$(( ${COUNT[$k]:-0} + 1 ))
done <"$LAUNCH_LOGS/launch-hashes.tsv"
for k in "DeployHireling (deployer)" "DeployOddTokens (deployer)" "SafeAccept (Safe owner)" "proposals (Safe owner)"; do
  printf '  %-28s %3s txs %12s gas  %s MON at 102 gwei\n' "$k" "${COUNT[$k]:-0}" "${LIMIT[$k]:-0}" \
    "$(bc <<<"scale=4; ${LIMIT[$k]:-0} * 102 / 1000000000")"
done
echo "LAUNCH-TESTNET REHEARSAL PASSED"
