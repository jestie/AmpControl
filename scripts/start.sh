#!/usr/bin/env bash
# Start SoundControl in the background (no systemd needed).
# Output goes to logs/app.log; the process id to logs/soundcontrol.pid.
# Safe to run twice: it will not start a second copy.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
mkdir -p logs
PIDFILE="logs/soundcontrol.pid"
LOG="logs/app.log"

# Find running copies of this app (by working directory, so a copy the
# one-click updater relaunched under a new pid is found too).
find_pids() {
  local p
  for p in $(pgrep -x node || true); do
    tr "\0" " " < "/proc/$p/cmdline" 2>/dev/null | grep -q "src/server.js" || continue
    [ "$(readlink -f "/proc/$p/cwd" 2>/dev/null)" = "$ROOT" ] && echo "$p"
  done
  return 0
}

running="$(find_pids)"
if [ -n "$running" ]; then
  echo "SoundControl is already running (pid $(echo $running | tr '\n' ' '))."
  exit 0
fi

command -v node >/dev/null || { echo "node is not installed or not on PATH." >&2; exit 1; }
[ -d node_modules ] || { echo "Installing dependencies..."; npm install --omit=dev; }

# Ports from .env (defaults match src/server.js)
PORT="$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 || true)"; PORT="${PORT:-8095}"
HTTPS_PORT="$(grep -E '^HTTPS_PORT=' .env 2>/dev/null | cut -d= -f2 || true)"
TLS_CERT="$(grep -E '^TLS_CERT=' .env 2>/dev/null | cut -d= -f2 || true)"

echo "--- start $(date -Is) ---" >> "$LOG"
nohup node src/server.js >> "$LOG" 2>&1 < /dev/null &
echo $! > "$PIDFILE"

# Wait up to 10 s for the HTTP port to open
for _ in $(seq 1 20); do
  if ss -ltn 2>/dev/null | grep -q ":$PORT "; then
    echo "SoundControl started (pid $(cat "$PIDFILE"))."
    echo "  http://localhost:$PORT"
    [ -n "$TLS_CERT" ] && [ -n "$HTTPS_PORT" ] && echo "  https://localhost:$HTTPS_PORT"
    echo "  log: $ROOT/$LOG"
    exit 0
  fi
  if ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "SoundControl exited during startup. Last log lines:" >&2
    tail -n 20 "$LOG" >&2
    rm -f "$PIDFILE"
    exit 1
  fi
  sleep 0.5
done
echo "Started (pid $(cat "$PIDFILE")) but port $PORT is not open yet; check $LOG" >&2
