#!/usr/bin/env bash
# Seed a small FACTORY/mUSD v4 position using the real SeedPool path.
# The checked-in testnet config deliberately has no liquidity block; this wrapper
# creates a throwaway config, checks balances before approvals, and removes it.
set -euo pipefail

cd "$(dirname "$0")/.."
. script/launch-lock.sh
take_launch_lock
ROOT="$(cd .. && pwd)"
NETWORK="monad-testnet"
RPC_ENV="${RPC_ENV:-MONAD_TESTNET_RPC_URL}"
RPC="${!RPC_ENV:-}"
KEY_ENV="${KEY_ENV:-DEPLOYER_PRIVATE_KEY}"
KEY="${!KEY_ENV:-}"
[[ -n "$RPC" && -n "$KEY" ]] || { echo "refusing: set $RPC_ENV and $KEY_ENV (values are never printed)" >&2; exit 2; }
BASE="config/monad-testnet.json"
TMP="config/.testnet-seed-$$.json"
trap 'rm -f "$TMP"' EXIT
QUOTE="0xabd60a1e40519E3609C4F9eBb551FcF242a8AD8f" # testnet mUSD (6 decimals)
POOL_MANAGER="0x451D64ab3b650040d2aE1886602b97ed6eDc643d"
POSITION_MANAGER="0x3Bb14E3D0Cd50aBe3EdACa06d06c29C78676C31A"
PERMIT2="0x000000000022D473030F116dDEE9F6B43aC78BA3"
STATE_VIEW="0xB639209539c61BaF67AC04876315786F8D0b153c"
FACTORY="$(jq -r .deployment.hireling.factory "$BASE")"
SAFE="$(jq -r .deployment.hireling.safe "$BASE")"
DEPLOYER="$(cast wallet address --private-key "$KEY")"
FACTORY_AMOUNT="${FACTORY_AMOUNT:-10000}"
QUOTE_AMOUNT="${QUOTE_AMOUNT:-1}"
REPAIR_QUOTE="${REPAIR_QUOTE:-1}"

[[ "$(cast chain-id --rpc-url "$RPC")" == 10143 ]] || { echo "refusing: RPC is not Monad testnet" >&2; exit 2; }
for address in "$POOL_MANAGER" "$POSITION_MANAGER" "$PERMIT2" "$STATE_VIEW" "$FACTORY" "$QUOTE" "$SAFE"; do
  [[ "$(cast code "$address" --rpc-url "$RPC")" != 0x ]] || { echo "refusing: no code at configured address" >&2; exit 2; }
done
[[ "$(cast call "$POSITION_MANAGER" 'poolManager()(address)' --rpc-url "$RPC")" = "$POOL_MANAGER" ]] || { echo "refusing: PositionManager poolManager mismatch" >&2; exit 2; }
[[ "$(cast call "$POSITION_MANAGER" 'permit2()(address)' --rpc-url "$RPC")" = "$PERMIT2" ]] || { echo "refusing: PositionManager Permit2 mismatch" >&2; exit 2; }
[[ "$(cast call "$STATE_VIEW" 'poolManager()(address)' --rpc-url "$RPC")" = "$POOL_MANAGER" ]] || { echo "refusing: StateView poolManager mismatch" >&2; exit 2; }

need_factory=$((FACTORY_AMOUNT + REPAIR_QUOTE * FACTORY_AMOUNT / QUOTE_AMOUNT))
need_quote=$((QUOTE_AMOUNT + REPAIR_QUOTE))
factory_balance="$(cast call "$FACTORY" 'balanceOf(address)(uint256)' "$DEPLOYER" --rpc-url "$RPC" | awk '{print $1}')"
quote_balance="$(cast call "$QUOTE" 'balanceOf(address)(uint256)' "$DEPLOYER" --rpc-url "$RPC" | awk '{print $1}')"
if (( factory_balance < need_factory * 10 ** 18 )); then
  echo "NEEDS FACTORY v2: $((need_factory)) whole tokens to $DEPLOYER (balance $factory_balance raw)" >&2
  exit 3
fi
if (( quote_balance < need_quote * 10 ** 6 )); then
  echo "NEEDS testnet USDC: $need_quote whole USDC to $DEPLOYER at $QUOTE (balance $quote_balance raw)" >&2
  exit 3
fi
echo "SeedPool funding preflight passed: $FACTORY_AMOUNT FACTORY + $QUOTE_AMOUNT mUSD, repair cap $REPAIR_QUOTE mUSD"

jq --arg pm "$POOL_MANAGER" --arg pos "$POSITION_MANAGER" --arg permit "$PERMIT2" --arg state "$STATE_VIEW" \
  --arg quote "$QUOTE" --arg safe "$SAFE" --argjson fa "$FACTORY_AMOUNT" --argjson qa "$QUOTE_AMOUNT" --argjson repair "$REPAIR_QUOTE" '
  .liquidity = { uniswapV4: { poolManager: $pm, positionManager: $pos, permit2: $permit, stateView: $state },
    quote: $quote, fee: 3000, tickSpacing: 60, factoryAmount: $fa, quoteAmount: $qa,
    maxRepairCost: $repair, positionOwner: $safe }' "$BASE" >"$TMP"
mv "$TMP" "${TMP}.ready"
TMP="${TMP}.ready"
forge script script/SeedPool.s.sol --rpc-url "$RPC" --private-key "$KEY" --broadcast --slow
RUN="broadcast/SeedPool.s.sol/10143/run-latest.json"
[[ -f "$RUN" ]] || { echo "refusing: SeedPool run log missing" >&2; exit 1; }
echo "SeedPool transaction hashes:"
jq -r '.transactions[] | .hash // .transactionHash // empty' "$RUN"
forge script script/SeedPool.s.sol --sig 'verify()' --rpc-url "$RPC"
