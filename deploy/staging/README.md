# Multi-node soak staging bundle (PTW-95)

Ready-to-run provisioning for the multi-node load/soak gate. Turns the
board-approved spend (approval `07ed1db2`) into a one-command deploy the moment a
cloud account + credentials are designated.

- **Agreed concurrency tier (CTO, PTW-95):** **20,000 concurrent sockets**
  (≈ 5,000 active 4-player rooms) on a **≥2-node** cluster (~10k/node).
  Rationale + SLOs: `socket_scaling_plan.md` Phase 0 → "AGREED TIER".
- **Gate procedure:** `../docs/MULTINODE_RUNBOOK.md` §3 (staged rollout) + §4 (soak).
- **SLOs (enforced by `bot/load-soak.js`):** connect ≥99%, join ≥99%,
  join p95 ≤2000ms, reconnect-within-grace ≥95%, sustained 4–12h.

## Files

| File | Purpose |
|------|---------|
| `Dockerfile` | Socket node image (also runs as a load generator). |
| `docker-compose.staging.yml` | Redis + 2 nodes + sticky nginx LB — topology rehearsal. |
| `nginx.staging.conf` | Sticky WS LB (runbook §2). |
| `run-soak.sh` | `local-smoke` (no infra) or `gate` (drive an existing cluster at 20k). |

## What is proven vs. what still needs hardware

- **Proven now (2026-06-12), credential-free:** the multi-node *topology* and the
  soak driver run end-to-end. `run-soak.sh local-smoke` boots a real Redis + 2
  node processes (adapter on, distinct `NODE_ID`) and runs a chaos soak — **all
  Phase 0 SLOs PASS** (connect/join 100%, join p95 ~17ms, reconnect-within-grace
  100%). This is the correctness/deploy rehearsal.
- **Still needs real hardware:** the **20k-socket capacity** number. A single dev
  box cannot sustain 20k sockets + drive load + run Redis. That run is the actual
  gate and requires the designated staging account (below).

```bash
# Correctness rehearsal — no docker, no cloud:
WEBHOOK_SECRET=dev-secret ./run-soak.sh local-smoke
```

## Run the soak (real cluster)

### Option A — docker compose (single host, topology + small/medium load)
```bash
WEBHOOK_SECRET=$SECRET docker compose -f docker-compose.staging.yml up --build -d
# drive the sticky LB:
WEBHOOK_SECRET=$SECRET SOCKET_URLS=http://localhost:8080 GATE_ROOMS=200 GATE_RUNTIME=600 ./run-soak.sh gate
docker compose -f docker-compose.staging.yml down -v
```
Note: compose uses a single Redis — fine for topology, **not** HA and **not** 20k.

### Option B — cloud, the actual 20k gate
1. Provision ≥2 (recommend 3, ~8 vCPU) socket node VMs/pods + **managed HA Redis**
   (Sentinel/cluster) shared by the adapter and the owner-lease registry.
2. Deploy the node image per `Dockerfile` (`REDIS_ADAPTER_ENABLED=true`, distinct
   `NODE_ID` per node — k8s: downward API `metadata.name`).
3. Front with the sticky LB (`nginx.staging.conf`, or ALB `app_cookie` / k8s
   `affinity: cookie` per runbook §2).
4. Drive from 2–4 dedicated generator boxes so no single box bottlenecks:
   ```bash
   WEBHOOK_SECRET=$SECRET SOCKET_URLS=http://lb:8080 GATE_ROOMS=5000 GATE_RUNTIME=14400 ./run-soak.sh gate
   ```
5. Also run the **network-level** owner-kill (runbook §4): `kill -9` / `kubectl
   delete pod` the node owning an in-progress room mid-turn; confirm a player on
   the survivor resumes (`room_rehydrated_for_join` + a turn advancing).

A clean PASS here is the PTW-58 soak gate; it auto-unblocks PTW-40.

## The one remaining human input

Everything above is built and the topology is validated. The **only** blocker to
the 20k capacity run is a **designated cloud account + credentials** (provider +
project + service-account creds, or a staging host ops will run this bundle on).
No agent holds cloud billing creds and there is no DevOps agent, so this is an
access grant only the board/ops can make. The spend itself is already approved
(`07ed1db2`).
