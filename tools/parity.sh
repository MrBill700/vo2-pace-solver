#!/usr/bin/env bash
# Cross-check the browser port (web/vdot.js) against the Python CLI, case by case.
# A case fails if either side exits nonzero, prints nothing, or the outputs differ.
# PARITY_PY / PARITY_JS override the two commands (used by CI to prove failures fail).
set -u

PY=${PARITY_PY:-python vo2_pace_solver.py}
JS=${PARITY_JS:-node web/vdot.js}

cases=(
  "--dist 5k --time 22:30"
  "--dist 10mi --time 1:10:00"
  "--dist 1609.344 --time 4:55"
  "--dist 21.1k --time 1:45:00"
  "--dist 100000 --time 12:00:00"
  "--vdot 53.5"
  "--vdot 27"
  "--vdot 85"
  "--vdot 25"
)

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

run_side() {  # name, command, args, outfile
  local name=$1 cmd=$2 args=$3 out=$4 rc
  # shellcheck disable=SC2086  # word splitting of cmd and args is intended
  $cmd $args > "$out"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "FAIL ($name exited $rc): $args"; cat "$out"; return 1
  fi
  if [ ! -s "$out" ]; then
    echo "FAIL ($name printed nothing): $args"; return 1
  fi
}

for args in "${cases[@]}"; do
  run_side Python "$PY" "$args" "$tmp/py.out" || exit 1
  run_side Node "$JS" "$args" "$tmp/js.out" || exit 1
  diff --strip-trailing-cr "$tmp/py.out" "$tmp/js.out" || { echo "MISMATCH: $args"; exit 1; }
  echo "same: $args"
done
