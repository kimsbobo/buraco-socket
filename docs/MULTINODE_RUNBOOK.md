# Multi-node Socket Runbook (PTW-40)

Status: **capability built, NOT yet activated.** Production still runs
single-instance (`replicas = 1`). This runbook is the activation procedure and
the load-balancer configuration for the day the single-node ceiling is lifted.

Reference: [`../../socket_scaling_plan.md`](../../socket_scaling_plan.md),
`DEPLOY_TOPOLOGY.md`. The four hard-gate items from PTW-40:

| # | Gate item | State |
|---|-----------|-------|
| 1 | Socket.IO Redis adapter (cross-node fan-out) | **Built** — `src/index.js`, flag `REDIS_ADAPTER_ENABLED`, fail-fast boot. Cross-node delivery proven by `test/multinode_adapter.test.js`. |
| 2 | Per-room owner lease + cross-node action forwarding | **Built** — `RoomOwnerLease` + `_runOwnedSocketMutation` route all 8 mutating actions to the owner node (PTW-57). Unit-tested: `test/room_owner_lease.test.js`. |
| 3 | Sticky sessions at the LB | **Configured here** (see below). |
| 4 | Passed load/soak at agreed concurrency tier | **Tooling built** (`bot/load-soak.js --socket-urls`); production-tier run owned by PTW-58 and requires real multi-node staging infra. |

Do not raise `replicas > 1` until item 4 passes on staging.

---

## 1. Why sticky sessions are load-bearing (read this first)

The Redis adapter fans out **broadcasts** across nodes, and the owner lease makes
**mutations** safe (exactly one node advances a room's turn/timer/bots; non-owner
nodes forward via `serverSideEmitWithAck`). But the authoritative `GameRoom`
object lives **in the memory of the node that received the room's `sync-room`
webhook** during normal operation.

Cross-node room *rehydration* has now landed (PTW-90, Phase 3): if a player lands
on a node that does **not** hold the room, `handleJoinRoom` →
`_rehydrateRoomForJoin` reconstructs it from the persisted state in Redis
(`game:{roomId}:state`, written by `FailureManager.persistGameState` after every
action) instead of returning `join_rejected_room_not_synced`. On rehydrate the
node attempts owner re-election: it wins the lease only if the previous owner's
lease has expired (a real crash), otherwise it keeps a passive read-copy and
forwards mutations to the live owner. So a player can now be served by **any**
node, and an owner-node crash no longer freezes its rooms.

Sticky sessions are therefore now a **transition aid / latency optimization**,
not a correctness requirement: keeping a room's players on its owner node avoids
the rehydrate hop and the extra mutation-forwarding round-trip. Recommended to
keep them on during initial rollout (Stage 1–3) and revisit at the Stage 4
cleanup once failover has soaked.

Pick a stickiness key that is **stable for the lifetime of a room membership**:

- Preferred: a cookie/affinity issued at the WebSocket upgrade and held for the
  connection's life (Socket.IO reconnects reuse it).
- Acceptable fallback: source-IP hash (`ip_hash`) — weaker under CGNAT/mobile IP
  rotation, which is exactly when a reconnect can land on the wrong node. If you
  rely on it, keep the reconnect grace window comfortably long.

WebSocket transport must be allowed end-to-end (upgrade headers, no buffering,
long idle timeouts). Socket.IO long-polling fallback **requires** stickiness too;
without it, successive polls hit different nodes and the session breaks.

---

## 2. Load-balancer configuration

### nginx

```nginx
upstream brazilia_socket {
    ip_hash;                       # source-IP stickiness (fallback method)
    server 10.0.0.11:8080 max_fails=3 fail_timeout=10s;
    server 10.0.0.12:8080 max_fails=3 fail_timeout=10s;
    keepalive 64;
}

server {
    listen 443 ssl;
    server_name ws-buraco.wblue.id;

    location / {
        proxy_pass http://brazilia_socket;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;   # WebSocket upgrade
        proxy_set_header Connection "upgrade";
        proxy_set_header Host       $host;
        proxy_set_header X-Real-IP  $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        proxy_read_timeout  3600s;   # don't cut idle game connections
        proxy_send_timeout  3600s;
        proxy_buffering     off;     # realtime; never buffer frames
    }
}
```

Cookie-based stickiness (stronger than `ip_hash`) needs nginx-plus
(`sticky cookie`) or front it with a cookie-issuing LB (below).

### AWS ALB (target group)

- Protocol HTTP/HTTPS with **stickiness enabled**, type
  `app_cookie` (preferred) or `lb_cookie`, duration ≥ the reconnect grace window
  (`RECONNECT_GRACE_MS`, default 30s) — set it to hours to survive a full game.
- Idle timeout ≥ 3600s.
- Health check: `GET /health` (or the existing socket health route), healthy
  threshold low so a crashed node drains fast.

### Kubernetes (Ingress / Service)

- `Service.spec.sessionAffinity: ClientIP` (with
  `sessionAffinityConfig.clientIP.timeoutSeconds` long), **or**
- nginx-ingress annotations:
  ```yaml
  nginx.ingress.kubernetes.io/affinity: "cookie"
  nginx.ingress.kubernetes.io/affinity-mode: "persistent"
  nginx.ingress.kubernetes.io/session-cookie-name: "brazilia_node"
  nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
  ```
