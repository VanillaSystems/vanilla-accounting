#!/bin/sh
# npm test: one full run at a time on this machine, TEST_CONCURRENCY test files at once (3 unless set),
# at a lower priority (nice 10) so the person's own work on the machine comes first.
# The run's temp folder is fixed and only this run uses it, under the lock: the tests' mkdtemp folders
# are removed at the start and the end, while tsx's compile cache in it (tsx-<uid>) is kept, so the
# next run and every server it starts reuse the compiled files.
# A run ends after TEST_TIME_LIMIT seconds (1200, 20 minutes, unless set): it stops the processes it started (the test
# runners, their test files and every browser and server those started), releases the lock and says so, with exit code 124.
# A clean tree that passed the full suite before is not run again (tools/test/runs.mjs: same tree hash, same
# result); `npm test -- --force` runs it anyway, and a green full run on a clean tree is recorded.
# Test files as arguments (npm run test:changed passes its selection) run only those: nothing is looked up or recorded.
set -e
here=$(dirname "$0")
force=
files=
for a in "$@"; do
  case "$a" in
    --force) force=1 ;;
    *) files="$files $a" ;;
  esac
done
tree=
if [ -z "$files" ]; then
  tree=$(node "$here/runs.mjs" tree 2>/dev/null || true)
  if [ -z "$force" ] && [ -n "$tree" ] && node "$here/runs.mjs" check "$tree"; then exit 0; fi
fi
started=$(date +%s)
# The types first (what package.json's pretest did); incremental, so an unchanged program takes seconds.
if [ -z "$files" ]; then nice -n 10 npx tsc --noEmit --incremental --tsBuildInfoFile "$(git rev-parse --git-dir)/vanilla-tsc.tsbuildinfo"; fi
base=${TMPDIR:-/tmp}
base=${base%/}
lock="$base/vanilla-test.lock"
root="$base/vanilla-test"

said=
nopid=0
until mkdir "$lock" 2>/dev/null; do
  pid=$(cat "$lock/pid" 2>/dev/null || true)
  if [ -z "$pid" ]; then
    # The holder writes its pid right after mkdir; a lock without one for 10 s lost its holder.
    nopid=$((nopid + 1))
    [ "$nopid" -lt 10 ] || { rm -rf "$lock"; nopid=0; }
  elif ! kill -0 "$pid" 2>/dev/null; then
    # Moved aside first, so of two runs that both found the holder dead only one removes the lock.
    if mv "$lock" "$lock.$$" 2>/dev/null; then
      if [ "$(cat "$lock.$$/pid" 2>/dev/null)" = "$pid" ]; then rm -rf "$lock.$$"; else mv "$lock.$$" "$lock" 2>/dev/null || rm -rf "$lock.$$"; fi
    fi
    continue
  else
    nopid=0
    [ "$said" = "$pid" ] || { echo "waiting for another test run (pid $pid)…" >&2; said=$pid; }
  fi
  sleep 1
done
echo $$ > "$lock/pid"

clean() { mkdir -p "$root" && find "$root" -mindepth 1 -maxdepth 1 ! -name 'tsx-*' -exec rm -rf {} +; }
# The run's own processes, parents first: its job and everything under it, all found before any is stopped.
tree() { for c in $(pgrep -P "$1"); do echo "$c"; tree "$c"; done; }
alive() { for p in "$@"; do kill -0 "$p" 2>/dev/null && return 0; done; return 1; }
stop() {
  [ -n "$work" ] || return 0
  pids="$work $(tree "$work")"
  work=
  kill -TERM $pids 2>/dev/null || true
  n=0
  while [ "$n" -lt 10 ] && alive $pids; do sleep 0.5; n=$((n + 1)); done
  kill -KILL $pids 2>/dev/null || true
}
work=
watchdog=
# The watchdog's sleep is stopped too, so it never signals a later process that got this pid.
trap 'stop; [ -z "$watchdog" ] || kill $watchdog $(pgrep -P "$watchdog") 2>/dev/null || true; clean; rm -rf "$lock"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
limit=${TEST_TIME_LIMIT:-1200}
trap 'echo "npm test stopped after $limit s (TEST_TIME_LIMIT), and with it every process it started; the lock is free" >&2; exit 124' USR1
clean
# Compiled files of sources unchanged for two weeks go, so the cache does not grow without end.
find "$root" -path "$root/tsx-*" -type f -mtime +14 -delete 2>/dev/null || true
TMPDIR=$root
export TMPDIR

VANILLA_TEST_RUN=$$
export VANILLA_TEST_RUN

suite() {
  ws=$1
  shift
  VANILLA_WORKSPACE=$ws nice -n 10 node --import tsx --import ./tests/support/exit-with-parent.ts --test --test-concurrency="${TEST_CONCURRENCY:-3}" "$@"
}
# The other demo workspaces run the golden tests among the selection (all of them in a full run).
among() { for f in "$@"; do case " $files " in *" $f "*) printf '%s ' "$f" ;; esac; done; }
suites() {
  if [ -z "$files" ]; then
    suite demo "tests/**/*.test.ts"
    suite demo-consulting tests/vat-golden.test.ts tests/statements-golden.test.ts tests/classify-force.test.ts
    suite demo-schreinerei tests/vat-golden.test.ts tests/statements-golden.test.ts tests/classify-force.test.ts
    suite demo-coiffeur tests/statements-golden.test.ts tests/classify-force.test.ts
    return
  fi
  # shellcheck disable=SC2086
  suite demo $files
  g=$(among tests/vat-golden.test.ts tests/statements-golden.test.ts tests/classify-force.test.ts)
  # shellcheck disable=SC2086
  if [ -n "$g" ]; then suite demo-consulting $g; suite demo-schreinerei $g; fi
  g=$(among tests/statements-golden.test.ts tests/classify-force.test.ts)
  # shellcheck disable=SC2086
  if [ -n "$g" ]; then suite demo-coiffeur $g; fi
}
# Both in the background: the shell runs a trap only once a command in the foreground has ended, so it waits instead.
(sleep "$limit" && kill -USR1 $$) &
watchdog=$!
suites &
work=$!
status=0
wait "$work" || status=$?
work=
if [ "$status" -eq 0 ] && [ -z "$files" ]; then
  if [ -n "$tree" ]; then (TMPDIR=$base node "$here/runs.mjs" record "$tree" "$started") || true
  else echo "npm test: green, not recorded: the tree had uncommitted changes" >&2; fi
fi
exit "$status"
