# System Performance & Scalability Analysis

> **Architecture snapshot — this analysis is grounded in the actual implementation.**
> Runtime: Node.js 24 / Express 5 (native TypeScript, no bundler) · Redis 8 (single
> primary, AOF) via one `node-redis` TCP connection per process · Redis Streams
> write-behind queue (`queue:orders`, `MAXLEN ~200 000`) · MongoDB 8 audit store ·
> nginx reverse-proxy. The concurrency core is a single atomic Lua script
> (`adapters/redis/order.lua`) executed via `EVALSHA` — the sole writer of
> `stock:{saleId}:remaining` and `orders:{saleId}:users` while the API is serving.
> The API tier is stateless and designed to scale horizontally; **one Redis primary
> is the acknowledged throughput ceiling** (see [Known Limitations](../README.md#known-limitations)).

## Traffic tier summary

| Tier | Concurrent Users | Est. Peak RPS¹ | SSE Connections | Feasibility |
|------|-----------------|----------------|-----------------|-------------|
| 1 | 5,000 | ~1,000 RPS | ~5,000 | ✅ Yes, out of the box |
| 2 | 100,000 | ~20,000 RPS | ~100,000 | ⚠️ With modifications |
| 3 | 500,000 | ~100,000 RPS | ~500,000 | ❌ Major changes required |
| 4 | 1,000,000 | ~200,000 RPS | ~1,000,000 | ❌ Full redesign required |

> ¹ **RPS formula:** `(Concurrent Users × 2 req/user) ÷ 10 s burst window` — models
> a *sustained* 10-second peak where each user submits one status poll and one order
> attempt. Actual flash-sale bursts are more instantaneous: stress test `20260716_0044`
> recorded **9,142 RPS** from 5,000 VUs firing in ~549 ms — roughly 9× the Tier 1
> sustained estimate. Use the table figures for capacity planning; treat the measured
> burst RPS as the worst-case spike envelope. SSE connections are persistent (not
> included in RPS) and listed separately.

---

## Tier 1 — 5,000 Concurrent Users · ~1,000 RPS (burst: ~9,100 RPS)

### Estimated load profile

| Signal | Estimated (sustained) | Measured — stress test `20260716_0044` |
|--------|-----------------------|----------------------------------------|
| HTTP RPS | ~1,000 | **9,142 RPS** (5,000 VUs, ~549 ms burst, localhost) |
| SSE connections | ~5,000 long-lived sockets | — (not measured in stress run) |
| Redis commands/s | ~1,000–2,000 | — |
| Worker throughput needed | ~50–100 orders persisted/s | — |
| Latency p50 | — | **18.33 ms** |
| Latency p90 | — | **40.28 ms** |
| Latency p95 | — | **363.20 ms** ⚠️ (9× jump from p90) |
| Latency p99 | — | **< 473 ms** |
| HTTP error rate | — | **0%** ✅ |
| Orders created / stock | — | **100 / 100** ✅ (0 oversell) |

> Measured figures are from a local-machine run (Redis co-located, no real network
> latency). In staging with a dedicated Redis instance, TTFB will increase as
> Redis round-trips add real network latency; the p90→p95 cliff may widen further.

### Feasibility assessment: ✅ Yes — current stack handles this tier as deployed

A single Express 5 / Node.js 24 process sustains this tier. Stress test `20260716_0044`
confirmed zero HTTP errors across 5,020 requests and exact inventory control (100/100,
no oversell). The Lua script + Redis path is fast: p50 = 18 ms, p90 = 40 ms. However,
**99.1% of request time is server-side TTFB** — network is negligible, and the
bottleneck is the Node.js event loop under simultaneous arrivals.

### Expected bottlenecks

- **p90→p95 latency cliff (measured).** The stress test recorded p90 = 40 ms and
  p95 = 363 ms — a **9× jump** in the worst 5% of requests (~251 out of 5,020). This
  is the Node.js event loop queuing callbacks from 5,000 simultaneous arrivals. It is
  not a correctness failure, but 1-in-20 buyers experience a noticeably slower response
  during the burst peak. Under real-world conditions (non-localhost Redis, network
  jitter), this tail will widen.
- **TCP connection-establishment burst at Tier 1 tail (measured).** `http_req_blocked`
  p95 = 20.41 ms in the stress test — VUs paying a TCP handshake cost as 5,000 connections
  are established simultaneously at t=0. `http_req_blocked` avg (2.31 ms) ≈
  `http_req_connecting` avg (2.26 ms), and their p95 values are equally close (20.41 ms vs
  20.37 ms): when these two metrics track each other this tightly, almost every blocked event
  is a *new* TCP handshake rather than pool-slot starvation. This is a k6 client-side burst
  startup artefact — it has no causal relationship to the API's Redis connection — and does
  not recur once keep-alive connections are established. It does not affect p50 or p90.
- **No rate limiting (documented limitation).** Without a per-IP or per-email throttle,
  a bot can monopolize event-loop capacity. The Lua script prevents oversell, but
  illegitimate traffic inflates tail latency for real buyers.
- **`spam_wins_202` hit the threshold boundary (measured).** The anti-spam guard passed
  at exactly 1/1 (the threshold limit) in the stress test. At higher VU counts or
  request rates, this counter could breach its threshold, exposing the email-aliasing
  bypass documented in Known Limitations.
- **Single Docker container; no upstream load balancer.** Any process crash takes the
  service offline until `restart: unless-stopped` restarts it (~2–5 s gap).
- **SSE + HTTP/1.1 browser connection cap.** Browsers enforce ~6 connections per origin;
  multiple tabs exhaust this before any server-side limit is reached.

### Architectural mitigations

- **Add `express-rate-limit` (or nginx `limit_req_zone`) on `POST /orders`.** The
  fairness guarantee is unaffected; rate limiting reduces the event-loop queuing that
  causes the p90→p95 cliff under burst.
- **Add a k6 ramp-up stage before the main burst** in the next staging run to spread
  TCP connection establishment over time and flatten the `http_req_blocked` tail. The
  `http_req_blocked` p95 of 20.41 ms is a one-time burst startup cost (`blocked ≈
  connecting`), not a server-side bottleneck — no server change is required.
- **Consider `ioredis` connection pooling (2–3 connections per process)** to reduce
  head-of-line blocking on the API→Redis socket under bursty pipelining patterns.
  `RedisClient` is dependency-injected through `bootstrap.ts`, so this is a one-line
  swap. Note: this does not affect `http_req_blocked` (which is a k6 HTTP metric),
  but it does improve Redis command throughput under sustained concurrency.
- **Run ≥2 API replicas behind nginx or HAProxy** for basic fault tolerance.
- **Raise the spam scenario's VU count** in `k6-order.js` to stress `spam_wins_202`
  above its boundary before moving to staging. The primary scenario's `VUS` env var
  does not affect the spam scenario — it runs 20 VUs unconditionally regardless of
  the primary burst size.
- Configure nginx with `http2 on` to lift the HTTP/1.1 browser connection cap.

---

## Tier 2 — 100,000 Concurrent Users · ~20,000 RPS

### Estimated load profile

| Signal | Value |
|--------|-------|
| HTTP RPS | ~20,000 |
| SSE connections | ~100,000 long-lived sockets |
| Redis commands/s | ~20,000–40,000 |
| Worker throughput needed | ~2,000 orders persisted/s (20× the default single-worker ceiling) |

### Feasibility assessment: ⚠️ With modifications — single-process deployment fails

> **⚠️ Critical: SSE memory exhaustion.** 100,000 concurrent SSE connections on one
> Node.js process require an estimated 1–3 GB RSS (roughly 2–5 KB per idle connection
> for socket + `http.ServerResponse` object overhead). That alone strains a typical
> container memory limit, and the peak order burst then adds GC pressure on top.

> **⚠️ Critical: event-loop saturation.** Express 5 runs on Node.js's single-threaded
> event loop. At 20k RPS with Redis round-trips per request, GC pressure and callback
> queuing push p99 latency past 1 s on a single process — triggering
> `REDIS_COMMAND_TIMEOUT_MS` failures and cascading 503s.

### Expected bottlenecks

- **Single `node-redis` connection per process.** node-redis uses one TCP socket (see
  `adapters/redis/client.ts` comments; connection pooling is explicitly deferred to the
  roadmap). High-concurrency pods pipeline commands, but every in-flight command behind
  a slow one is head-of-line-blocked on that socket. At 20,000+ RPS across multiple pods
  this becomes a primary throughput limiter — each pod's Redis socket is a single-lane
  pipe for all in-flight commands.
- **Per-process in-memory slug resolver cache.** 10 API replicas = 10 independent
  60-second TTL caches with no invalidation broadcast. A sale configuration update is
  inconsistent across replicas for up to 60 s — an operational risk, not a correctness
  issue, but one that surfaces under horizontal scaling.
- **Single worker consumer.** At minimum throughput (sparse queue, each `XREADGROUP
  BLOCK 500` call waiting the full 500 ms timeout), the default `worker-1` consumer
  processes `batchSize 50 ÷ 0.5 s` = ~100 ops/s. When the stream is active, `XREADGROUP`
  returns immediately and throughput is bounded by MongoDB write latency — well above
  100/s in practice. However, even at peak worker throughput, a single consumer cannot
  keep pace with 20k accepted orders/s: stream depth climbs toward the `MAXLEN ~200 000`
  safety valve and approximate trimming (`~`) begins silently dropping entries.

### Architectural mitigations

- **Scale API horizontally to 8–12 replicas** behind a load balancer. Each pod holds
  ~8–12k SSE connections — well within single-process memory limits. The stateless
  design (all shared state lives in Redis) means no replica coordination is required.
- **Dedicate SSE to a fan-out gateway.** Deploy a lightweight service that holds browser
  SSE connections and subscribes to `sale:{saleId}:events` on Redis pub/sub. This fully
  decouples long-lived socket management from the order-critical Express process. The
  existing Redis pub/sub channel (`adapters/redis/events.ts`) is the integration point.
- **Scale worker replicas to 4–8.** Each replica uses a unique `WORKER_CONSUMER_ID`
  (already supported via env var; see `WorkerConfig`). Increase `batchSize` from 50 →
  200 per replica. XREADGROUP consumer-group semantics ensure no message is double-processed.
- **Replace `node-redis` with `ioredis` with connection pooling.** A pool of 3–5
  connections per API pod reduces head-of-line blocking under bursty command patterns
  without changing any application logic — `RedisClient` is dependency-injected through
  `bootstrap.ts`.
- **Add nginx `limit_req_zone` by IP upstream.** This is now a correctness concern, not
  just tidiness: an unconstrained flood at 20k RPS can collapse the event loop before
  legitimate users' order requests are processed.

---

## Tier 3 — 500,000 Concurrent Users · ~100,000 RPS

### Estimated load profile

| Signal | Value |
|--------|-------|
| HTTP RPS | ~100,000 |
| SSE connections | ~500,000 long-lived sockets |
| Redis write commands/s | ~100,000–200,000 (EVALSHA + XADD path) |
| Worker throughput needed | ~50,000 orders persisted/s (requires 250+ worker instances at default config) |

### Feasibility assessment: ❌ Major architectural changes required

> **🚨 Critical: Redis single-primary write saturation.** A single Redis 8 primary
> processes `EVALSHA` (two key reads + conditional writes + DECR/SADD) at roughly
> 30k–80k script executions/s on modern hardware — not the 1M+ ops/s achievable for
> simple `GET`/`SET`. At ~100k order RPS, the primary saturates, command timeouts
> accumulate, and the fail-closed policy (`disableOfflineQueue: true`, 503 on timeout)
> begins rejecting legitimate orders at scale.

> **🚨 Critical: SSE connection infrastructure.** 500,000 SSE connections distributed
> at 10k per pod requires 50 dedicated SSE gateway pods. A standard Express API pod
> cannot double as an SSE gateway at this density while also processing orders.

### Expected bottlenecks

- **Redis single-process command limit.** `EVALSHA` throughput ceiling, compounded by
  SSE broadcaster status reads (`stock:{saleId}:remaining` per event) and per-accepted-
  order `XADD` stream writes — all competing on one primary's single-threaded command
  queue.
- **SSE broadcaster fan-out amplification.** If the SSE layer is still co-located with
  the API, Redis pub/sub events are delivered to 50+ API pods, each forwarding to 10k
  browser sockets. That is O(pods × connections_per_pod) socket writes per domain event.
- **Stream `MAXLEN ~200 000` cap becomes a data-loss risk.** At 500k accepted orders
  (assuming a large stock), approximate trimming (`~`) silently drops stream entries
  before workers can drain them. Audit records are permanently lost.
- **Absence of observability.** At this scale, `pino` request logs without structured
  metrics or distributed tracing make diagnosing the actual bottleneck nearly impossible
  under live traffic.

### Architectural mitigations

- **Redis read replicas for status reads.** Route `GET /status` (stock remaining,
  `GETEX stock:{saleId}:remaining`) to Redis replicas. All writes — the Lua script,
  XADD, PUBLISH — remain on the primary. This halves primary command volume for
  read-heavy traffic patterns.
- **Pre-shard inventory across Redis primaries.** Partition stock into N sub-inventories
  (e.g., 10 × 50k units). Route each buyer by `hash(email) % N` to a shard. Each shard
  runs its own Lua script. The `sold_out` event requires a coordinator to merge shard
  states — a significant change to `order.lua` and `reconcile.ts`, but the existing key
  tagging (`{saleId}` in all key names) is structurally compatible with Redis Cluster
  hash-slot routing without key renaming.
- **Deploy a purpose-built SSE fan-out service.** A Go or Rust service using
  `epoll`/`io_uring` can hold 500k SSE connections at negligible per-connection CPU
  cost. It subscribes to `sale:{saleId}:events` via Redis pub/sub and forwards events to
  browser clients. Express pods are fully relieved of SSE state.
- **Scale worker fleet to 20–40 replicas** with `batchSize 200` each. A second consumer
  group on the same stream can serve analytics without interfering with audit writes.
- **Raise stream `MAXLEN` to `~5 000 000`** to absorb large-stock sales without data
  loss under a delayed worker fleet.
- **Add structured observability.** Instrument Redis command latency (histogram), order
  accept rate (counter), worker PEL depth (gauge), and SSE connection count via
  Prometheus + Grafana. Without these signals, capacity planning at this tier is
  guesswork.
- **CDN in front of the status endpoint.** Cache `GET /status` at CDN edge with a 1–5s
  TTL. At 500k users polling every few seconds, CDN absorbs the read stampede and
  eliminates a Redis read-path bottleneck without changing any server logic.

---

## Tier 4 — 1,000,000 Concurrent Users · ~200,000 RPS

### Estimated load profile

| Signal | Value |
|--------|-------|
| HTTP RPS | ~200,000 |
| SSE connections | ~1,000,000 long-lived sockets |
| Redis write commands/s | ~200,000–400,000 (Lua + XADD + PUBLISH per order) |
| Worker throughput needed | ~100,000 orders persisted/s; stream must absorb 1M entries without data loss |

### Feasibility assessment: ❌ Full redesign required

> **🚨 Critical: single-shard Redis is exhausted.** Even an optimally configured Redis
> primary cannot sustain 200k+ script executions/s. Single-threaded command execution
> means every in-flight `EVALSHA` blocks the next; the tail latency profile collapses,
> fail-closed 503s dominate, and the system is effectively offline for order acceptance.

> **🚨 Critical: 1M SSE connections demand global edge infrastructure.** A single-region
> Docker deployment cannot hold 1 million persistent connections. This requires globally
> distributed edge nodes — a fundamentally different operational model.

> **🚨 Critical: audit stream data loss.** At 1M accepted orders, the `MAXLEN ~200 000`
> trim silently deletes ~80% of stream entries before the worker can read them, leaving
> the MongoDB audit trail with a permanent 800k-record hole.

### Expected bottlenecks

- **Redis single-process command limit.** `EVALSHA` throughput wall at 200k+ RPS.
- **Bootstrap cold-start latency.** Rebuilding `orders:{saleId}:users` from 1M MongoDB
  order records (`bootstrap.ts` → `reconciler.rebuild`) on a cold start becomes a
  multi-minute blocking operation, delaying the API's readiness gate.
- **MongoDB bulk write saturation.** A single replica set's write throughput caps out
  well below 100k ordered documents/s. Without sharding the `orders` collection, the
  worker fleet backs up indefinitely.
- **Node.js GC as a scaling inhibitor.** At 200k RPS across ~100 Express pods, the V8
  GC pause profile and single-threaded event model impose per-pod throughput ceilings
  that a compiled-language runtime does not share.

### Architectural mitigations

- **Redis Cluster with consistent-hashed inventory.** Distribute stock across N primary
  shards using Redis Cluster. The existing `{saleId}` key tagging in all Redis keys is
  structurally compatible with Cluster hash-slot routing — the Lua script does not need
  key renaming, only routing logic in the caller. A separate coordinator key tracks
  global sold-out state.
- **Reserve-pool model.** Assign blocks of inventory to each API pod at boot (e.g.,
  1k units/pod). Each pod runs the Lua script against its local reservation. A
  coordinator merges reservations and handles spillover between pods. This trades strict
  global ordering for horizontal write throughput — the correct trade-off at 1M users.
- **Global edge SSE tier.** Deploy SSE fan-out at CDN edge nodes (Cloudflare Workers,
  AWS Lambda@Edge, or similar) subscribing to a global pub/sub bus (GCP Pub/Sub, AWS
  SNS, or a Kafka topic per sale). Each edge PoP fans out to local browser connections
  with zero cross-region socket hops.
- **Raise `MAXLEN` to `~10 000 000`** and scale worker fleet to 50–100 replicas with
  `batchSize 500` each. A dedicated worker group per region avoids cross-region MongoDB
  write amplification.
- **Shard MongoDB `orders` collection on `saleId`.** Distribute writes across replica
  sets with a hash-sharded `orders` collection. The `BulkAuditPort` interface in
  `adapters/mongo/bulk-audit.ts` is the integration point — no worker-level change is
  required beyond the connection string.
- **Pre-warm Redis from a snapshot on cold start.** Store a compressed snapshot of
  `orders:{saleId}:users` in S3/GCS, loaded at bootstrap to avoid a full MongoDB scan
  rebuilding 1M records. The existing `reconciler.rebuild()` interface is the extension
  point.
- **Replace Express with a higher-throughput HTTP layer** for the order route. The
  `createOrderService` port interface and the `OrderAttemptPort` / `OrderAuditPort` /
  `OrderEventsPort` contracts are framework-free — a Fastify, uWebSockets.js, or
  compiled-language HTTP layer can slot in at the `routes/order.ts` boundary without
  touching business logic.

---

## What scales correctly by design — at any tier

The following properties are correct under horizontal scaling at every tier and require
no changes:

| Property | Scaling characteristic |
|----------|----------------------|
| Stateless API tier | Adding replicas requires zero coordination; all shared state lives in Redis |
| Lua script atomicity | Race-free at any concurrency — no application-layer locks, no retry loops. Confirmed by stress test `20260716_0044`: 100/100 orders accepted, 0 oversell across 5,020 concurrent requests |
| Write-behind queue | MongoDB is never on the hot request path at any replica count |
| PEL at-least-once retry | Worker crash recovery is built-in; adding replicas only improves throughput |
| `{saleId}` key tagging | Redis key naming is structurally compatible with Redis Cluster hash-slot routing |
| Fail-closed on Redis loss | Correctness is preserved under partial failure regardless of replica count |
| Port-based dependency injection | `bootstrap.ts` wires every adapter through interface boundaries — scaling infra (Redis client, Mongo ops, worker config) is swappable without touching service logic |

The principal scaling constraint is the one explicitly documented as a known limitation:
**one Redis primary is the shared write-path ceiling.** Every mitigation at Tiers 1–2
buys headroom without touching this invariant. At Tier 3+ the invariant itself must
change — inventory sharding becomes the architectural inflection point.
