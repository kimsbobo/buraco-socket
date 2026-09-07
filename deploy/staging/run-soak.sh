#!/usr/bin/env bash
# Multi-node soak runner for PTW-95 (scaling_plan Phase 6, runbook §4).
#
# Two modes:
#   local-smoke  — no docker/cloud needed. Boots a local Redis + 2 node procs and
#                  runs a short soak. Proves topology + driver end-to-end. This is
#                  the CORRECTNESS rehearsal, validated 2026-06-12 (all SLOs PASS).
#   gate         — drives the soak against an ALREADY-RUNNING cluster you point it
#                  at via SOCKET_URLS, at the AGREED TIER (20k sockets). Run this
#                  on real staging hardware for the capacity PASS.
#
# Usage:
#   WEBHOOK_SECRET=... ./run-soak.sh local-smoke
#   WEBHOOK_SECRET=... SOCKET_URLS=http://a:8080,http://b:8080 ./run-soak.sh gate
set -euo pipefail
cd "$(dirname "$0")/../.."   # -> socket/

MODE="${1:-local-smoke}"
: "${WEBHOOK_SECRET:?set WEBHOOK_SECRET (must match the nodes)}"

# Agreed concurrency tier (CTO, PTW-95): 20,000 sockets = 5,000 rooms x 4 players.
# Scale ROOMS so ROOMS*PLAYERS == target socket count. Run the gate from enough
# generator boxes that no single box is the bottleneck.
GATE_ROOMS="${GATE_ROOMS:-5000}"
GATE_PLAYERS="${GATE_PLAYERS:-4}"
GATE_RUNTIME="${GATE_RUNTIME:-14400}"   # 4h floor; use up to 43200 (12h) for the gate
SLO="--slo-connect-success 99 --slo-join-success 99 --slo-join-p95-ms 2000 --slo-reconnect-success 95"

if [[ "$MODE" == "gate" ]]; then
  : "${SOCKET_URLS:?set SOCKET_URLS=http://node-a:8080,http://node-b:8080 (the sticky LB or per-node URLs)}"
  echo "[GATE] AGREED TIER soak: ${GATE_ROOMS} rooms x ${GATE_PLAYERS} = $((GATE_ROOMS*GATE_PLAYERS)) sockets, ${GATE_RUNTIME}s"
  exec node bot/load-soak.js \
    --socket-urls "$SOCKET_URLS" \
    --rooms "$GATE_ROOMS" --players-per-room "$GATE_PLAYERS" \
    --runtime-seconds "$GATE_RUNTIME" \
    --chaos-interval-ms 5000 $SLO
fi

# ---- local-smoke ----------------------------------------------------------
echo "[SMOKE] booting local redis + 2 socket nodes (no docker needed)"
redis-cli ping >/dev/null 2>&1 || redis-server --daemonize yes --save '' --appendonly no >/dev/null 2>&1
sleep 1; redis-cli flushall >/dev/null 2>&1

start_node() { # name port
  NODE_ENV=test PORT="$2" NODE_ID="$1" REDIS_HOST=127.0.0.1 REDIS_PORT=6379 \
    REDIS_ADAPTER_ENABLED=true WEBHOOK_SECRET="$WEBHOOK_SECRET" \
    node src/index.js >"/tmp/$1.log" 2>&1 &
  echo $!
}
PID_A=$(start_node soak-node-a 8080)
PID_B=$(start_node soak-node-b 8081)
trap 'kill "$PID_A" "$PID_B" 2>/dev/null || true' EXIT
sleep 4
curl -sf http://127.0.0.1:8080/health >/dev/null && curl -sf http://127.0.0.1:8081/health >/dev/null \
  && echo "[SMOKE] both nodes healthy" || { echo "[SMOKE] node boot FAILED"; cat /tmp/soak-node-*.log; exit 1; }

node bot/load-soak.js \
  --socket-urls http://127.0.0.1:8080,http://127.0.0.1:8081 \
  --rooms "${SMOKE_ROOMS:-6}" --players-per-room "${SMOKE_PLAYERS:-2}" \
  --runtime-seconds "${SMOKE_RUNTIME:-30}" \
  --chaos-interval-ms 5000 $SLO
