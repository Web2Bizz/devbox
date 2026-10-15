#!/usr/bin/env bash
#
# Runs the Maestro activation E2E flows against the mock opencode servers the
# workflow started on the host (ports 4096-4100). Invoked as a single line from
# activation-e2e.yml's emulator-runner `script:` so cd/trap/loop actually work.
#
# Usage: run-e2e-flows.sh [core|newer|all]        (default: all)
#   core  — CORE_FLOWS only, blocking: the first failed flow aborts the run,
#           rc=1. This is the suite's regression gate.
#   newer — NEWER_FLOWS only, non-blocking: every flow runs regardless of
#           failures, rc is always 0 (issue #104 tracks hardening them).
#   all   — core, then newer: rc=1 iff a core flow failed. Same as the
#           pre-split single-argument behaviour.
#
# Per-flow timeout: each `maestro test` is wrapped in
# `timeout "${FLOW_TIMEOUT_SECONDS:-300}" maestro test ...`. A flow that hits
# the ceiling is reported as failed (timeout exits 124) and, in core mode,
# fails the job; output up to the kill stays visible in the emulator log.
# Why: run 38643204390 (PR #3) hung ~70 min with zero output on
# tablet-baseline-login and was only stopped by the job-level
# timeout-minutes: 90 ceiling — a single frozen `maestro test` used to be
# able to burn the whole job budget. Flows normally take 0:24..1:07, so the
# 300 s default is ~3-4x headroom.
#
# Networking: `adb reverse` maps each mock port so the emulator's own
# localhost:PORT forwards to the host's localhost:PORT; flows connect to
# 127.0.0.1:<port>. (10.0.2.2 was unreliable headless.)
set -uo pipefail

# Which flow subset to run — core|newer|all (default all = legacy behaviour,
# see the docblock above). Fail fast on typos, before touching the device.
SUBSET="${1:-all}"
case "$SUBSET" in
  core|newer|all) ;;
  *)
    echo "::error::unknown flow subset '$SUBSET' — expected: core | newer | all"
    exit 2
    ;;
esac

# Per-flow timeout for every `maestro test` call (seconds). Override via env
# (activation-e2e.yml passes FLOW_TIMEOUT_SECONDS=300 explicitly).
FLOW_TIMEOUT_SECONDS="${FLOW_TIMEOUT_SECONDS:-300}"

ROOT="$(pwd)"                       # capture BEFORE any cd, so diag paths are absolute
APK="android/app/build/outputs/apk/release/app-release.apk"
# CORE = the activation coverage issue #90 verified green (connect
# -> send, and the connect-time-401 visible-error case). A failure here fails
# the job — this is the suite's actual regression gate.
#
# NEWER = flows added after the initial activation suite (#82's
# directory-picker/all-sessions/variant-picker, #101's diff-scroll) that have
# never once run to completion in CI: they always sat behind the positive
# flow's stale SSE-reply assertion (issue #90 mode B, now fixed) or the
# negative-401 flow's stale "401" assertion (also now fixed), both of which
# made the job fail before reaching them — so they were merged and have been
# running unverified against the current UI/mock ever since. Run them for
# visibility (each flow's pass/fail is reported below) but don't block on
# them yet — see issue #104 for hardening them (fixing whatever stale
# selectors/seeding surface) and moving each back into CORE once confirmed
# green.
CORE_FLOWS=(activation-positive activation-negative-401)
# demo.yaml (offline "Try a demo" mode) needs no mock server — it never
# connects — so it's safe to run alongside the others here unmodified.
NEWER_FLOWS=(directory-picker all-sessions variant-picker diff-scroll demo tablet-baseline-login tablet-baseline-projects tablet-baseline-account)
mkdir -p "$ROOT/artifacts/screenshots" "$ROOT/artifacts/diag"

echo "== installing APK =="
# CRITICAL, not best-effort: android-emulator-runner runs `script:` as `sh -c`
# WITHOUT -e, and this script only sets `set -uo pipefail` (no -e) — so a
# failing `adb install` would NOT stop execution. In `newer` mode rc is always
# 0 by design, so the job would go GREEN WITH ZERO COVERAGE (no APK on the
# device → every flow fails as a ::warning::). Which is exactly the kind of
# infra break this suite exists to detect, so failing hard here is the fix —
# this line (and the reason it is written this way) MUST stay.
adb install "$APK" || { echo "::error::APK install failed — emulator job cannot run any flow"; exit 1; }

echo "== forwarding mock ports into the emulator (adb reverse) =="
for p in 4096 4097 4098 4099 4100; do adb reverse "tcp:$p" "tcp:$p"; done
adb reverse --list

# Decisive probe: can the EMULATOR actually reach the host mock via 127.0.0.1?
# If any in-emulator method prints the health JSON, the network path is good
# and any flow failure is app-side; if none succeed, attribution falls back to
# a host-side check + adb reverse state so we at least know the mock is up.
# `toybox wget`/`nc` don't work reliably on the API-28 image (wget: unknown
# command; nc connects but the request/response framing is unreliable) — so
# this tries curl (if present), then mksh's /dev/tcp pseudo-device (a shell
# builtin, not an external binary, so it survives whatever toybox applets
# this image did/didn't build), then nc as a last in-emulator attempt, before
# falling back to a host-side confirmation. This never blocks the flow — the
# result is recorded and the script continues regardless.
PROBE_FILE="$ROOT/artifacts/diag/probe.txt"
probe_result="UNKNOWN"

