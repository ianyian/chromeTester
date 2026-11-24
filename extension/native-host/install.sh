#!/usr/bin/env bash
# Installs the native messaging host for Google Chrome / Chromium on Linux.
# Usage: sudo ./install.sh [EXTENSION_ID]     (system-wide)
#        ./install.sh [EXTENSION_ID]          (current user only)
set -euo pipefail
EXT_ID="${1:-ekhaanoedcoajbabpjfmhjmkjpkhppka}"
HOST_NAME="com.pcbtester.hostinfo"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ "$(id -u)" -eq 0 ]; then
  BIN_DIR="/opt/pcb-tester"
  TARGETS=("/etc/opt/chrome/native-messaging-hosts" "/etc/chromium/native-messaging-hosts")
else
  BIN_DIR="$HOME/.local/share/pcb-tester"
  TARGETS=("$HOME/.config/google-chrome/NativeMessagingHosts" "$HOME/.config/chromium/NativeMessagingHosts")
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
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
JSON
  echo "Installed $d/$HOST_NAME.json"
done
echo "Done. Enable 'use_native_hostname' in the extension settings (or via policy)."
