#!/usr/bin/env bash
# Seed a small FACTORY/mUSD v4 position using the real SeedPool path.
# The checked-in testnet config carries the delegated rehearsal liquidity block;
# this wrapper checks balances before approvals and uses that config directly.
set -euo pipefail

cd "$(dirname "$0")/.."
. script/launch-lock.sh
take_launch_lock
NETWORK="monad-testnet"
export NETWORK
RPC_ENV="${RPC_ENV:-MONAD_TESTNET_RPC_URL}"
RPC="${!RPC_ENV:-}"
KEY_ENV="${KEY_ENV:-DEPLOYER_PRIVATE_KEY}"
KEY="${!KEY_ENV:-}"
[[ -n "$RPC" && -n "$KEY" ]] || { echo "refusing: set $RPC_ENV and $KEY_ENV (values are never printed)" >&2; exit 2; }
CONFIG="config/monad-testnet.json"
QUOTE="$(jq -r .liquidity.quote "$CONFIG")"
POOL_MANAGER="$(jq -r .liquidity.uniswapV4.poolManager "$CONFIG")"
POSITION_MANAGER="$(jq -r .liquidity.uniswapV4.positionManager "$CONFIG")"
PERMIT2="$(jq -r .liquidity.uniswapV4.permit2 "$CONFIG")"
STATE_VIEW="$(jq -r .liquidity.uniswapV4.stateView "$CONFIG")"
FACTORY="$(jq -r .deployment.hireling.factory "$CONFIG")"
SAFE="$(jq -r .deployment.hireling.safe "$CONFIG")"
DEPLOYER="$(cast wallet address --private-key "$KEY")"
FACTORY_AMOUNT="$(jq -r .liquidity.factoryAmount "$CONFIG")"
QUOTE_AMOUNT="$(jq -r .liquidity.quoteAmount "$CONFIG")"
REPAIR_QUOTE="$(jq -r .liquidity.maxRepairCost "$CONFIG")"

[[ "$(cast chain-id --rpc-url "$RPC")" == 10143 ]] || { echo "refusing: RPC is not Monad testnet" >&2; exit 2; }
[[ "${DEPLOYER,,}" == "$(jq -r '.hireling.allocation.liquidity | ascii_downcase' "$CONFIG")" ]] || { echo "refusing: signer is not the liquidity holder" >&2; exit 2; }
[[ "${QUOTE,,}" == 0xabd60a1e40519e3609c4f9ebb551fcf242a8ad8f ]] || { echo "refusing: quote is not testnet mUSD" >&2; exit 2; }
[[ "$FACTORY_AMOUNT" =~ ^[1-9][0-9]*$ && "$QUOTE_AMOUNT" =~ ^[1-9][0-9]*$ && "$REPAIR_QUOTE" =~ ^[1-9][0-9]*$ ]] || { echo "refusing: invalid seed amounts" >&2; exit 2; }
(( FACTORY_AMOUNT <= 50000000 && QUOTE_AMOUNT <= 10 && REPAIR_QUOTE <= QUOTE_AMOUNT )) || { echo "refusing: outside the small testnet seed bounds" >&2; exit 2; }
[[ "$(cast call "$FACTORY" 'decimals()(uint8)' --rpc-url "$RPC")" == 18 && "$(cast call "$QUOTE" 'decimals()(uint8)' --rpc-url "$RPC")" == 6 ]] || { echo "refusing: token decimals mismatch" >&2; exit 2; }
for address in "$POOL_MANAGER" "$POSITION_MANAGER" "$PERMIT2" "$STATE_VIEW" "$FACTORY" "$QUOTE" "$SAFE"; do
  [[ "$(cast code "$address" --rpc-url "$RPC")" != 0x ]] || { echo "refusing: no code at configured address" >&2; exit 2; }
done
[[ "$(cast call "$POSITION_MANAGER" 'poolManager()(address)' --rpc-url "$RPC")" = "$POOL_MANAGER" ]] || { echo "refusing: PositionManager poolManager mismatch" >&2; exit 2; }
[[ "$(cast call "$POSITION_MANAGER" 'permit2()(address)' --rpc-url "$RPC")" = "$PERMIT2" ]] || { echo "refusing: PositionManager Permit2 mismatch" >&2; exit 2; }
[[ "$(cast call "$STATE_VIEW" 'poolManager()(address)' --rpc-url "$RPC")" = "$POOL_MANAGER" ]] || { echo "refusing: StateView poolManager mismatch" >&2; exit 2; }

need_factory=$((FACTORY_AMOUNT + REPAIR_QUOTE * FACTORY_AMOUNT / QUOTE_AMOUNT))
need_quote=$((QUOTE_AMOUNT + REPAIR_QUOTE))
need_factory_raw="${need_factory}000000000000000000"
need_quote_raw="${need_quote}000000"
factory_balance="$(cast call "$FACTORY" 'balanceOf(address)(uint256)' "$DEPLOYER" --rpc-url "$RPC" | awk '{print $1}')"
quote_balance="$(cast call "$QUOTE" 'balanceOf(address)(uint256)' "$DEPLOYER" --rpc-url "$RPC" | awk '{print $1}')"
ge_dec() {
  local left=$1 right=$2
  [[ "$left" =~ ^(0|[1-9][0-9]*)$ && "$right" =~ ^(0|[1-9][0-9]*)$ ]] || return 1
  (( ${#left} > ${#right} )) || { (( ${#left} == ${#right} )) && [[ "$left" == "$right" || "$left" > "$right" ]]; }
}
if ! ge_dec "$factory_balance" "$need_factory_raw"; then
  echo "NEEDS FACTORY v2: $((need_factory)) whole tokens to $DEPLOYER (balance $factory_balance raw)" >&2
  exit 3
fi
if ! ge_dec "$quote_balance" "$need_quote_raw"; then
  echo "NEEDS mUSD: $need_quote whole mUSD to $DEPLOYER at $QUOTE (balance $quote_balance raw)" >&2
  exit 3
fi
echo "SeedPool funding preflight passed: $FACTORY_AMOUNT FACTORY + $QUOTE_AMOUNT mUSD, repair cap $REPAIR_QUOTE mUSD"
forge script script/SeedPool.s.sol --rpc-url "$RPC" --private-key "$KEY" --broadcast --slow
RUN="broadcast/SeedPool.s.sol/10143/run-latest.json"
[[ -f "$RUN" ]] || { echo "refusing: SeedPool run log missing" >&2; exit 1; }
echo "SeedPool transaction hashes:"
jq -r '.transactions[] | .hash // .transactionHash // empty' "$RUN"
forge script script/SeedPool.s.sol --sig 'verify()' --rpc-url "$RPC"