{
  echo "== emulator -> mock reachability probe (127.0.0.1:4096/global/health) =="
} > "$PROBE_FILE"

probe_via() {
  # $1 = human label for the log, $2 = remote shell command string
  local label="$1" cmd="$2" out
  echo "[$label]" | tee -a "$PROBE_FILE"
  out="$(timeout 10 adb shell "$cmd" 2>&1)"
  echo "$out" | tee -a "$PROBE_FILE"
  [[ "$out" == *'"healthy"'* ]]
}

if probe_via "curl" 'curl -s -m 5 http://127.0.0.1:4096/global/health'; then
  probe_result="PASS (curl)"
elif probe_via "toybox-wget" 'toybox wget -qO - http://127.0.0.1:4096/global/health'; then
  probe_result="PASS (wget)"
elif probe_via "mksh-devtcp" 'exec 3<>/dev/tcp/127.0.0.1/4096 && printf "GET /global/health HTTP/1.0\r\n\r\n" >&3 && cat <&3'; then
  probe_result="PASS (/dev/tcp)"
elif probe_via "nc" 'printf "GET /global/health HTTP/1.0\r\n\r\n" | toybox nc -w 3 127.0.0.1 4096'; then
  probe_result="PASS (nc)"
else
  echo "[fallback: host-side confirmation]" | tee -a "$PROBE_FILE"
  host_check="$(timeout 5 curl -s http://127.0.0.1:4096/global/health 2>&1 || true)"
  reverse_list="$(adb reverse --list 2>&1 || true)"
  {
    echo "host curl: $host_check"
    echo "adb reverse --list: $reverse_list"
  } | tee -a "$PROBE_FILE"
  if [[ "$host_check" == *'"healthy"'* ]]; then
    probe_result="UNKNOWN (host mock is up, but no in-emulator method could confirm emulator-side reachability)"
  else
    probe_result="FAIL (host mock itself is not responding on 127.0.0.1:4096)"
  fi
fi

echo "== probe result: $probe_result ==" | tee -a "$PROBE_FILE"

adb logcat -c || true            # clear, so the captured log is just this run

dump_diag() {
  echo "== capturing diagnostics =="
  adb logcat -d > "$ROOT/artifacts/diag/logcat.txt" 2>&1 || true
  # Maestro writes per-run debug (UI hierarchy + commands) under ~/.maestro/tests
  cp -r "$HOME/.maestro/tests" "$ROOT/artifacts/diag/maestro-tests" 2>/dev/null || true
}
trap dump_diag EXIT

# `cd` is a builtin, so without an explicit check a failed cd is invisible under
# `sh -c` without -e: the flows would run from the workspace root instead of the
# screenshots dir (maestro writes its -screen-*.png into the CWD, so screenshots
# would silently land outside the uploaded path) — and the run would still look
# green in `newer`. Same class of silent-failure as the adb install above.
cd "$ROOT/artifacts/screenshots" || { echo "::error::cannot cd into screenshots dir $ROOT/artifacts/screenshots"; exit 1; }
rc=0

# One wrapper so the per-flow timeout covers EVERY maestro invocation, core
# and newer alike. On the ceiling `timeout` kills maestro and exits 124;
# whatever maestro printed up to that point is already on stdout/stderr (the
# job log and screenshots dir), and 124 is just another non-zero → failed
# flow in the caller below.
run_maestro() {
  local f="$1"
  timeout "$FLOW_TIMEOUT_SECONDS" maestro test \
    --debug-output "$ROOT/artifacts/diag/maestro-$f" \
    "$ROOT/.maestro/flows/$f.yaml"
}

if [[ "$SUBSET" == "core" || "$SUBSET" == "all" ]]; then
  echo "== core flows (blocking — failure or ${FLOW_TIMEOUT_SECONDS}s timeout fails the run) =="
  for f in "${CORE_FLOWS[@]}"; do
    echo "--- flow (core, blocking): $f ---"
    if ! run_maestro "$f"; then
      echo "::error::Maestro flow failed (or exceeded ${FLOW_TIMEOUT_SECONDS}s timeout): $f"
      rc=1
      break
    fi
  done
fi

if [[ "$SUBSET" == "newer" || "$SUBSET" == "all" ]]; then
  # Newer flows: always run all of them (no `break` on failure) and never
  # affect $rc — see the CORE_FLOWS/NEWER_FLOWS comment above for why. Each
  # flow's own pass/fail is still clearly reported, just non-blocking.
  echo "== newer flows (non-blocking, tracked for hardening) =="
  for f in "${NEWER_FLOWS[@]}"; do
    echo "--- flow (newer, non-blocking): $f ---"
    if run_maestro "$f"; then
      echo "== newer flow PASSED: $f =="
    else
      echo "::warning::newer flow FAILED (timeout or assertion, non-blocking): $f"
    fi
  done
fi

exit $rc
