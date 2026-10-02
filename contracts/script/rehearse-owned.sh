# Sourced by the fork rehearsals (rehearse-launch.sh, rehearse-launch-testnet.sh, rehearse-flows-testnet.sh,
# rehearse-hireling-pipeline.sh): on exit
# they delete only what their own run created, after checking it still owns it (G1-DRY-001). A real launch run from
# the same checkout writes the same broadcast/ and cache/ paths, and must never be swept away by a rehearsal.

# owned_runs <chain> <rpc> <signer address>...: for each script in $SCRIPTS, deletes a broadcast run log on <chain>
# only if it has transactions, every one was sent by those signers, and its cache twin (forge's record of the RPC each
# was sent to) names only <rpc>, this rehearsal's loopback fork, which no real launch uses; then the twin too. Anything
# else is kept and named; the directories (with forge's dry-run/ ones) go only once empty.
owned_runs() {
  local chain=$1 rpc=$2 ours s d f twin
  shift 2
  ours=$(printf '%s\n' "$@" | tr 'A-F' 'a-f' | jq -R . | jq -sc .)
  for s in "${SCRIPTS[@]}"; do
    for f in "broadcast/$s.s.sol/$chain"/*.json "broadcast/$s.s.sol/$chain"/dry-run/*.json; do
      [[ -e "$f" ]] || continue
      twin="cache/${f#broadcast/}"
      if jq -e --argjson ours "$ours" '(.transactions | length) > 0
          and all(.transactions[]; (.transaction.from // "" | ascii_downcase) as $a | $ours | index($a) != null)' \
          "$f" >/dev/null 2>&1 \
        && jq -e --arg rpc "$rpc" '(.transactions | length) > 0 and all(.transactions[]; .rpc == $rpc)' "$twin" >/dev/null 2>&1; then
        rm -f "$f" "$twin"
      else
        echo "kept $f: not sent by this rehearsal's signers to its fork" >&2
      fi
    done
    for d in broadcast cache; do rmdir "$d/$s.s.sol/$chain/dry-run" "$d/$s.s.sol/$chain" 2>/dev/null || true; done
  done
}

# owned_file <path> <jq path> <value>: deletes <path> only if <jq path> in it is <value> (addresses compared in lower
# case), e.g. a scratch config or a candidate naming this run's Safe.
owned_file() {
  [[ -e "$1" ]] || return 0
  if [[ -n "$3" && "$(jq -r "$2" "$1" 2>/dev/null | tr 'A-F' 'a-f')" == "$(tr 'A-F' 'a-f' <<<"$3")" ]]; then
    rm -f "$1"
  else
    echo "kept $1: its $2 is not this rehearsal's" >&2
  fi
}
