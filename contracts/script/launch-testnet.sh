#!/usr/bin/env bash
# G1: the Hireling v1 launch on Monad testnet (core reused), the docs/mainnet-runbook.md sequence without the seed, for
# the coordinator to run once the wallets hold MON. Refuses chain 143. From the repo root, with keystores (below):
#   bash -c 'set -a; . ./.env.local; set +a; DEPLOYER_ACCOUNT=<name> DEPLOYER_PASSWORD_FILE=<file> \
#     SAFE_OWNER_ACCOUNT=<name> SAFE_OWNER_PASSWORD_FILE=<file> bash contracts/script/launch-testnet.sh [flags]'
# or, as the explicit testnet fallback, with the raw keys from .env.local: `… launch-testnet.sh --private-keys [flags]`.
# Steps (any failure stops the run; every transaction hash is printed, and listed again at the end):
#   0. checks: the RPC's chain is the config's and not 143; no v1 deployment recorded yet; the deployer key is
#      roles.admin; the Safe is v1.4.1 with threshold 1 and the Safe-owner key is an owner; the oddTokens config
#      exists; both senders hold enough MON for the gas limits at twice the current gas price;
#   1. DeployHireling dry run (no --broadcast);
#   2. DeployHireling --broadcast --slow, from the deployer;
#   3. PromoteHireling (reads only; writes config/<network>.json, which the coordinator commits);
#   4. SafeAccept (six execTransactions from the Safe owner), then its check();
#   5. readback: owner() == Safe and pendingOwner() == 0 on vault, feeSchedule, holding, evaluator, distributor and
#      miningReserve;
#   6. the SDK loads the promoted deployment (`deployment('monad-testnet')`: a hireling-v1 main pair under this Safe);
#   7. DeployOddTokens, from the deployer.
# Flags:
#   --fee-proposal   the Safe proposes a fee schedule through execTransaction: FEE_PROPOSAL, as JSON
#                    {"thresholds":[…],"bps":[…],"treasury":"0x…"} with thresholds in whole FACTORY like the config;
#                    default the config's hireling.schedule. Anyone can `execute()` it from FeeSchedule.DELAY (3 days)
#                    later until 7 days after that; an early execute is shown to refuse (eth_call, nothing sent).
#   --holding-probe  the Safe proposes HOLDING_PROBE (default 0x…dEaD, which nobody controls) as a vault Holding, and an
#                    early acceptHolding is shown to refuse (eth_call). It stays pending; anyone may accept it from
#                    8 to 15 days later, and the Safe's cancelHoldingProposal() withdraws it.
#   --dry-run        stop after step 1.      --yes   don't ask before broadcasting.
#   --from STEP      resume at deploy|promote|accept|readback|sdk|odd|flags (after fixing whatever stopped a run;
#                    finish a cut-off deploy with forge's --resume first).   --to STEP   stop after STEP.
# Signers: an encrypted Foundry keystore per role, as on mainnet (docs/mainnet-runbook.md §2), unlocked by a password
# file you own with mode 600. One-time: `cast wallet import <name> --interactive` (it prompts, so the key never reaches
# a command line). DEPLOYER_ACCOUNT and SAFE_OWNER_ACCOUNT name the keystore in ~/.foundry/keystores (or give its
# path); DEPLOYER_PASSWORD_FILE and SAFE_OWNER_PASSWORD_FILE are the password files.
#   --private-keys   the explicit testnet fallback: raw keys from env vars, by name (DEPLOYER_KEY_ENV=DEPLOYER_PRIVATE_KEY,
#                    SAFE_OWNER_KEY_ENV=SAFE_BACKUP_TESTNET_PRIVATE_KEY), passed as --private-key, which other local
#                    users can read in /proc while forge and cast run.
# The RPC comes from an env var by name too (RPC_ENV=MONAD_TESTNET_RPC_URL). No value is printed or written, and the
# output is redacted.
# NETWORK (default monad-testnet) selects config/<NETWORK>.json; script/rehearse-launch-testnet.sh uses it on a fork.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(cd .. && pwd)"

NETWORK="${NETWORK:-monad-testnet}"
export NETWORK
CONFIG="config/$NETWORK.json"
RPC_ENV="${RPC_ENV:-MONAD_TESTNET_RPC_URL}"
DEPLOYER_KEY_ENV="${DEPLOYER_KEY_ENV:-DEPLOYER_PRIVATE_KEY}"
SAFE_OWNER_KEY_ENV="${SAFE_OWNER_KEY_ENV:-SAFE_BACKUP_TESTNET_PRIVATE_KEY}"
MAINNET=143
ZERO=0x0000000000000000000000000000000000000000
SIX=(vault feeSchedule holding evaluator distributor miningReserve)
STEPS=(deploy promote accept readback sdk odd flags)
# Gas limits from the fork rehearsal (Monad charges the limit), with headroom.
GAS_DEPLOYER=$((24 * 1000000)) # DeployHireling (reused core) + DeployOddTokens
GAS_SAFE_OWNER=$((2 * 1000000)) # SafeAccept + the two proposals

