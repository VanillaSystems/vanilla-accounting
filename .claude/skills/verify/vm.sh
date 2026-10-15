#!/bin/sh
# The packed Mac app on a fresh Mac: a throwaway Tart VM cloned from `vanilla-clean`, driven over
# SSH (shell), the VM's own screen sharing (whole screen: macOS dialogs, Finder, System Settings)
# and the app's DevTools port through an SSH tunnel (inside the app). Never on the person's desktop.
#
#   vm.sh up [run] [--from SNAP]   clone vanilla-clean (or a snapshot), boot, key, Gatekeeper on,
#                           dmg + persona files into ~/Downloads; 6 GB, so three VMs run side by side
#   vm.sh install           the app of release/mac-arm64 (npm run desktop:dir, 15 s) into /Applications,
#                           over the one there, past Gatekeeper: for iterating, not for install tests
#   vm.sh snap NAME         keep this VM's state as snapshot belege-snap-NAME (books set up, files in …)
#   vm.sh snaps             the snapshots
#   vm.sh doctor [run]      read-only: every line ok, else down + up
#   vm.sh shot NAME         whole screen → $EVIDENCE/NAME.png (+ NAME.s.png, 1400 px wide, to read)
#   vm.sh click X Y         click at X,Y of the 1400-px image; `vm.sh dclick X Y` double-clicks
#   vm.sh type TEXT | key KEY    keyboard (click a password field first; key: enter, tab, esc …)
#   vm.sh sh 'CMD'          a shell command in the VM (user admin)
#   vm.sh put FILE…         copy files into the VM's ~/Downloads, quarantined as a download
#   vm.sh claude            Claude Code into the VM (as an owner installs it); with the owner's token
#                           in ~/.vanilla-accounting/e2e/claude-token (claude setup-token) the app's
#                           model calls run on that subscription
#   vm.sh app               (re)start the installed app with its DevTools port, log in /tmp/va.log
#   vm.sh down [run]        stop and delete the VM and the tunnel; the evidence stays
#   vm.sh list
#
# Needs: tart, the VM `vanilla-clean` (user admin, password admin, Screen Sharing on), a built dmg
# (npm run desktop:build), the SSH key ~/.vanilla-accounting/e2e/id_ed25519, expect, python3.
set -eu
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
HERE="$REPO/.claude/skills/verify"
ROOT="${TMPDIR:-/tmp}/belege-vm"
KEY="$HOME/.vanilla-accounting/e2e/id_ed25519"
VENV="$ROOT/venv"
cmd=${1:-}; [ $# -gt 0 ] && shift

runid() { r=${1:-${VERIFY_VM:-}}; [ -n "$r" ] || r=$(ls "$ROOT" 2>/dev/null | grep -v '^venv$' | head -1); [ -n "$r" ] || { echo "no VM run; vm.sh up first" >&2; exit 1; }; echo "$r"; }
load() { RUN=$(runid "${1:-}"); D="$ROOT/$RUN"; [ -f "$D/env" ] || { echo "no run $RUN" >&2; exit 1; }; . "$D/env"; }
ssh_() { ssh -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=5 "admin@$IP" "$@"; }
vnc() { "$VENV/bin/vncdo" -s "$IP::5900" -u admin -p admin "$@" 2>/dev/null; }
scale() { f=$(ls -t "$EVIDENCE"/*.png 2>/dev/null | grep -v '\.s\.png$' | head -1); w=$( [ -n "$f" ] && sips -g pixelWidth "$f" | awk '/pixelWidth/{print $2}' || echo 2048); echo "$w"; }
px() { echo "$1 * $(scale) / 1400" | bc; }

case "$cmd" in
up)
  RUN=${1:-vm$(date +%H%M%S)}; VM="belege-vm-$RUN"; D="$ROOT/$RUN"
  BASE=vanilla-clean; [ "${2:-}" = "--from" ] && BASE="belege-snap-$3"
  DMG=$(ls -t "$REPO"/release/*arm64.dmg 2>/dev/null | head -1)
  [ -n "$DMG" ] || { echo "no release/*arm64.dmg: npm run desktop:build first" >&2; exit 1; }
  [ -f "$KEY" ] || { echo "no SSH key $KEY" >&2; exit 1; }
  [ -x "$VENV/bin/vncdo" ] || { python3 -m venv "$VENV" && "$VENV/bin/pip" install -q vncdotool; }
  mkdir -p "$D"; EVIDENCE="$REPO/.verify/evidence/$RUN"; mkdir -p "$EVIDENCE"
  tart clone "$BASE" "$VM"; tart set "$VM" --memory 6144
  (tart run "$VM" > "$D/tart.log" 2>&1 & echo $! > "$D/tart.pid")
  IP=; for _ in $(seq 1 60); do IP=$(tart ip "$VM" 2>/dev/null || true); [ -n "$IP" ] && nc -z -w2 "$IP" 22 2>/dev/null && break; IP=; sleep 3; done
  [ -n "$IP" ] || { echo "VM $VM got no IP / SSH" >&2; exit 1; }
  [ "$BASE" = vanilla-clean ] && expect -c "set timeout 30; spawn ssh-copy-id -i $KEY.pub -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null admin@$IP; expect -re {assword:} { send \"admin\r\" }; expect eof" >/dev/null
  printf 'RUN=%s\nVM=%s\nIP=%s\nEVIDENCE=%s\nDMG="%s"\n' "$RUN" "$VM" "$IP" "$EVIDENCE" "$DMG" > "$D/env"
  # vanilla-clean has Gatekeeper off; a person's Mac has it on.
  ssh_ 'echo admin | sudo -S spctl --global-enable 2>/dev/null; mkdir -p ~/Downloads; osascript -e "quit app \"Terminal\"" >/dev/null 2>&1 || true'
  node "$HERE/persona-files.mjs" "$D/Downloads" >/dev/null && cat "$D/persona.env" >> "$D/env"
  [ "$BASE" = vanilla-clean ] && "$0" put "$DMG" "$D"/Downloads/* >/dev/null
  echo ready; cat "$D/env"; echo "source $D/env"
  ;;
install)
  load; APP="$REPO/release/mac-arm64/Vanilla Accounting.app"
  [ -d "$APP" ] || { echo "no $APP: npm run desktop:dir first" >&2; exit 1; }
  ditto -c -k --keepParent "$APP" "$ROOT/$RUN/app.zip"
  scp -q -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "$ROOT/$RUN/app.zip" "admin@$IP:/tmp/app.zip"
  ssh_ 'pkill -9 -f "Contents/MacOS/Vanilla Accountin[g]" 2>/dev/null; rm -rf "/Applications/Vanilla Accounting.app" && ditto -x -k /tmp/app.zip /Applications && xattr -dr com.apple.quarantine "/Applications/Vanilla Accounting.app"; defaults read "/Applications/Vanilla Accounting.app/Contents/Info" CFBundleVersion'
  ;;
snap)
  load; N=$1; ssh_ 'pkill -f "Contents/MacOS/Vanilla Accountin[g]"; sync' || true
  [ -f "$ROOT/$RUN/tunnel.pid" ] && kill "$(cat "$ROOT/$RUN/tunnel.pid")" 2>/dev/null || true
  tart stop "$VM"; tart delete "belege-snap-$N" >/dev/null 2>&1 || true; tart clone "$VM" "belege-snap-$N"
  (tart run "$VM" > "$ROOT/$RUN/tart.log" 2>&1 &)
  for _ in $(seq 1 60); do IP2=$(tart ip "$VM" 2>/dev/null || true); [ -n "$IP2" ] && nc -z -w2 "$IP2" 22 2>/dev/null && break; sleep 3; done
  sed -i '' "s/^IP=.*/IP=$IP2/" "$ROOT/$RUN/env"; echo "snapshot belege-snap-$N; $VM runs again at $IP2 (vm.sh app to start the app)"
  ;;
snaps) tart list | awk '/belege-snap-/{print $2}' ;;
put)
  load; scp -q -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "$@" "admin@$IP:Downloads/"
  for f in "$@"; do ssh_ "xattr -w com.apple.quarantine '0083;6720f000;Safari;' ~/Downloads/'$(basename "$f")'"; done
  ;;
sh) load; ssh_ "$@" ;;
shot)
  load; n=$1; vnc capture "$EVIDENCE/$n.png"; sips -Z 1400 "$EVIDENCE/$n.png" --out "$EVIDENCE/$n.s.png" >/dev/null; echo "$EVIDENCE/$n.s.png" ;;
