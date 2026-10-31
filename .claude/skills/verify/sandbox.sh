#!/usr/bin/env bash
# Disposable Vanilla Accounting instance for verification: API + Vite UI against a CLONE of the books.
#
#   sandbox.sh up [run-id]     clone data, start API + UI on free ports, print env
#   sandbox.sh doctor [run-id] read-only health + isolation check
#   sandbox.sh diff [run-id]   what changed in the sandbox's books vs. the snapshot taken at `up`
#   sandbox.sh down [run-id]   stop what `up` started, delete the sandbox (evidence is kept)
#   sandbox.sh stub [run-id] [text-file]  answer model calls with tests/support/stub-bin/claude (text-file: its first words)
#   sandbox.sh unstub [run-id]  back to the refusing shim
#   sandbox.sh list            sandboxes that currently exist
#
# run-id defaults to $VERIFY_RUN, then to the only existing sandbox.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
BASE="${TMPDIR:-/tmp}"; BASE="${BASE%/}/belege-verify"
EVIDENCE_BASE="$REPO/.verify/evidence"

die() { echo "sandbox: $*" >&2; exit 1; }
port_free() { ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
# A port is ours once its lock dir is made (mkdir is atomic): two `up`s started together cannot
# both pick the same free port. `down` removes the locks.
claim_port() {
  local p=$1 l; mkdir -p "$BASE/.ports"
  for l in "$BASE/.ports"/*/; do [[ -d "$l" && ! -d "$BASE/$(cat "$l/run" 2>/dev/null)" ]] && rm -rf "$l"; done
  until port_free "$p" && mkdir "$BASE/.ports/$p" 2>/dev/null; do p=$((p + 1)); done
  echo "$RUN" > "$BASE/.ports/$p/run"; echo "$p"
}
# Every request is bounded: a server that accepts but never answers makes a check FAIL, not hang.
get() { curl -sf --connect-timeout 3 --max-time 15 "$@"; }
# The books' files of a workspace (ADR 0013): ledger.json and every year's books/*.jsonl, as one hash.
books_sha() { (cd "$1" && cat ledger.json transactional-data/*/books/*.jsonl 2>/dev/null) | shasum -a 256 | cut -d' ' -f1; }
# The app's folder a directory names: itself when it holds the manifest, else its vanilla-accounting/.
app_folder() { if [[ -f "$1/belege.workspace.yaml" ]]; then echo "$1"; elif [[ -f "$1/vanilla-accounting/belege.workspace.yaml" ]]; then echo "$1/vanilla-accounting"; fi; }
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

shim() {
  printf '#!/bin/sh\ncat >/dev/null\necho "verify sandbox: no model calls" >&2\nexit 1\n' >"$SB/bin/claude"
  chmod +x "$SB/bin/claude"
}

# The API spawns `claude` by PATH on every call, so swapping $SB/bin/claude takes effect at once.
cmd_stub() {
  load "${1:-}"; local text="${2:-}"
  [[ -z "$text" ]] || text="$(cd "$(dirname "$text")" && pwd)/$(basename "$text")"
  printf '#!/bin/sh\n%sexec %q "$@"\n' "${text:+CLAUDE_STUB_TEXT=$(printf %q "$text") }" "$REPO/tests/support/stub-bin/claude" >"$SB/bin/claude"
  chmod +x "$SB/bin/claude"
  echo "stub: $RUN answers model calls with the test stub${text:+ (text from $text)}; unstub to refuse again"
}

cmd_unstub() { load "${1:-}"; shim; echo "unstub: $RUN refuses model calls again"; }

cmd_up() {
  RUN="${1:-v$(date +%Y%m%d-%H%M%S)}"; SB="$BASE/$RUN"
  [[ -e "$SB" ]] && die "sandbox $SB already exists; run 'down $RUN' first"
  # Default: the shipped demo; VERIFY_WORKSPACE names a company repository or its vanilla-accounting/.
  local WS_SRC; WS_SRC="$(app_folder "$(cd "${VERIFY_WORKSPACE:-$REPO/demo}" && pwd)")"
  [[ -n "$WS_SRC" ]] || die "no belege.workspace.yaml in ${VERIFY_WORKSPACE:-$REPO/demo} or its vanilla-accounting/ (VERIFY_WORKSPACE names the books to clone)"
  mkdir -p "$SB"

  # The sandbox dir IS a clone of the app's folder, on the fixed layout of src/workspace/workspace.ts.
  # APFS clonefile (cp -c): copy-on-write, so a large receipts tree costs nothing until written.
  # Everything is copied, not linked, so nothing can write the real files; data/ (the app's
  # scratch) stays behind. No code is copied: the API and Vite run the repo's working tree, and
  # VANILLA_WORKSPACE points the API here.
  for e in "$WS_SRC"/* "$WS_SRC"/.[!.]*; do [[ -e "$e" && "$(basename "$e")" != data ]] && cp -cR "$e" "$SB/"; done
  [[ -d "$SB/beleg-import" ]] || mkdir "$SB/beleg-import"
  # No model calls: src/llm/ask.ts spawns `claude`, and the API finds this refusing shim first.
  mkdir "$SB/bin"
  shim

  API_PORT="$(claim_port 3556)"; UI_PORT="$(claim_port 5273)"
  # The Vite config lives in the repo (gitignored .verify/), so it and its plugins resolve the
  # repo's node_modules; the sandbox holds no code.
  VITE_CONFIG="$REPO/.verify/vite.$RUN.config.mjs"; mkdir -p "$REPO/.verify"
  cat > "$VITE_CONFIG" <<EOF
import react from '@vitejs/plugin-react';
import { devProxy } from '$REPO/src/server/app-paths.ts';
export default {
  root: '$REPO',
  cacheDir: '$SB/.vite',
  plugins: [react()],
  resolve: { alias: { '@': '$REPO/src' } },
  server: {
    port: $UI_PORT, strictPort: true, host: '127.0.0.1',
    proxy: devProxy('http://127.0.0.1:$API_PORT'),
  },
};
EOF

  # API: VANILLA_WORKSPACE names the sandbox, and cwd = the sandbox so no .env of the repo is loaded.
  # What the app keeps on this computer outside the workspace (approvals, runs, demo copies, the
  # browser profile, traces) goes next to the sandbox, never into the owner's ~/.vanilla-accounting.
  # READONLY=1 in the caller's environment starts it in audit mode, as `npm run start:audit` does.
  (cd "$SB" && VANILLA_WORKSPACE="$SB" VANILLA_APPROVALS_DIR="$SB.approvals" VANILLA_RUNS_DIR="$SB.runs" VANILLA_DEMO_DIR="$SB.local/demo" VANILLA_BROWSER_DIR="$SB.local/browser" VANILLA_TRACES_DIR="$SB.local/traces" VANILLA_AI_SETTINGS="${VANILLA_AI_SETTINGS:-$SB.local/ai.json}" VANILLA_SECRETS_FILE="${VANILLA_SECRETS_FILE:-$SB.local/secrets.json}" PATH="$SB/bin:$PATH" VANILLA_API_HOST=127.0.0.1 PORT="$API_PORT" READONLY="${READONLY:-}" exec node --import "$REPO/node_modules/tsx/dist/loader.mjs" "$REPO/src/server/main.ts" </dev/null >"$SB/api.log" 2>&1) &
  echo $! >"$SB/api.pid"
  # UI: cwd = the repo; data comes through the API proxy.
  (cd "$REPO" && exec node "$REPO/node_modules/vite/bin/vite.js" --config "$VITE_CONFIG" </dev/null >"$SB/ui.log" 2>&1) &
  echo $! >"$SB/ui.pid"

  # The recipes name quarters by the clone's period lock: the last filed quarter and the open one after it.
  local CT CLOSED_Q="" CLOSED_FROM="" OPEN_Q="" OPEN_FROM=""
  CT="$(jq -r '.config.closedThrough // empty' "$SB/ledger.json")"
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
WS_SRC=$(printf '%q' "$WS_SRC")
REAL_INDEX_SHA=$(books_sha "$WS_SRC")
EOF
  source "$SB/env"

  for _ in $(seq 1 60); do
    get "$API/api/status" >/dev/null 2>&1 && get "$UI/" >/dev/null 2>&1 && break
    sleep 0.5
  done
  get "$API/api/status" >/dev/null || { tail -20 "$SB/api.log"; die "API did not come up (log above)"; }
  get "$UI/" >/dev/null || { tail -20 "$SB/ui.log"; die "UI did not come up (log above)"; }
  # The books as the API reads them at `up`: what `diff` compares against.
  get "$API/books.json" > "$SB/index.snapshot.json"
  echo "ready"
  cat "$SB/env"
}

cmd_doctor() {
  load "${1:-}"; local bad=0
  check() { if eval "$2"; then echo "ok    $1"; else echo "FAIL  $1"; bad=1; fi; }
  # The first PDF under a year's $1/ of the sandbox, fetched through the UI, is byte-identical to the clone's.
  # New, empty books have none: nothing to compare is no failure.
  served() {
    local d f
    f="$(cd "$SB" && find transactional-data -path "*/$1/*" -name '*.pdf' 2>/dev/null | sort | head -1)"
    [[ -n "$f" ]] || return 0
    d="$SB/${f%%/$1/*}/$1"; f="${f#*/$1/}"
    get "$UI/$1/$(jq -rn --arg f "$f" '$f|split("/")|map(@uri)|join("/")')" | cmp -s - "$d/$f"
  }
  check "api pid $API_PID alive"                  "alive $API_PID"
  check "ui pid $UI_PID alive"                    "alive $UI_PID"
  check "port $API_PORT owned by api pid"         "lsof -nP -a -p $API_PID -iTCP:$API_PORT -sTCP:LISTEN >/dev/null 2>&1"
  check "api listens on loopback only"            "! lsof -nP -a -p $API_PID -iTCP:$API_PORT -sTCP:LISTEN | awk 'NR>1{print \$9}' | grep -qv '^127\.0\.0\.1:'"
  check "port $UI_PORT owned by ui pid"           "lsof -nP -a -p $UI_PID -iTCP:$UI_PORT -sTCP:LISTEN >/dev/null 2>&1"
  check "api cwd is the sandbox"                  "[[ \"\$(lsof -a -p $API_PID -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')\" == \"\$(cd $SB && pwd -P)\" ]]"
  check "GET /api/status ok"                      "get $API/api/status | grep -q '\"ok\":true'"
  check "UI serves index.html"                    "get $UI/ | grep -q '<div id=\"root\"'"
  check "UI compiles the app"                     "get $UI/src/app/main.tsx >/dev/null"
  check "UI proxies /api to this sandbox"         "get $UI/api/status >/dev/null"
  check "UI serves the sandbox books"             "[[ \"\$(get $UI/books.json | shasum -a 256 | cut -d' ' -f1)\" == \"\$(get $API/books.json | shasum -a 256 | cut -d' ' -f1)\" ]]"
  check "UI serves the sandbox receipts"          "served receipts"
  check "UI serves the sandbox bank statements"   "served bank-statements"
  check "real workspace books untouched since up" "[[ \"\$(books_sha \"\$WS_SRC\")\" == $REAL_INDEX_SHA ]]"
  check "api opened the sandbox workspace"        "ps eww -p $API_PID | grep -q 'VANILLA_WORKSPACE=$SB '"
  check "api keeps its local state beside it"     "ps eww -p $API_PID | grep -q 'VANILLA_APPROVALS_DIR=$SB.approvals .*VANILLA_DEMO_DIR=$SB.local/demo '"
  if grep -q stub-bin "$SB/bin/claude"; then
    check "api finds the test stub as claude (stubbed)" "ps eww -p $API_PID | grep -q 'PATH=$SB/bin:'"
  else
    check "api finds the refusing claude shim"      "ps eww -p $API_PID | grep -q 'PATH=$SB/bin:' && ! $SB/bin/claude </dev/null 2>/dev/null"
  fi
  echo "closedThrough: $(get "$API/api/config" | jq -r '.closedThrough // "none"')"
  echo "UI=$UI  API=$API  EVIDENCE=$EVIDENCE"
  return $bad
}

