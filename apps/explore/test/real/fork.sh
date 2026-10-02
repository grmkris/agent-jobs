#!/usr/bin/env bash
# U-REAL: a throwaway anvil fork of Monad testnet with Hireling v1 deployed on it, left running for real.e2e.mjs.
#   bash apps/explore/test/real/fork.sh up     # fork, fresh Safe, launch-testnet.sh, one hire; prints the state file
#   bash apps/explore/test/real/fork.sh down   # stop the fork, remove the scratch config and its broadcast logs
# Same steps as contracts/script/rehearse-launch-testnet.sh (whose trap removes everything when it exits, so it cannot
# leave a fork behind): a fresh 1-of-2 Safe of anvil's public dev keys, contracts/config/rehearsal-ui.json from
# testnet's config, launch-testnet.sh through `sdk` from throwaway keystores, then RehearseHire (one direct hire in mUSD,
# settled, so epoch 0 has a fee). Dev keys only, a local fork only; nothing reaches testnet. The scratch config and the
# chain-10143 broadcast logs are in this worktree, never committed, and `down` removes them.
# Needs anvil, forge, cast, jq, bun. RPC = the testnet RPC to fork (default the public one), PORT (default 8611).
set -euo pipefail
cd "$(dirname "$0")/../../../../contracts"

FORK_RPC="${RPC:-https://testnet-rpc.monad.xyz}"
PORT="${PORT:-8611}"
STATE_DIR="${STATE_DIR:-/tmp/hireling-real}"
NETWORK=rehearsal-ui
CONFIG="config/$NETWORK.json"
CHAIN=10143
SCRIPTS=(DeployHireling PromoteHireling SafeAccept RehearseHireAndMine)
LOCAL="http://127.0.0.1:$PORT"

down() {
  if [[ -f "$STATE_DIR/anvil.pid" ]]; then kill "$(cat "$STATE_DIR/anvil.pid")" 2>/dev/null || true; fi
  for s in "${SCRIPTS[@]}"; do rm -rf "broadcast/$s.s.sol/$CHAIN" "cache/$s.s.sol/$CHAIN"; done
  rm -f "$CONFIG" "broadcast/hireling/$NETWORK".*
  rm -rf "$STATE_DIR"
  echo "fork down"
}
if [[ "${1:-}" == down ]]; then down; exit 0; fi
[[ "${1:-}" == up ]] || { echo "usage: fork.sh up|down" >&2; exit 2; }

for s in "${SCRIPTS[@]}"; do
  [[ ! -e "broadcast/$s.s.sol/$CHAIN" && ! -e "cache/$s.s.sol/$CHAIN" ]] || { echo "refusing: broadcast/ or cache/$s.s.sol/$CHAIN exists; run fork.sh down, or move a real log away" >&2; exit 1; }
done
[[ ! -e "$CONFIG" && ! -e "$STATE_DIR" ]] || { echo "refusing: $CONFIG or $STATE_DIR exists; run fork.sh down first" >&2; exit 1; }
! ss -ltn 2>/dev/null | grep -q "127.0.0.1:$PORT " || { echo "refusing: port $PORT is in use" >&2; exit 1; }
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
fail() { echo "FAIL: $*" >&2; down >/dev/null; exit 1; }
ok() { echo "ok: $*"; }

MNEMONIC="test test test test test test test test test test test junk"
devkey() { cast wallet private-key --mnemonic "$MNEMONIC" --mnemonic-index "$1"; }
addr() { cast wallet address --private-key "$1" 2>/dev/null; }
# Anvil's public dev accounts, which anvil keeps unlocked, so the page's injected wallet signs and sends through it.
K_DEPLOYER=$(devkey 0) K_OWNER1=$(devkey 1) K_OWNER2=$(devkey 2) K_CREATOR=$(devkey 4) K_WORKER=$(devkey 5)
DEPLOYER=$(addr "$K_DEPLOYER") OWNER1=$(addr "$K_OWNER1") OWNER2=$(addr "$K_OWNER2") STAKER=$(addr "$(devkey 3)")
CREATOR=$(addr "$K_CREATOR") WORKER=$(addr "$K_WORKER")