click) load; vnc move "$(px "$1")" "$(px "$2")" click 1 ;;
dclick) load; vnc move "$(px "$1")" "$(px "$2")" click 1 pause 0.1 click 1 ;;
type) load; vnc type "$1" ;;
key) load; vnc key "$1" ;;
claude)
  load
  ssh_ 'curl -fsSL https://claude.ai/install.sh | bash >/tmp/claude-install.log 2>&1; grep -q ".local/bin" ~/.zshrc 2>/dev/null || echo "export PATH=\$HOME/.local/bin:\$PATH" >> ~/.zshrc; ~/.local/bin/claude --version'
  TOKEN="$HOME/.vanilla-accounting/e2e/claude-token"
  if [ -f "$TOKEN" ]; then ssh_ 'umask 077; cat > ~/.claude-token' < "$TOKEN"; echo "token in the VM; vm.sh app passes it to the app"; else echo "no $TOKEN: the app's model calls fail with not logged in"; fi
  ;;
app)
  load
  ssh_ 'pkill -9 -f "Contents/MacOS/Vanilla Accountin[g]" 2>/dev/null; sleep 2; [ -f ~/.claude-token ] && export CLAUDE_CODE_OAUTH_TOKEN=$(cat ~/.claude-token); (nohup "/Applications/Vanilla Accounting.app/Contents/MacOS/Vanilla Accounting" --remote-debugging-port=9222 < /dev/null > /tmp/va.log 2>&1 &); for i in $(seq 1 30); do curl -s localhost:9222/json/list | grep -q 127.0.0.1 && exit 0; sleep 1; done; echo "app did not open its DevTools port" >&2; exit 1'
  [ -f "$ROOT/$RUN/tunnel.pid" ] && kill "$(cat "$ROOT/$RUN/tunnel.pid")" 2>/dev/null || true
  PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
  ssh -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -N -L "$PORT:127.0.0.1:9222" "admin@$IP" & echo $! > "$ROOT/$RUN/tunnel.pid"
  grep -v '^CDP=' "$ROOT/$RUN/env" > "$ROOT/$RUN/env.t"; echo "CDP=http://127.0.0.1:$PORT" >> "$ROOT/$RUN/env.t"; mv "$ROOT/$RUN/env.t" "$ROOT/$RUN/env"
  sleep 1; echo "CDP=http://127.0.0.1:$PORT"
  ;;
