#!/bin/bash

finish_console() {
  local result=$?
  trap - EXIT
  [[ -n "${runtime_tail_pid:-}" ]] && kill "$runtime_tail_pid" 2>/dev/null || true
  [[ -n "${startup_tail_pid:-}" ]] && kill "$startup_tail_pid" 2>/dev/null || true
  [[ -n "${console_owner_pid:-}" ]] && kill "$console_owner_pid" 2>/dev/null || true
  if [[ "$result" -ne 0 ]]; then
    echo
    echo "Development launcher failed (exit code $result). See the output above."
    echo "Press Enter to close..."
    read -r _ || true
  fi
  exit "$result"
}
trap finish_console EXIT
trap 'exit 130' INT TERM
trap 'exit 0' USR1
trap 'exit 1' USR2
set -e

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
cd "$SCRIPT_DIR"
source "$SCRIPT_DIR/scripts/macos-dev-environment.sh"

export ANTIGRAVITY_QUOTA_DEV_EXTERNAL_START=1
LOG_DIR="$HOME/Library/Logs/Antigravity Quota Injector"
mkdir -p "$LOG_DIR"
STARTUP_LOG="$(mktemp "$LOG_DIR/dev-launch-XXXXXXXX")"
RUNTIME_LOG="$LOG_DIR/injector.log"
touch "$RUNTIME_LOG"

node "$SCRIPT_DIR/scripts/macos-dev-console-owner.mjs" "$LOG_DIR" &
console_owner_pid=$!

echo "Starting Antigravity Quota Injector development version..."
echo "Startup log: $STARTUP_LOG"
echo "Runtime log: $RUNTIME_LOG"
echo "This window stays open while the injector runs. Closing it only stops log viewing."
echo "Recent runtime output (previous launches may appear here):"
tail -n 20 "$RUNTIME_LOG"

tail -n 0 -F "$RUNTIME_LOG" &
runtime_tail_pid=$!
tail -n +1 -F "$STARTUP_LOG" &
startup_tail_pid=$!

nohup /bin/bash "$SCRIPT_DIR/scripts/start-injector-macos.sh" >>"$STARTUP_LOG" 2>&1 < /dev/null &
launcher_pid=$!

set +e
wait "$launcher_pid"
result=$?
set -e

if [[ "$result" -ne 0 ]]; then
  echo "Complete startup output:"
  cat "$STARTUP_LOG"
  exit "$result"
fi

if node -e "import('node:net').then(({createConnection})=>{const s=createConnection({host:'127.0.0.1',port:Number(process.env.ANTIGRAVITY_QUOTA_INSTANCE_PORT||49239)});s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),300);})" 2>/dev/null; then
  echo "Launcher returned successfully. Continuing to follow the running injector's logs."
  echo "Close this window to stop viewing logs; the background injector remains running."
  wait "$runtime_tail_pid"
else
  echo "Antigravity closed; injector exited cleanly."
fi
