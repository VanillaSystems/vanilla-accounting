#!/bin/sh
# The packed Mac app's end-to-end test (tools/desktop/smoke.mjs), run inside a Tart VM, never on
# the person's own desktop: the test launches the app and drives it, which steals focus.
#
#   tools/desktop/vm-e2e.sh            the persistent VM `vanilla-e2e`: the app is installed over the
#                                      one there (as an update would), the test runs, the VM stops
#   tools/desktop/vm-e2e.sh --fresh    a throwaway clone of `vanilla-clean` (a first installation),
#                                      deleted afterwards
#   ... --watch                        the VM in a window, to see the test drive the app
#   open vnc://admin@$(tart ip vanilla-e2e)   look in on a VM running without a window (password admin)
#
# Needs: tart, a built app in release/mac-arm64 (npm run desktop:build), the VM's SSH key in
# ~/.vanilla-accounting/e2e/id_ed25519 (installed once with ssh-copy-id, user admin). Files reach
# the VM through one exchange folder, /tmp/vanilla-e2e, shared into it; the evidence comes back there.
set -eu
cd "$(dirname "$0")/../.."

FRESH=; WATCH=
for a in "$@"; do case "$a" in --fresh) FRESH=1 ;; --watch) WATCH=1 ;; *) echo "unknown option $a" >&2; exit 1 ;; esac; done
BASE=vanilla-clean
VM=vanilla-e2e; [ -n "$FRESH" ] && VM="vanilla-e2e-fresh-$$"
KEY="$HOME/.vanilla-accounting/e2e/id_ed25519"
X=/tmp/vanilla-e2e
APP="release/mac-arm64/Vanilla Accounting.app"
STAMP=$(date +%Y%m%d-%H%M%S)
SSH="ssh -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=5"

[ -d "$APP" ] || { echo "No $APP: npm run desktop:build first." >&2; exit 1; }
[ -f "$KEY" ] || { echo "No SSH key $KEY for the VM (see the head of this script)." >&2; exit 1; }

# The exchange folder: the app, the test as one file, its two fixtures, node, and room for evidence.
mkdir -p "$X/repo/tools/desktop" "$X/repo/tests/support/stub-bin" "$X/repo/desktop" "$X/out"
# As a zip: the shared folder does not carry the frameworks' symlinks.
rm -rf "$X/app" "$X/app.zip"; ditto -c -k --keepParent "$APP" "$X/app.zip"
npx esbuild tools/desktop/smoke.mjs --bundle --platform=node --format=esm --log-level=error \
  --banner:js="import { createRequire as vmRequire } from 'module'; const require = vmRequire(import.meta.url);" \
  --external:bufferutil --external:utf-8-validate --outfile="$X/repo/tools/desktop/smoke.mjs"
cp tests/support/stub-bin/claude "$X/repo/tests/support/stub-bin/claude"
cp desktop/icon.png "$X/repo/desktop/icon.png"
cp "$(command -v node)" "$X/node"

if [ -n "$FRESH" ]; then tart clone "$BASE" "$VM"; fi
cleanup() {
  tart stop "$VM" >/dev/null 2>&1 || true
  if [ -n "$FRESH" ]; then tart delete "$VM" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

if ! tart list | grep -q "^local *$VM .*running"; then
  if [ -n "$WATCH" ]; then tart run "$VM" --dir="e2e:$X" >"$X/tart-$VM.log" 2>&1 &
  else tart run "$VM" --no-graphics --dir="e2e:$X" >"$X/tart-$VM.log" 2>&1 &
  fi
fi
IP=
for _ in $(seq 1 60); do IP=$(tart ip "$VM" 2>/dev/null || true); [ -n "$IP" ] && $SSH "admin@$IP" true 2>/dev/null && break; IP=; sleep 3; done
[ -n "$IP" ] || { echo "The VM $VM did not answer over SSH." >&2; exit 1; }
if [ -n "$FRESH" ] && ! $SSH -o BatchMode=yes "admin@$IP" true 2>/dev/null; then echo "The fresh VM has no key: run ssh-copy-id against it once." >&2; exit 1; fi

S="/Volumes/My Shared Files/e2e"
# Installed as a person would: over the copy in /Applications, so a run is also an update.
# An SSH session finds the login keychain locked; the app keeps its secrets' key there.
$SSH "admin@$IP" "security unlock-keychain -p admin ~/Library/Keychains/login.keychain-db && mkdir -p ~/bin && cp '$S/node' ~/bin/node && chmod +x ~/bin/node \
  && rm -rf '/Applications/Vanilla Accounting.app' && ditto -x -k '$S/app.zip' /Applications \
  && cd '$S/repo' && ~/bin/node tools/desktop/smoke.mjs '/Applications/Vanilla Accounting.app' '$S/out/$STAMP'"
echo "Evidence: $X/out/$STAMP"