nohup anvil --fork-url "$FORK_RPC" --network monad --port "$PORT" --block-time 1 --silent >"$STATE_DIR/anvil.log" 2>&1 &
echo $! >"$STATE_DIR/anvil.pid"
for _ in $(seq 60); do cast chain-id --rpc-url "$LOCAL" >/dev/null 2>&1 && break; sleep 1; done
[[ "$(cast chain-id --rpc-url "$LOCAL" 2>/dev/null)" == "$CHAIN" ]] || fail "anvil fork of chain $CHAIN not up"
# The dev keys are public, so on Monad testnet some of their accounts carry someone's EIP-7702 delegation (code that
# can revert an ERC-721 callback or a transfer). On this fork they are plain accounts again.
for a in $DEPLOYER $OWNER1 $OWNER2 $STAKER $CREATOR $WORKER; do
  cast rpc --rpc-url "$LOCAL" anvil_setBalance "$a" 0x3635c9adc5dea00000 >/dev/null # 1,000 MON
  if [[ "$(cast code --rpc-url "$LOCAL" "$a")" != 0x ]]; then
    cast rpc --rpc-url "$LOCAL" anvil_setCode "$a" 0x >/dev/null
    echo "note: $a had code on testnet (a 7702 delegation on a public dev key); cleared on the fork"
  fi
done
ok "fork of $CHAIN on $LOCAL"

# A fresh 1-of-2 Safe from the canonical v1.4.1 contracts, as the rehearsal makes it.
SAFE_FACTORY=0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67 SAFE_L2=0x29fcB43b46531BcA003ddC8FCB67FFE91900C762
FALLBACK_HANDLER=0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99 ZERO=0x0000000000000000000000000000000000000000
SETUP=$(cast calldata "setup(address[],uint256,address,bytes,address,address,uint256,address)" "[$OWNER1,$OWNER2]" 1 $ZERO 0x $FALLBACK_HANDLER $ZERO 0 $ZERO)
SALT=$(date +%s)
SAFE=$(cast call --rpc-url "$LOCAL" --from "$DEPLOYER" $SAFE_FACTORY "createProxyWithNonce(address,bytes,uint256)(address)" $SAFE_L2 "$SETUP" "$SALT")
cast send --rpc-url "$LOCAL" --private-key "$K_DEPLOYER" $SAFE_FACTORY "createProxyWithNonce(address,bytes,uint256)" $SAFE_L2 "$SETUP" "$SALT" >/dev/null
ok "Safe $SAFE (owners $OWNER1 $OWNER2, threshold 1)"

