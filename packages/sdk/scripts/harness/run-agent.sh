#!/usr/bin/env bash
# Launches one headless agent harness against the staging board's MCP server with nothing but its own key.
#
#   run-agent.sh <claude|codex|grok> <name> <KEY_VAR> <prompt-file> [worker|arbitrator]
#
# The key comes from .env.local under KEY_VAR and is passed as WORKER_PRIVATE_KEY (or ARBITRATOR_PRIVATE_KEY for the
# arbitrator role) through `env -i`; the only other variables are the testnet RPC and the harness's model-proxy
# settings from ~/.config (secrets.env + cliproxy.env). The agent works in $RUNS/<name>; its transcript goes to
# $RUNS/<name>.jsonl and stderr to $RUNS/<name>.err (RUNS defaults to /tmp/agent-jobs-runs).
set -uo pipefail
harness=$1 name=$2 keyvar=$3 prompt=$4 role=${5:-worker}
root=$(cd "$(dirname "$0")/../../../.." && pwd)
runs=${RUNS:-/tmp/agent-jobs-runs}
mcp=${MCP_URL:-https://agentjobs-api-staging-ba2zqmaom6el4lws.kristjan-grm11775.workers.dev/mcp}
work=$runs/$name
mkdir -p "$work"
key=$(grep "^$keyvar=" "$root/.env.local" | cut -d= -f2-)
[ -n "$key" ] || { echo "$keyvar is not in .env.local" >&2; exit 2; }
rpc=$(grep "^MONAD_TESTNET_RPC_URL=" "$root/.env.local" | cut -d= -f2- | awk '{print $1}')
keyname=WORKER_PRIVATE_KEY
[ "$role" = arbitrator ] && keyname=ARBITRATOR_PRIVATE_KEY
set -a; . ~/.config/secrets.env >/dev/null 2>&1; . ~/.config/cliproxy.env >/dev/null 2>&1; set +a
base=(env -i HOME="$HOME" PATH="$PATH" TERM=dumb USER="$USER" LANG=C.UTF-8
  ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-}" ANTHROPIC_AUTH_TOKEN="${ANTHROPIC_AUTH_TOKEN:-}" ANTHROPIC_CUSTOM_HEADERS="${ANTHROPIC_CUSTOM_HEADERS:-}"
  CLIPROXY_API_KEY="${CLIPROXY_API_KEY:-}" "$keyname=$key" RPC="$rpc")
cd "$work"
case $harness in
  claude)
    echo "{\"mcpServers\":{\"agent-jobs\":{\"type\":\"http\",\"url\":\"$mcp\"}}}" > mcp.json
    "${base[@]}" claude -p "$(cat "$prompt")" --mcp-config mcp.json --strict-mcp-config --dangerously-skip-permissions \
      --output-format stream-json --verbose > "$runs/$name.jsonl" 2> "$runs/$name.err" ;;
  codex)
    "${base[@]}" codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --json \
      -c "mcp_servers.agent-jobs.url=\"$mcp\"" "$(cat "$prompt")" > "$runs/$name.jsonl" 2> "$runs/$name.err" ;;
  grok)
    "${base[@]}" grok mcp add -s project -t http agent-jobs "$mcp" > /dev/null 2>&1
    "${base[@]}" grok -p "$(cat "$prompt")" --always-approve --cwd "$work" --output-format streaming-json \
      > "$runs/$name.jsonl" 2> "$runs/$name.err" ;;
  *) echo "unknown harness $harness" >&2; exit 2 ;;
esac
echo "exit $?" >> "$runs/$name.err"
