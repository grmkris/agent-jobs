# Sourced by script/launch-testnet.sh and the four fork rehearsals (rehearse-launch.sh, rehearse-launch-testnet.sh,
# rehearse-flows-testnet.sh, rehearse-hireling-pipeline.sh), which call take_launch_lock before anything else (the
# G1-DRY-001 residual). One exclusive flock per checkout, on contracts/.launch.lock, held on fd 9 for the whole run: a
# second launch or rehearsal started meanwhile refuses at once instead of waiting. A rehearsal's own launch-testnet.sh
# inherits fd 9, and with it the lock. A process that may outlive the run (anvil, kept by KEEP=1) is started with 9>&-
# so it never holds the lock.
LAUNCH_LOCK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.launch.lock"
take_launch_lock() {
  # Already held by the run that started this one: fd 9 is that run's open lock file.
  if [[ /proc/self/fd/9 -ef "$LAUNCH_LOCK" ]] && flock -n 9; then return 0; fi
  exec 9>>"$LAUNCH_LOCK"
  flock -n 9 || { echo "refusing: another launch or rehearsal is running in this checkout (it holds $LAUNCH_LOCK)" >&2; exit 1; }
}