cmd_diff() {
  load "${1:-}"
  # Right after a write the API can be busy for a while: retry once before giving up loudly.
  get "$API/books.json" > "$SB/index.now.json" || get "$API/books.json" > "$SB/index.now.json" \
    || die "GET /books.json did not answer twice in 15 s; run doctor, then diff again"
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
  ' "$SB/index.snapshot.json" "$SB/index.now.json"
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
  rm -rf "$SB" "$SB.approvals" "$SB.runs" "$SB.local" "$VITE_CONFIG" "$BASE/.ports/$API_PORT" "$BASE/.ports/$UI_PORT"
  port_free "$API_PORT" && port_free "$UI_PORT" || echo "warning: port $API_PORT or $UI_PORT still listening (not ours? check lsof)"
  echo "down: $RUN removed; evidence kept at $EVIDENCE"
}

cmd_list() { [[ -d "$BASE" ]] && for d in "$BASE"/*/; do [[ -f "$d/env" ]] && (source "$d/env"; echo "$RUN  ui=$UI  api=$API  api_pid=$API_PID($(alive $API_PID && echo up || echo dead))"); done; true; }

case "${1:-}" in
  up) shift; cmd_up "$@" ;;
  doctor) shift; cmd_doctor "$@" ;;
  diff) shift; cmd_diff "$@" ;;
  down) shift; cmd_down "$@" ;;
  stub) shift; cmd_stub "$@" ;;
  unstub) shift; cmd_unstub "$@" ;;
  list) cmd_list ;;
  *) sed -n '2,11p' "$0"; exit 2 ;;
esac
