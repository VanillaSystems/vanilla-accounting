#!/bin/sh
# npm test: the suite and the demo goldens in one temporary folder of their own, removed at the end,
# so the tests' mkdtemp folders never pile up in the system's TMPDIR (thousands per day of runs).
set -e
TMPDIR=$(mktemp -d "${TMPDIR:-/tmp}/vanilla-test.XXXXXX")
export TMPDIR
trap 'rm -rf "$TMPDIR"' EXIT INT TERM
VANILLA_WORKSPACE=demo node --import tsx --test "tests/**/*.test.ts"
VANILLA_WORKSPACE=demo-consulting node --import tsx --test tests/vat-golden.test.ts tests/statements-golden.test.ts tests/classify-force.test.ts
VANILLA_WORKSPACE=demo-schreinerei node --import tsx --test tests/vat-golden.test.ts tests/statements-golden.test.ts tests/classify-force.test.ts
VANILLA_WORKSPACE=demo-coiffeur node --import tsx --test tests/statements-golden.test.ts tests/classify-force.test.ts
