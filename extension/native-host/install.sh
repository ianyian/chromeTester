#!/usr/bin/env bash
# Installs the native messaging host for Chrome / Chromium or Firefox on Linux.
# Usage: sudo ./install.sh [EXTENSION_ID] [chrome|firefox]  (system-wide)
#        ./install.sh [EXTENSION_ID] [chrome|firefox]       (current user only)
set -euo pipefail
BROWSER="${2:-chrome}"
case "$BROWSER" in
  chrome) EXT_ID="${1:-ekhaanoedcoajbabpjfmhjmkjpkhppka}" ;;
  firefox) EXT_ID="${1:-pcb-tester-collector@chrome-tester}" ;;
  *) echo "Unsupported browser: $BROWSER (use chrome or firefox)" >&2; exit 1 ;;
esac
HOST_NAME="com.pcbtester.hostinfo"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ "$(id -u)" -eq 0 ]; then
  BIN_DIR="/opt/pcb-tester"
  if [ "$BROWSER" = firefox ]; then
    TARGETS=("/usr/lib/mozilla/native-messaging-hosts" "/usr/lib64/mozilla/native-messaging-hosts")
  else
    TARGETS=("/etc/opt/chrome/native-messaging-hosts" "/etc/chromium/native-messaging-hosts")
  fi
else
  BIN_DIR="$HOME/.local/share/pcb-tester"
  if [ "$BROWSER" = firefox ]; then
    TARGETS=("$HOME/.mozilla/native-messaging-hosts")
  else
    TARGETS=("$HOME/.config/google-chrome/NativeMessagingHosts" "$HOME/.config/chromium/NativeMessagingHosts")
  fi
fi

if [ "$BROWSER" = firefox ]; then
  ACCESS='"allowed_extensions": ["'"$EXT_ID"'"]'
else
  ACCESS='"allowed_origins": ["chrome-extension://'"$EXT_ID"'/"]'
fi

mkdir -p "$BIN_DIR"
install -m 755 "$SRC_DIR/pcb_hostinfo.py" "$BIN_DIR/pcb_hostinfo.py"

for d in "${TARGETS[@]}"; do
  mkdir -p "$d"
  cat > "$d/$HOST_NAME.json" <<JSON
{
  "name": "$HOST_NAME",
  "description": "PCB tester host info (hostname + /etc/pcb-tester/tester.json)",
  "path": "$BIN_DIR/pcb_hostinfo.py",
  "type": "stdio",
  $ACCESS
}
JSON
  echo "Installed $d/$HOST_NAME.json"
done
echo "Done. Enable 'use_native_hostname' in the extension settings (or via policy)."
