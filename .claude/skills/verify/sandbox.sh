#!/usr/bin/env bash
# Disposable Belege instance for verification: API + Vite UI against a CLONE of the books.
#
#   sandbox.sh up [run-id]     clone data, start API + UI on free ports, print env
#   sandbox.sh doctor [run-id] read-only health + isolation check
#   sandbox.sh diff [run-id]   what changed in the sandbox index vs. the snapshot taken at `up`
#   sandbox.sh down [run-id]   stop what `up` started, delete the sandbox (evidence is kept)
#   sandbox.sh list            sandboxes that currently exist
#
# run-id defaults to $VERIFY_RUN, then to the only existing sandbox.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
BASE="${TMPDIR:-/tmp}"; BASE="${BASE%/}/belege-verify"
EVIDENCE_BASE="$REPO/.verify/evidence"

die() { echo "sandbox: $*" >&2; exit 1; }
port_free() { ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
free_port() { local p=$1; while ! port_free "$p"; do p=$((p + 1)); done; echo "$p"; }
alive() { [[ -n "${1:-}" ]] && kill -0 "$1" 2>/dev/null; }

resolve_run() {
  local id="${1:-${VERIFY_RUN:-}}"
  if [[ -z "$id" ]]; then
    local runs=(); [[ -d "$BASE" ]] && runs=($(ls "$BASE"))
    [[ ${#runs[@]} -eq 1 ]] || die "pass a run-id (existing: ${runs[*]:-none})"
    id="${runs[0]}"
  fi
  echo "$id"
}

load() {
  RUN="$(resolve_run "${1:-}")"; SB="$BASE/$RUN"
  [[ -f "$SB/env" ]] || die "no sandbox '$RUN' at $SB"
  # shellcheck disable=SC1091
  source "$SB/env"
}

cmd_up() {
  RUN="${1:-v$(date +%Y%m%d-%H%M%S)}"; SB="$BASE/$RUN"
  [[ -e "$SB" ]] && die "sandbox $SB already exists; run 'down $RUN' first"
  # Default: the repo root when it is a workspace (a private checkout), else the shipped demo.
  local WS_DEFAULT="$REPO"; [[ -f "$REPO/belege.workspace.yaml" ]] || WS_DEFAULT="$REPO/demo"
  local WS_SRC; WS_SRC="$(cd "${VERIFY_WORKSPACE:-$WS_DEFAULT}" && pwd)"
  [[ -f "$WS_SRC/belege.workspace.yaml" ]] || die "no belege.workspace.yaml in $WS_SRC (VERIFY_WORKSPACE names the workspace to clone)"
  mkdir -p "$SB"

  # The sandbox dir IS the workspace clone, on the fixed layout of src/workspace/workspace.ts.
  # APFS clonefile (cp -c): copy-on-write, so a large receipts tree costs nothing until written.
  # Filings are copied, not linked, so nothing can write the real ones. No code is copied: the API
  # and Vite run the repo's working tree, and BELEGE_WORKSPACE points the API here.
  for f in belege.workspace.yaml books.json accounts.json; do cp -c "$WS_SRC/$f" "$SB/$f"; done
  for d in receipts bank-statements filings; do cp -cR "$WS_SRC/$d" "$SB/$d"; done
  for d in history counterparties policy; do if [[ -d "$WS_SRC/$d" ]]; then cp -cR "$WS_SRC/$d" "$SB/$d"; fi; done
  if [[ -d "$WS_SRC/beleg-import" ]]; then cp -cR "$WS_SRC/beleg-import" "$SB/beleg-import"; else mkdir "$SB/beleg-import"; fi
  cp -c "$SB/books.json" "$SB/index.snapshot.json"
  # No model calls: src/llm/ask.ts spawns `claude`, and the API finds this refusing shim first.
  mkdir "$SB/bin"
  printf '#!/bin/sh\ncat >/dev/null\necho "verify sandbox: no model calls" >&2\nexit 1\n' >"$SB/bin/claude"
  chmod +x "$SB/bin/claude"

  API_PORT="$(free_port 3556)"; UI_PORT="$(free_port 5273)"
  # The Vite config lives in the repo (gitignored .verify/), so it and its plugins resolve the
  # repo's node_modules; the sandbox holds no code.
  VITE_CONFIG="$REPO/.verify/vite.$RUN.config.mjs"; mkdir -p "$REPO/.verify"
  cat > "$VITE_CONFIG" <<EOF
import react from '@vitejs/plugin-react';
export default {
  root: '$REPO',
  cacheDir: '$SB/.vite',
  plugins: [react()],
  resolve: { alias: { '@': '$REPO/src' } },
  server: {
    port: $UI_PORT, strictPort: true, host: '127.0.0.1',
    proxy: Object.fromEntries(['/api', '/scan', '/books.json', '^/receipts/', '^/bank-statements/'].map((p) => [p, 'http://127.0.0.1:$API_PORT'])),
  },
};
EOF

  # API: BELEGE_WORKSPACE names the sandbox, and cwd = the sandbox so no .env of the repo is loaded.
  (cd "$SB" && BELEGE_WORKSPACE="$SB" PATH="$SB/bin:$PATH" PORT="$API_PORT" exec node --import "$REPO/node_modules/tsx/dist/loader.mjs" "$REPO/src/server/main.ts" </dev/null >"$SB/api.log" 2>&1) &
  echo $! >"$SB/api.pid"
  # UI: cwd = repo so Tailwind's relative content globs resolve; data comes through the API proxy.
  (cd "$REPO" && exec node "$REPO/node_modules/vite/bin/vite.js" --config "$VITE_CONFIG" </dev/null >"$SB/ui.log" 2>&1) &
  echo $! >"$SB/ui.pid"

  # The recipes name quarters by the clone's period lock: the last filed quarter and the open one after it.
  local CT CLOSED_Q="" CLOSED_FROM="" OPEN_Q="" OPEN_FROM=""
  CT="$(jq -r '.config.closedThrough // empty' "$SB/books.json")"
  if [[ -n "$CT" ]]; then
    local y=${CT:0:4} q=$(( (10#${CT:5:2} - 1) / 3 + 1 ))
    CLOSED_Q="$y-Q$q"; CLOSED_FROM="$(printf '%s-%02d-01' "$y" $(( (q - 1) * 3 + 1 )))"
    if (( q == 4 )); then OPEN_Q="$((y + 1))-Q1"; OPEN_FROM="$((y + 1))-01-01"
    else OPEN_Q="$y-Q$((q + 1))"; OPEN_FROM="$(printf '%s-%02d-01' "$y" $(( q * 3 + 1 )))"; fi
  fi

  EVIDENCE="$EVIDENCE_BASE/$RUN"; mkdir -p "$EVIDENCE"
  cat > "$SB/env" <<EOF
CT=$CT
CLOSED_Q=$CLOSED_Q
CLOSED_FROM=$CLOSED_FROM
OPEN_Q=$OPEN_Q
OPEN_FROM=$OPEN_FROM
RUN=$RUN
SB=$SB
API_PORT=$API_PORT
UI_PORT=$UI_PORT
API=http://127.0.0.1:$API_PORT
UI=http://127.0.0.1:$UI_PORT
EVIDENCE=$EVIDENCE
API_PID=$(cat "$SB/api.pid")
UI_PID=$(cat "$SB/ui.pid")
VITE_CONFIG=$VITE_CONFIG
WS_SRC=$WS_SRC
REAL_INDEX_SHA=$(shasum -a 256 "$WS_SRC/books.json" | cut -d' ' -f1)
EOF
  source "$SB/env"

  for _ in $(seq 1 60); do
    curl -sf "$API/api/status" >/dev/null 2>&1 && curl -sf "$UI/" >/dev/null 2>&1 && break
    sleep 0.5
  done
  curl -sf "$API/api/status" >/dev/null || { tail -20 "$SB/api.log"; die "API did not come up (log above)"; }
  curl -sf "$UI/" >/dev/null || { tail -20 "$SB/ui.log"; die "UI did not come up (log above)"; }
  echo "ready"
  cat "$SB/env"
}

cmd_doctor() {
  load "${1:-}"; local bad=0
  check() { if eval "$2"; then echo "ok    $1"; else echo "FAIL  $1"; bad=1; fi; }
  # The first PDF under the sandbox's $1/, fetched through the UI, is byte-identical to the clone's.
  served() {
    local f; f="$(cd "$SB/$1" && find . -name '*.pdf' | sort | head -1)"; f="${f#./}"
    [[ -n "$f" ]] && curl -sf "$UI/$1/$(jq -rn --arg f "$f" '$f|split("/")|map(@uri)|join("/")')" | cmp -s - "$SB/$1/$f"
  }
  check "api pid $API_PID alive"                  "alive $API_PID"
  check "ui pid $UI_PID alive"                    "alive $UI_PID"
  check "port $API_PORT owned by api pid"         "lsof -nP -a -p $API_PID -iTCP:$API_PORT -sTCP:LISTEN >/dev/null 2>&1"
  check "port $UI_PORT owned by ui pid"           "lsof -nP -a -p $UI_PID -iTCP:$UI_PORT -sTCP:LISTEN >/dev/null 2>&1"
  check "api cwd is the sandbox"                  "[[ \"\$(lsof -a -p $API_PID -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')\" == \"\$(cd $SB && pwd -P)\" ]]"
  check "GET /api/status ok"                      "curl -sf $API/api/status | grep -q '\"ok\":true'"
  check "UI serves index.html"                    "curl -sf $UI/ | grep -q '<div id=\"root\"'"
  check "UI compiles the app"                     "curl -sf $UI/src/app/main.tsx >/dev/null"
  check "UI proxies /api to this sandbox"         "curl -sf $UI/api/status >/dev/null"
  check "UI serves the sandbox books"             "[[ \"\$(curl -sf $UI/books.json | shasum -a 256 | cut -d' ' -f1)\" == \"\$(shasum -a 256 < $SB/books.json | cut -d' ' -f1)\" ]]"
  check "UI serves the sandbox receipts"          "served receipts"
  check "UI serves the sandbox bank statements"   "served bank-statements"
  check "real workspace books untouched since up" "[[ \"\$(shasum -a 256 $WS_SRC/books.json | cut -d' ' -f1)\" == $REAL_INDEX_SHA ]]"
  check "api opened the sandbox workspace"        "ps eww -p $API_PID | grep -q 'BELEGE_WORKSPACE=$SB '"
  check "api finds the refusing claude shim"      "ps eww -p $API_PID | grep -q 'PATH=$SB/bin:' && ! $SB/bin/claude 2>/dev/null"
  echo "closedThrough: $(curl -sf "$API/api/config" | jq -r '.closedThrough // "none"')"
  echo "UI=$UI  API=$API  EVIDENCE=$EVIDENCE"
  return $bad
}

cmd_diff() {
  load "${1:-}"
  node -e '
    const fs = require("fs");
    const [a, b] = process.argv.slice(1).map((p) => JSON.parse(fs.readFileSync(p, "utf8")));
    const key = { receipts: "id", transactions: "ref", journalEntries: "id", bankStatements: "id" };
    let changes = 0;
    for (const coll of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const A = a[coll], B = b[coll];
      if (!Array.isArray(A) && !Array.isArray(B)) {
        if (JSON.stringify(A) !== JSON.stringify(B)) { changes++; console.log(`~ ${coll}: ${JSON.stringify(A)} -> ${JSON.stringify(B)}`); }
        continue;
      }
      const k = key[coll];
      const id = (x) => (k && x[k] !== undefined ? x[k] : JSON.stringify(x));
      const mA = new Map((A ?? []).map((x) => [id(x), x])), mB = new Map((B ?? []).map((x) => [id(x), x]));
      for (const [i, x] of mB) if (!mA.has(i)) { changes++; console.log(`+ ${coll} ${i}`); }
      for (const [i] of mA) if (!mB.has(i)) { changes++; console.log(`- ${coll} ${i}`); }
      for (const [i, x] of mB) {
        const y = mA.get(i); if (!y) continue;
        for (const f of new Set([...Object.keys(x), ...Object.keys(y)]))
          if (JSON.stringify(x[f]) !== JSON.stringify(y[f])) { changes++; console.log(`~ ${coll} ${i} .${f}: ${JSON.stringify(y[f])} -> ${JSON.stringify(x[f])}`); }
      }
    }
    if (!changes) console.log("no changes");
  ' "$SB/index.snapshot.json" "$SB/books.json"
}

cmd_down() {
  load "${1:-}"
  for pid in "$UI_PID" "$API_PID"; do
    if alive "$pid"; then
      pkill -TERM -P "$pid" 2>/dev/null || true
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  for _ in $(seq 1 20); do alive "$UI_PID" || alive "$API_PID" || break; sleep 0.25; done
  for pid in "$UI_PID" "$API_PID"; do alive "$pid" && kill -KILL "$pid" 2>/dev/null || true; done
  # Keep the logs with the evidence before the sandbox goes.
  mkdir -p "$EVIDENCE"; cp "$SB/api.log" "$SB/ui.log" "$EVIDENCE/" 2>/dev/null || true
  rm -rf "$SB" "$VITE_CONFIG"
  port_free "$API_PORT" && port_free "$UI_PORT" || echo "warning: port $API_PORT or $UI_PORT still listening (not ours? check lsof)"
  echo "down: $RUN removed; evidence kept at $EVIDENCE"
}

cmd_list() { [[ -d "$BASE" ]] && for d in "$BASE"/*/; do [[ -f "$d/env" ]] && (source "$d/env"; echo "$RUN  ui=$UI  api=$API  api_pid=$API_PID($(alive $API_PID && echo up || echo dead))"); done; true; }

case "${1:-}" in
  up) shift; cmd_up "$@" ;;
  doctor) shift; cmd_doctor "$@" ;;
  diff) shift; cmd_diff "$@" ;;
  down) shift; cmd_down "$@" ;;
  list) cmd_list ;;
  *) sed -n '2,9p' "$0"; exit 2 ;;
esac