FEE_PROPOSAL_FLAG=0 HOLDING_PROBE_FLAG=0 DRY_RUN=0 YES=0 FROM=deploy TO=flags PRIVATE_KEYS=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --fee-proposal) FEE_PROPOSAL_FLAG=1 ;;
    --holding-probe) HOLDING_PROBE_FLAG=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --yes) YES=1 ;;
    --private-keys) PRIVATE_KEYS=1 ;;
    --from) FROM="${2:-}"; shift ;;
    --to) TO="${2:-}"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
step_index() { local i; for i in "${!STEPS[@]}"; do [[ "${STEPS[$i]}" == "$1" ]] && { echo "$i"; return; }; done; echo -1; }
FROM_I=$(step_index "$FROM") TO_I=$(step_index "$TO")
[[ $FROM_I -ge 0 && $TO_I -ge $FROM_I ]] || { echo "--from/--to take one of, in order: ${STEPS[*]}" >&2; exit 2; }
runs() { local i; i=$(step_index "$1"); [[ $FROM_I -le $i && $i -le $TO_I ]]; }

# Values by name only. Export them so the redactor (a child process) can read them from its environment.
need() { [[ -n "${!1:-}" ]] || { echo "set $1 in the environment (its name, from $2)" >&2; exit 2; }; export "${1?}"; }
need "$RPC_ENV" RPC_ENV
# forge/cast signer arguments per role: a keystore and its password file, or (--private-keys) the raw key.
signer() {
  local role=$1 key_env account password
  local -n args="${role}_SIGNER"
  if [[ $PRIVATE_KEYS -eq 1 ]]; then
    key_env="${role}_KEY_ENV"
    local name="${!key_env}"
    need "$name" "$key_env"
    args=(--private-key "${!name}")
    return
  fi
  account="${role}_ACCOUNT" password="${role}_PASSWORD_FILE"
  [[ -n "${!account:-}" && -n "${!password:-}" ]] \
    || { echo "set $account and $password (an encrypted Foundry keystore), or pass --private-keys on testnet" >&2; exit 2; }
  [[ -f "${!password}" && -O "${!password}" && "$(stat -c %a "${!password}")" =~ ^[46]00$ ]] \
    || { echo "$password must be a file you own with mode 600" >&2; exit 2; }
  if [[ "${!account}" == */* ]]; then args=(--keystore "${!account}" --password-file "${!password}")
  else args=(--account "${!account}" --password-file "${!password}"); fi
}
DEPLOYER_SIGNER=() SAFE_OWNER_SIGNER=()
signer DEPLOYER
signer SAFE_OWNER
RPC="${!RPC_ENV}"
export REDACT_NAMES="$RPC_ENV $DEPLOYER_KEY_ENV $SAFE_OWNER_KEY_ENV"
redact() {
  perl -pe 'BEGIN { @s = grep { length } map { $ENV{$_} // "" } split " ", $ENV{REDACT_NAMES} }
            for my $s (@s) { s/\Q$s\E/<redacted>/g }'
}

LOGS="${LAUNCH_LOGS:-$(mktemp -d)}" # LAUNCH_LOGS: an existing private directory for the logs and hashes.tsv
mkdir -p "$LOGS" && chmod 700 "$LOGS"
HASHES="$LOGS/hashes.tsv"
: >"$HASHES"
fail() { echo "FAIL: $*" >&2; echo "logs: $LOGS" >&2; exit 1; }
ok() { echo "ok: $*"; }
# Runs a command with its output (redacted) in a log; on failure shows the tail.
log() {
  local f="$LOGS/$1"; shift
  if ! "$@" 2>&1 | redact >"$f"; then tail -30 "$f" >&2; return 1; fi
}
hash_line() { printf '%s\t%s\n' "$1" "$2" >>"$HASHES"; printf '  tx %-58s %s\n' "$1" "$2"; }

# Every transaction of a forge broadcast run, from its run log; all receipts must have succeeded.
forge_hashes() {
  local script=$1 run="broadcast/$1.s.sol/$CHAIN/run-latest.json"
  [[ -f "$run" ]] || fail "$script: no run log at $run"
  jq -e '(.receipts | length) == (.transactions | length) and all(.receipts[]; .status == "0x1")' "$run" >/dev/null \
    || fail "$script: a transaction is missing or failed in $run"
  while IFS=$'\t' read -r h what; do hash_line "$script $what" "$h"; done < <(jq -r --arg safe "${SAFE,,}" '.transactions[]
    | [.hash, (if .transactionType == "CREATE" then "create \(.contractName // "?") \(.contractAddress)"
               else "call \(.contractName // (if (.transaction.to | ascii_downcase) == $safe then "Safe" else .transaction.to end))"
                 + ".\(.function // "" | sub("\\(.*"; ""))" end)] | @tsv' "$run")
}

# A threshold-1 Safe transaction from one owner, with its pre-validated signature (r = owner, s = 0, v = 1). With
# safeTxGas 0 a failed inner call reverts the whole transaction; ExecutionSuccess is checked as well.
EXEC_SIG="execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)"
EXEC_SUCCESS=$(cast keccak "ExecutionSuccess(bytes32,uint256)")
safe_exec() {
  local label=$1 to=$2 data=$3 out h
  local sig="$(cast abi-encode "f(address)" "$SAFE_OWNER")$(printf '%064d' 0)01"
  if ! out=$(cast send --rpc-url "$RPC" "${SAFE_OWNER_SIGNER[@]}" --json "$SAFE" "$EXEC_SIG" \
    "$to" 0 "$data" 0 0 0 0 $ZERO $ZERO "$sig" 2>"$LOGS/cast.err"); then
    redact <"$LOGS/cast.err" | tail -5 >&2
    fail "$label"
  fi
  h=$(jq -r .transactionHash <<<"$out")
  [[ "$(jq -r .status <<<"$out")" == "0x1" ]] || fail "$label: reverted ($h)"
  jq -e --arg t "$EXEC_SUCCESS" --arg s "${SAFE,,}" \
    'any(.logs[]; (.address | ascii_downcase) == $s and .topics[0] == $t)' <<<"$out" >/dev/null \
    || fail "$label: no ExecutionSuccess ($h)"
  hash_line "$label" "$h"
}

# An eth_call that must revert with the given custom error (nothing is sent).
refuses() {
  local label=$1 error=$2 to=$3 call=$4 out sel
  sel=$(cast sig "$error")
  if out=$(cast call --rpc-url "$RPC" "$to" "$call" 2>&1 | redact); then fail "$label: it did not refuse"; fi
  grep -q "${sel#0x}" <<<"$out" || { echo "$out" | tail -3 >&2; fail "$label: refused, but not with $error"; }
  ok "$label refuses with $error (eth_call, nothing sent)"
}

json() { jq -r "$1" "$CONFIG"; }
call() { cast call --rpc-url "$RPC" "$@" 2>/dev/null; }
mon() { cast from-wei "$1" 2>/dev/null | cut -c1-8; }

# 0. Checks, before anything is sent.
[[ -f "$CONFIG" ]] || fail "no $CONFIG"
CHAIN=$(cast chain-id --rpc-url "$RPC" 2>/dev/null) || fail "the RPC in $RPC_ENV does not answer"
[[ "$CHAIN" != "$MAINNET" ]] || fail "refusing: the RPC is chain 143 (mainnet)"
[[ "$(json .chainId)" != "$MAINNET" && "$NETWORK" != *mainnet* ]] || fail "refusing: $CONFIG is a mainnet config"
[[ "$CHAIN" == "$(json .chainId)" ]] || fail "the RPC is chain $CHAIN, $CONFIG is chain $(json .chainId)"
DEPLOYER=$(cast wallet address "${DEPLOYER_SIGNER[@]}" 2>/dev/null) || fail "the deployer keystore does not unlock"
SAFE_OWNER=$(cast wallet address "${SAFE_OWNER_SIGNER[@]}" 2>/dev/null) || fail "the Safe-owner keystore does not unlock"
SAFE=$(json .hireling.safe)
echo "network $NETWORK (chain $CHAIN); deployer $DEPLOYER; Safe $SAFE, sent by owner $SAFE_OWNER; logs $LOGS"
if runs deploy; then
  [[ "$(json '.deployment.hireling // empty')" == "" ]] || fail "$CONFIG already records a v1 deployment (use --from)"
  [[ "${DEPLOYER,,}" == "$(json .roles.admin | tr 'A-F' 'a-f')" ]] || fail "the deployer key is not roles.admin"
fi
if runs odd; then
  jq -e '(.oddTokens.wallets | type == "array" and length > 0) and (.oddTokens.mint | type == "number")' "$CONFIG" \
    >/dev/null || fail "$CONFIG needs oddTokens = { wallets: [...], mint: <whole tokens> } for DeployOddTokens"
fi
[[ "$(call "$SAFE" "VERSION()(string)")" == '"1.4.1"' ]] || fail "the Safe is not v1.4.1"
[[ "$(call "$SAFE" "getThreshold()(uint256)")" == "1" ]] || fail "the Safe's threshold is not 1 (SafeAccept needs it)"
[[ "$(call "$SAFE" "isOwner(address)(bool)" "$SAFE_OWNER")" == "true" ]] || fail "the Safe-owner key is not an owner"
PRICE=$(cast gas-price --rpc-url "$RPC" 2>/dev/null)
for who in DEPLOYER SAFE_OWNER; do
  gas_var="GAS_$who"
  want=$(bc <<<"${!gas_var} * $PRICE * 2") # wei: past bash's 64-bit integers
  have=$(cast balance --rpc-url "$RPC" "${!who}" 2>/dev/null)
  echo "  $who holds $(mon "$have") MON; this run may need $(mon "$want") (gas limits at twice $(cast from-wei "$PRICE" gwei | cut -c1-6) gwei)"
  [[ $(bc <<<"$have >= $want") -eq 1 ]] || fail "$who ${!who} holds too little MON"
done
ok "checks passed"

# 1–2. DeployHireling.
if runs deploy; then
  log 1-dry-run.log forge script script/DeployHireling.s.sol --rpc-url "$RPC" "${DEPLOYER_SIGNER[@]}" \
    || fail "DeployHireling dry run"
  grep -E "Estimated" "$LOGS/1-dry-run.log" | sed 's/^ */  /' || true
  ok "dry run (nothing sent; log $LOGS/1-dry-run.log)"
  [[ $DRY_RUN -eq 0 ]] || exit 0
  if [[ $YES -eq 0 && -t 0 ]]; then
    read -r -p "broadcast DeployHireling to chain $CHAIN? [y/N] " answer
    [[ "$answer" == y || "$answer" == Y ]] || { echo "stopped before broadcasting"; exit 0; }
  fi
  log 2-deploy.log forge script script/DeployHireling.s.sol --rpc-url "$RPC" "${DEPLOYER_SIGNER[@]}" \
    --broadcast --slow || fail "DeployHireling broadcast (finish it with --resume, then --from promote)"
  forge_hashes DeployHireling
  ok "DeployHireling broadcast"
fi

# 3. PromoteHireling.
if runs promote; then
  log 3-promote.log forge script script/PromoteHireling.s.sol --rpc-url "$RPC" || fail "PromoteHireling"
  [[ "$(json .deployment.hireling.safe | tr 'A-F' 'a-f')" == "${SAFE,,}" ]] || fail "promotion did not record the Safe"
  ok "promoted: $CONFIG records the v1 deployment (hireling.block $(json .deployment.hireling.block)); the coordinator commits it"
fi
address_of() {
  case "$1" in
    holding | evaluator) json ".deployment.main.$1" ;;
    *) json ".deployment.hireling.$1" ;;
  esac
}

# 4. SafeAccept.
if runs accept; then
  log 4-accept.log forge script script/SafeAccept.s.sol --rpc-url "$RPC" "${SAFE_OWNER_SIGNER[@]}" \
    --broadcast --slow || fail "SafeAccept"
  forge_hashes SafeAccept
  log 4-accept-check.log forge script script/SafeAccept.s.sol --sig "check()" --rpc-url "$RPC" || fail "SafeAccept check"
  ok "the Safe accepted the six"
fi

# 5. Readback.
if runs readback; then
  for name in "${SIX[@]}"; do
    a=$(address_of "$name")
    [[ "$(call "$a" "owner()(address)" | tr 'A-F' 'a-f')" == "${SAFE,,}" ]] || fail "$name $a: owner() is not the Safe"
    [[ "$(call "$a" "pendingOwner()(address)")" == "$ZERO" ]] || fail "$name $a: a handover is still pending"
    echo "  $name $a owner = Safe"
  done
  ok "owner() == Safe on all six, nothing pending"
fi

# 6. The SDK.
if runs sdk; then
  SDK_TS="$LOGS/sdk-check.ts"
  cat >"$SDK_TS" <<EOF
import { readFileSync } from 'node:fs'
import { deployment, deploymentFromConfig } from '$REPO/packages/sdk/src/index.ts'
// The real network reads the config the SDK bundles; a rehearsal passes its scratch config (network monad-testnet).
const d = process.argv[2] === 'monad-testnet'
  ? deployment('monad-testnet')
  : deploymentFromConfig('monad-testnet', JSON.parse(readFileSync(process.argv[3], 'utf8')))
const main = d.stacks.main
const same = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase()
if (d.chainId !== $CHAIN || d.hireling === null || !same(d.hireling.safe, process.argv[4]) || main?.kind !== 'hireling-v1'
  || !same(main.factory, d.hireling.factory) || !same(main.holding, process.argv[5])) {
  console.error('the SDK does not load the promoted v1 deployment', JSON.stringify({ chainId: d.chainId, main, hireling: d.hireling }))
  process.exit(1)
}
console.log('sdk: monad-testnet main = hireling-v1, holding ' + main.holding + ', evaluator ' + main.evaluator + ', Safe ' + d.hireling.safe)
EOF
  bun "$SDK_TS" "$NETWORK" "$PWD/$CONFIG" "$SAFE" "$(address_of holding)" || fail "SDK load check"
  ok "the SDK loads the promoted deployment"
fi

# 7. DeployOddTokens.
if runs odd; then
  log 7-odd.log forge script script/DeployOddTokens.s.sol --rpc-url "$RPC" "${DEPLOYER_SIGNER[@]}" \
    --broadcast --slow || fail "DeployOddTokens"
  forge_hashes DeployOddTokens
  grep -E "blocklist|gasBurner" "$LOGS/7-odd.log" | sed 's/^ */  /'
  ok "odd tokens deployed; record them under .deployment.oddTokens (block $(cast to-dec "$(jq -r '.receipts[0].blockNumber' "broadcast/DeployOddTokens.s.sol/$CHAIN/run-latest.json")"))"
fi

# Flags.
if [[ $FEE_PROPOSAL_FLAG -eq 1 ]] && runs flags; then
  FEES=$(address_of feeSchedule)
  SCHEDULE="${FEE_PROPOSAL:-$(jq -c .hireling.schedule "$CONFIG")}"
  T=$(jq -r '[.thresholds[] | if . == 0 then "0" else tostring + "000000000000000000" end] | join(",")' <<<"$SCHEDULE")
  B=$(jq -r '.bps | join(",")' <<<"$SCHEDULE")
  TREASURY=$(jq -r .treasury <<<"$SCHEDULE")
  [[ $(jq '.thresholds | length' <<<"$SCHEDULE") -eq 4 && $(jq '.bps | length' <<<"$SCHEDULE") -eq 4 ]] \
    || fail "FEE_PROPOSAL needs four thresholds and four bps"
  safe_exec "fee proposal (Safe → FeeSchedule.propose)" "$FEES" \
    "$(cast calldata "propose((uint256[4],uint16[4],address))" "([$T],[$B],$TREASURY)")"
  ETA=$(call "$FEES" "pending()((uint256[4],uint16[4],address),uint48)" | tail -1 | awk '{print $1}')
  refuses "an early FeeSchedule.execute()" "ScheduleTimelocked(uint48)" "$FEES" "execute()"
  ok "fee schedule proposed (thresholds $(jq -c .thresholds <<<"$SCHEDULE") FACTORY, bps $B, treasury $TREASURY); anyone can execute it from $(date -u -d "@$ETA" '+%Y-%m-%d %H:%M UTC') for 7 days: cast send $FEES 'execute()'"
fi
if [[ $HOLDING_PROBE_FLAG -eq 1 ]] && runs flags; then
  VAULT=$(address_of vault)
  PROBE="${HOLDING_PROBE:-0x000000000000000000000000000000000000dEaD}"
  [[ "$(call "$VAULT" "isHolding(address)(bool)" "$PROBE")" == "false" ]] || fail "$PROBE is already a Holding"
  safe_exec "holding probe (Safe → StakeVault.proposeHolding $PROBE)" "$VAULT" \
    "$(cast calldata "proposeHolding(address)" "$PROBE")"
  refuses "an early StakeVault.acceptHolding()" "HoldingTimelocked(uint48)" "$VAULT" "acceptHolding()"
  ok "Holding $PROBE proposed; acceptable from 8 days on, for 7 days; the Safe's cancelHoldingProposal() withdraws it"
fi

echo
echo "TRANSACTIONS (for docs/reality-check.md), chain $CHAIN:"
awk -F'\t' '{ printf "  %s  %s\n", $2, $1 }' "$HASHES"
echo "LAUNCH-TESTNET DONE"