# The scratch config: testnet's, with the fork's deployer and Safe, and mUSD as the hire's token.
MUSD=$(jq -r '.deployment.rewardTokens[0]' config/monad-testnet.json)
jq --arg safe "$SAFE" --arg admin "$DEPLOYER" --arg musd "$MUSD" '
  .roles.admin = $admin
  | .hireling.safe = $safe | .hireling.schedule.treasury = $safe | .hireling.allocation.treasury = $safe
  | .hireling.allocation.ecosystem = $admin | .hireling.allocation.liquidity = $admin
  | .oddTokens = (.oddTokens // { wallets: [$admin], mint: 1000 })
  | .liquidity = { quote: $musd }' config/monad-testnet.json >"$CONFIG"

KEYSTORES="$STATE_DIR/keystores"
mkdir -m 700 "$KEYSTORES"
(umask 077; printf 'real-%s%s' "$RANDOM" "$RANDOM" >"$KEYSTORES/password")
cast wallet import --keystore-dir "$KEYSTORES" deployer --private-key "$K_DEPLOYER" --unsafe-password "$(cat "$KEYSTORES/password")" >/dev/null 2>&1
cast wallet import --keystore-dir "$KEYSTORES" safe-owner --private-key "$K_OWNER1" --unsafe-password "$(cat "$KEYSTORES/password")" >/dev/null 2>&1
export REHEARSAL_RPC="$LOCAL" NETWORK
env RPC_ENV=REHEARSAL_RPC DEPLOYER_ACCOUNT="$KEYSTORES/deployer" DEPLOYER_PASSWORD_FILE="$KEYSTORES/password" \
  SAFE_OWNER_ACCOUNT="$KEYSTORES/safe-owner" SAFE_OWNER_PASSWORD_FILE="$KEYSTORES/password" \
  bash script/launch-testnet.sh --yes --to sdk >"$STATE_DIR/launch.log" 2>&1 || { tail -30 "$STATE_DIR/launch.log" >&2; fail "launch-testnet.sh"; }
rm -rf "$KEYSTORES"
[[ "$(jq -r .deployment.hireling.safe "$CONFIG" | tr 'A-F' 'a-f')" == "$(echo "$SAFE" | tr 'A-F' 'a-f')" ]] || fail "the promoted config does not name the Safe"
ok "launch-testnet.sh deploy → sdk; config $CONFIG"

# One direct hire in mUSD, settled inside epoch 0, so mining:epoch 0 counts a fee.
cast send --rpc-url "$LOCAL" --private-key "$K_DEPLOYER" "$MUSD" "mint(address,uint256)" "$DEPLOYER" 1000000000 >/dev/null
env DEPLOYER_KEY="$K_DEPLOYER" CREATOR_KEY="$K_CREATOR" WORKER_KEY="$K_WORKER" \
  forge script script/RehearseHireAndMine.s.sol --tc RehearseHire --rpc-url "$LOCAL" --broadcast --slow >"$STATE_DIR/hire.log" 2>&1 \
  || { tail -30 "$STATE_DIR/hire.log" >&2; fail "RehearseHire"; }
ok "one hire settled ($(grep -o 'net to worker [0-9]*' "$STATE_DIR/hire.log" || echo 'see hire.log'))"

# The reused testnet core's admin roles stay with roles.admin after launch-testnet.sh (on testnet too: the Safe holds
# neither, checked read-only on 2 Oct), so the Safe could not pause it. The mainnet deploy moves them to the Safe
# (docs/mainnet-runbook.md); here roles.admin, impersonated, grants the Safe ADMIN_ROLE as that would.
CORE=$(jq -r .deployment.core "$CONFIG") CORE_ADMIN=$(jq -r .roles.admin config/monad-testnet.json)
ADMIN_ROLE=$(cast call --rpc-url "$LOCAL" "$CORE" "ADMIN_ROLE()(bytes32)")
cast rpc --rpc-url "$LOCAL" anvil_impersonateAccount "$CORE_ADMIN" >/dev/null
cast rpc --rpc-url "$LOCAL" anvil_setBalance "$CORE_ADMIN" 0x56bc75e2d63100000 >/dev/null
cast send --rpc-url "$LOCAL" --unlocked --from "$CORE_ADMIN" "$CORE" "grantRole(bytes32,address)" "$ADMIN_ROLE" "$SAFE" >/dev/null
cast rpc --rpc-url "$LOCAL" anvil_stopImpersonatingAccount "$CORE_ADMIN" >/dev/null
[[ "$(cast call --rpc-url "$LOCAL" "$CORE" "hasRole(bytes32,address)(bool)" "$ADMIN_ROLE" "$SAFE")" == true ]] || fail "could not make the Safe the core's admin"
ok "the Safe holds the core's ADMIN_ROLE (fork only; see the note above)"

# The staker holds FACTORY (from the deployer's allocation) to stake from the page.
FACTORY=$(jq -r .deployment.hireling.factory "$CONFIG")
cast send --rpc-url "$LOCAL" --private-key "$K_DEPLOYER" "$FACTORY" "transfer(address,uint256)" "$STAKER" "$(cast to-wei 50000)" >/dev/null

# Every real.e2e.mjs run starts from here: it reverts to this snapshot and takes a fresh one.
SNAPSHOT=$(cast rpc --rpc-url "$LOCAL" evm_snapshot | tr -d '"')
jq -n --arg rpc "$LOCAL" --arg config "$PWD/$CONFIG" --arg safe "$SAFE" --arg deployer "$DEPLOYER" --arg owner1 "$OWNER1" \
  --arg owner2 "$OWNER2" --arg staker "$STAKER" --arg creator "$CREATOR" --arg worker "$WORKER" --arg snapshot "$SNAPSHOT" \
  '{ rpc: $rpc, chainId: 10143, config: $config, safe: $safe, snapshot: $snapshot, accounts: { deployer: $deployer, owner1: $owner1, owner2: $owner2, staker: $staker, creator: $creator, worker: $worker } }' \
  >"$STATE_DIR/state.json"
echo "FORK UP: $STATE_DIR/state.json"