- The socket Deployment must set a **stable `NODE_ID` per pod** (e.g. from
  `metadata.name` via the downward API) so lease ownership and structured logs
  are attributable.

---

## 3. Activation procedure (staged, per scaling plan Phase 8)

Pre-req: HA Redis reachable by all nodes (same instance/cluster for the adapter
**and** the owner-lease registry — they must share state).

1. **Shadow (replicas still 1).** Deploy with `REDIS_ADAPTER_ENABLED=true` on the
   single node. Adapter attaches and fail-fast-boots if Redis is unreachable.
   Behavior is unchanged with one node; this validates adapter health + metrics
   in production before any second node exists.
2. **Stand up staging cluster (≥2 nodes).** Same Redis, sticky LB per §2,
   distinct `NODE_ID` per node.
3. **Run the soak gate (item 4).** See §4. Must PASS at the agreed concurrency
   tier before any production multi-node traffic.
4. **Canary 5–10% → 25% → 50% → 100%**, watching the SLO + ownership metrics
   below at each step.
5. Only after a clean soak + canary do you set production `replicas > 1`.

Rollback triggers: reconnect success below target, p95 action latency sustained
over threshold, or any split-brain / duplicate-turn signal. Rollback = scale
back to `replicas: 1` and `REDIS_ADAPTER_ENABLED=false`.

---

## 4. Load / soak gate (item 4)

The driver is multi-node-aware:

```bash
# Two-node cluster, rooms spread round-robin, sticky per room.
npm run bot:load-soak -- \
  --socket-urls http://node-a:8080,http://node-b:8080 \
  --rooms 200 --players-per-room 4 \
  --runtime-seconds 14400 \           # 4h soak (use 4–12h for the gate)
  --chaos-interval-ms 5000 \
  --slo-connect-success 99 --slo-join-success 99 \
  --slo-join-p95-ms 2000 --slo-reconnect-success 95
```

Each room (its `sync-room` webhook, its bots, its `start-game`, its runtime
snapshots) pins to one node, mirroring sticky-session routing; rooms distribute
across the cluster. The run scores the Phase 0 SLOs and exits non-zero on any
breach.

**Agreed concurrency tier = 20,000 concurrent sockets** (≈ 5,000 active
4-player rooms), CTO decision on PTW-95 (2026-06-12). Run on a **≥2-node**
staging cluster (~10k sockets/node, headroom for a node loss). 5k was below a
single node's ceiling (wouldn't exercise multi-node); 50k was over-provisioned
pre-PMF (Tier-2, revisit post-launch on growth data). See
`socket_scaling_plan.md` Phase 0 → "AGREED TIER" for full rationale + SLO
targets. The gate owner (PTW-58) runs the soak at this tier on staging hardware.
A laptop run proves correctness, not capacity.

Example gate invocation at the agreed tier (200 rooms × 4 players = 800 sockets
per shard; scale shard count / `--rooms` to reach 20k across the cluster):

Local correctness evidence already captured (not a capacity result):

- `test/multinode_adapter.test.js` — cross-node broadcast fan-out + room
  isolation against a real Redis. PASS.
- `test/room_owner_lease.test.js` — atomic acquire/renew/release. PASS (7/7).
- `test/owner_failover_rehydration.test.js` — owner-kill mid-turn → surviving
  node rehydrates the room from persisted Redis state, wins the freed lease
  (controlled re-election) and restarts runtime; plus the split-brain guard
  (no lease theft from a live owner). PASS (PTW-90, Phase 3).

### Chaos coverage status

| Scenario | Covered now | Notes |
|----------|-------------|-------|
| Client network drop + reconnect within grace | Yes (`--chaos-interval-ms`) | scored as `reconnect_within_grace` SLO |
| Cross-node broadcast under load | Yes | rooms split across nodes; adapter test proves fan-out |
| **Owner-node kill mid-turn** | **Yes (deterministic)** | PTW-90 Phase 3: `handleJoinRoom` → `_rehydrateRoomForJoin` reads `game:{roomId}:state` from Redis, reconstructs the room, and `_ensureRoomOwner(acquire)` re-elects the new owner + restarts the turn timer/bots. Proven by `test/owner_failover_rehydration.test.js`. The **network-level** kill (SIGKILL a real node pod mid-turn) still needs the staging multi-node infra and is part of the PTW-58 gate run — see below. |
| Redis brief outage | No | add to the gate run on staging. |

Phase 3 rehydration has landed (PTW-90): a surviving node can now serve a room
whose owner crashed. Before flipping `replicas > 1` in production, still run the
**network-level** owner-kill on staging: with `--socket-urls a,b` driving a real
two-node cluster behind the sticky LB, `kubectl delete pod` (or `kill -9`) the
node owning an in-progress room mid-turn and confirm a player landing on the
survivor resumes the game (look for `room_rehydrated_for_join` in its logs and a
turn advancing). This is the production-tier proof; the deterministic test above
proves the code path.

---

## 5. Metrics to watch (Phase 7 minimum)

- active sockets, active rooms, rooms per node
- join / action latency p50/p95/p99
- reconnect attempts + success rate
- owner-lease acquire/renew/release counts, ownership handoffs
- Redis latency, pub/sub lag, command errors
- webhook sync success/failure, reconcile drift count

Correlate logs by `requestId`, `roomId`, `playerId`, `nodeId`, `socketId`
(already emitted by `_logRoomLifecycle` / `[ROOM_OWNER]`).
