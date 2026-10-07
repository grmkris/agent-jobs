#!/usr/bin/env bash
# Seed a small SIDE/mUSD v4 position using the real SeedPool path.
# The checked-in testnet config carries the delegated rehearsal liquidity block;
# this wrapper checks balances before approvals and uses that config directly.
# --dry-run checks funding and runs Forge simulation without broadcasting.
set -euo pipefail

cd "$(dirname "$0")/.."
. script/launch-lock.sh
take_launch_lock
DRY_RUN=0
if [[ $# -eq 1 && "$1" == --dry-run ]]; then DRY_RUN=1
elif [[ $# -ne 0 ]]; then echo "usage: seed-pool-testnet.sh [--dry-run]" >&2; exit 2; fi
NETWORK="monad-testnet"
export NETWORK
RPC_ENV="${RPC_ENV:-MONAD_RPC_URL}"
if [[ -z "${!RPC_ENV:-}" && "$RPC_ENV" == MONAD_RPC_URL && -n "${MONAD_TESTNET_RPC_URL:-}" ]]; then RPC_ENV="MONAD_TESTNET_RPC_URL"; fi
RPC="${!RPC_ENV:-}"
KEY_ENV="${KEY_ENV:-DEPLOYER_PRIVATE_KEY}"
KEY="${!KEY_ENV:-}"
[[ -n "$RPC" && -n "$KEY" ]] || { echo "refusing: set $RPC_ENV and $KEY_ENV (values are never printed)" >&2; exit 2; }
CONFIG="config/monad-testnet.json"
CONFIG_QUOTE="$(jq -r .liquidity.quote "$CONFIG")"
# mUSD is the first configured reward token (the setup script writes mUSD before mEUR); knownTokens is the
# compatibility fallback for archived configs where deployment.rewardTokens is absent.
QUOTE="$(jq -er '.deployment.rewardTokens[0] // .knownTokens[0]' "$CONFIG")"
POOL_MANAGER="$(jq -r .liquidity.uniswapV4.poolManager "$CONFIG")"
POSITION_MANAGER="$(jq -r .liquidity.uniswapV4.positionManager "$CONFIG")"
PERMIT2="$(jq -r .liquidity.uniswapV4.permit2 "$CONFIG")"
STATE_VIEW="$(jq -r .liquidity.uniswapV4.stateView "$CONFIG")"
SIDE="$(jq -r .deployment.sidequest.factory "$CONFIG")"
SAFE="$(jq -r .deployment.sidequest.safe "$CONFIG")"
DEPLOYER="$(cast wallet address --private-key "$KEY")"
SIDE_AMOUNT="$(jq -r .liquidity.factoryAmount "$CONFIG")"
QUOTE_AMOUNT="$(jq -r .liquidity.quoteAmount "$CONFIG")"
REPAIR_QUOTE="$(jq -r .liquidity.maxRepairCost "$CONFIG")"

[[ "$(cast chain-id --rpc-url "$RPC")" == 10143 ]] || { echo "refusing: RPC is not Monad testnet" >&2; exit 2; }
[[ "${DEPLOYER,,}" == "$(jq -r '.sidequest.allocation.liquidity | ascii_downcase' "$CONFIG")" ]] || { echo "refusing: signer is not the liquidity holder" >&2; exit 2; }
[[ "${QUOTE,,}" == "${CONFIG_QUOTE,,}" ]] || { echo "refusing: liquidity quote differs from configured mUSD" >&2; exit 2; }
ge_dec() {
  local left=$1 right=$2
  [[ "$left" =~ ^(0|[1-9][0-9]*)$ && "$right" =~ ^(0|[1-9][0-9]*)$ ]] || return 1
  (( ${#left} > ${#right} )) || { (( ${#left} == ${#right} )) && [[ "$left" == "$right" || "$left" > "$right" ]]; }
}
[[ "$SIDE_AMOUNT" =~ ^[1-9][0-9]*$ && "$QUOTE_AMOUNT" =~ ^[1-9][0-9]*$ && "$REPAIR_QUOTE" =~ ^[1-9][0-9]*$ ]] || { echo "refusing: invalid seed amounts" >&2; exit 2; }
ge_dec 50000000 "$SIDE_AMOUNT" && ge_dec 10 "$QUOTE_AMOUNT" && ge_dec "$QUOTE_AMOUNT" "$REPAIR_QUOTE" \
  || { echo "refusing: outside the small testnet seed bounds" >&2; exit 2; }
[[ "$(cast call "$SIDE" 'decimals()(uint8)' --rpc-url "$RPC")" == 18 && "$(cast call "$QUOTE" 'decimals()(uint8)' --rpc-url "$RPC")" == 6 ]] || { echo "refusing: token decimals mismatch" >&2; exit 2; }
for address in "$POOL_MANAGER" "$POSITION_MANAGER" "$PERMIT2" "$STATE_VIEW" "$SIDE" "$QUOTE" "$SAFE"; do
  [[ "$(cast code "$address" --rpc-url "$RPC")" != 0x ]] || { echo "refusing: no code at configured address" >&2; exit 2; }
done
[[ "$(cast call "$POSITION_MANAGER" 'poolManager()(address)' --rpc-url "$RPC")" = "$POOL_MANAGER" ]] || { echo "refusing: PositionManager poolManager mismatch" >&2; exit 2; }
[[ "$(cast call "$POSITION_MANAGER" 'permit2()(address)' --rpc-url "$RPC")" = "$PERMIT2" ]] || { echo "refusing: PositionManager Permit2 mismatch" >&2; exit 2; }
[[ "$(cast call "$STATE_VIEW" 'poolManager()(address)' --rpc-url "$RPC")" = "$POOL_MANAGER" ]] || { echo "refusing: StateView poolManager mismatch" >&2; exit 2; }

factory_amount_raw="${SIDE_AMOUNT}000000000000000000"
quote_amount_raw="${QUOTE_AMOUNT}000000"
repair_quote_raw="${REPAIR_QUOTE}000000"
# Match SeedPoolRecipe.plan's Math.mulDiv in raw units, rounding once at the raw SIDE wei boundary.
# Dividing whole tokens first loses fractional SIDE (SEED-TESTNET-001); bc avoids native-width overflow.
need_factory_raw=$(bc <<<"scale=0; $factory_amount_raw + ($repair_quote_raw * $factory_amount_raw / $quote_amount_raw)")
need_quote_raw=$(bc <<<"scale=0; $quote_amount_raw + $repair_quote_raw")
need_quote=$(bc <<<"scale=0; $QUOTE_AMOUNT + $REPAIR_QUOTE")
factory_balance="$(cast call "$SIDE" 'balanceOf(address)(uint256)' "$DEPLOYER" --rpc-url "$RPC" | awk '{print $1}')"
quote_balance="$(cast call "$QUOTE" 'balanceOf(address)(uint256)' "$DEPLOYER" --rpc-url "$RPC" | awk '{print $1}')"
if ! ge_dec "$factory_balance" "$need_factory_raw"; then
  echo "NEEDS SIDE v2: at least $need_factory_raw raw units to $DEPLOYER (balance $factory_balance raw)" >&2
  exit 3
fi
if ! ge_dec "$quote_balance" "$need_quote_raw"; then
  echo "NEEDS mUSD: $need_quote whole mUSD to $DEPLOYER at $QUOTE (balance $quote_balance raw)" >&2
  exit 3
fi
echo "SeedPool funding preflight passed: $SIDE_AMOUNT SIDE + $QUOTE_AMOUNT mUSD, repair cap $REPAIR_QUOTE mUSD"
echo "SeedPool raw funding need: $need_factory_raw SIDE, $need_quote_raw mUSD"
if [[ $DRY_RUN -eq 1 ]]; then
  forge script script/SeedPool.s.sol --rpc-url "$RPC" --private-key "$KEY"
  echo "SeedPool dry run passed (nothing broadcast)"
  exit 0
fi
forge script script/SeedPool.s.sol --rpc-url "$RPC" --private-key "$KEY" --broadcast --slow
RUN="broadcast/SeedPool.s.sol/10143/run-latest.json"
[[ -f "$RUN" ]] || { echo "refusing: SeedPool run log missing" >&2; exit 1; }
echo "SeedPool transaction hashes:"
jq -r '.transactions[] | .hash // .transactionHash // empty' "$RUN"
forge script script/SeedPool.s.sol --sig 'verify()' --rpc-url "$RPC"