doctor)
  load "${1:-}"; ok() { echo "ok   $1"; }; bad() { echo "FAIL $1"; }
  tart list | grep -q "^local *$VM .*running" && ok "VM $VM running" || bad "VM $VM not running"
  ssh_ true 2>/dev/null && ok "ssh admin@$IP" || bad "ssh admin@$IP"
  [ "$(ssh_ spctl --status 2>/dev/null)" = "assessments enabled" ] && ok "Gatekeeper on" || bad "Gatekeeper off (spctl --global-enable)"
  vnc capture "$ROOT/$RUN/doctor.png" && ok "screen capture over VNC" || bad "screen capture over VNC"
  if [ -n "${CDP:-}" ]; then curl -s "$CDP/json/list" | grep -q '127.0.0.1:' && ok "app DevTools at $CDP" || bad "app DevTools at $CDP (vm.sh app)"; else echo "--   app not started with vm.sh app"; fi
  ;;
down)
  RUN=$(runid "${1:-}"); D="$ROOT/$RUN"; . "$D/env"
  [ -f "$D/tunnel.pid" ] && kill "$(cat "$D/tunnel.pid")" 2>/dev/null || true
  ssh_ 'cat /tmp/va.log' > "$EVIDENCE/app.log" 2>/dev/null || true
  tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true
  rm -rf "$D"; echo "down $RUN; evidence in $EVIDENCE"
  ;;
list) ls "$ROOT" 2>/dev/null | grep -v '^venv$' || true ;;
*) sed -n '2,20p' "$0"; exit 1 ;;
esac
