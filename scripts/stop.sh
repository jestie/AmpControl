#!/usr/bin/env bash
# Stop SoundControl started by scripts/start.sh (or relaunched by the updater).
# Sends SIGTERM for a clean shutdown, then SIGKILL after 10 s if needed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDFILE="$ROOT/logs/soundcontrol.pid"

find_pids() {
  local p
  for p in $(pgrep -x node || true); do
    tr "\0" " " < "/proc/$p/cmdline" 2>/dev/null | grep -q "src/server.js" || continue
    [ "$(readlink -f "/proc/$p/cwd" 2>/dev/null)" = "$ROOT" ] && echo "$p"
  done
  return 0
}

pids="$(find_pids)"
if [ -z "$pids" ]; then
  echo "SoundControl is not running."
  rm -f "$PIDFILE"
  exit 0
fi

if [ -n "${INVOCATION_ID:-}" ] || systemctl --user is-active --quiet soundcontrol 2>/dev/null; then
  echo "Note: a systemd unit 'soundcontrol' is active; use: systemctl --user stop soundcontrol" >&2
fi

echo "Stopping SoundControl (pid $(echo $pids | tr '\n' ' '))..."
kill -TERM $pids 2>/dev/null || true

for _ in $(seq 1 20); do
  [ -z "$(find_pids)" ] && { rm -f "$PIDFILE"; echo "Stopped."; exit 0; }
  sleep 0.5
done

echo "Still running after 10 s; forcing it." >&2
kill -KILL $(find_pids) 2>/dev/null || true
rm -f "$PIDFILE"
echo "Stopped (forced)."
