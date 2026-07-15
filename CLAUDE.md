# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
npm run dev              # concurrent server (:3000) + worker + Vite client (:5173)
npm test                 # vitest run across all workspaces
npm run typecheck        # tsc --noEmit in server + client

# Per-workspace
npm run dev -w server
npm run dev:worker -w server   # standalone worker (hot-reload via --watch)
npm run test -w server
npm run test:watch -w server
npm run dev -w client
npm run test -w client

# Single test file
npx vitest run server/test/order-service.test.ts
npx vitest run server/test/order-service.test.ts -t "test name pattern"

# Docker stack
make build               # build all images (api + worker); always includes worker profile
make deploy              # build + start full stack (api + worker + Redis + MongoDB + client)
make worker-logs         # tail worker container logs only
make stress              # fairness proof (stop → reset → start → k6 → verify)
make clean               # docker compose down -v --rmi local
```

No lint step is configured in this project.

## Architecture

### Three strictly separated layers

**Redis (decision layer):** The only state read/written per request. A single atomic Lua script (`server/src/adapters/redis/order.lua`) is the sole writer of two keys:
- `stock:{saleId}:remaining` (integer)
- `orders:{saleId}:users` (set)

Keys are namespaced by MongoDB ObjectId of the active sale. Nothing else writes these keys during serving.

**Redis Stream (write-behind queue):** After the Lua script accepts an order, the route enqueues the payload to `queue:orders` (Redis Stream) and returns HTTP 202. The worker drains the stream into MongoDB asynchronously. This decouples order acceptance latency from MongoDB write latency.

**MongoDB (audit layer):** Written by the background worker, never on the HTTP request path. Read only at cold-start to rebuild Redis state. `bootstrap.ts` performs reconcile (warm vs. cold start) before the server accepts requests.

**SSE broadcaster:** Redis pub/sub on `sale:{saleId}:events` carries type-only events. The client SSE hook falls back to polling if the stream drops, with a watchdog for stale connections.

### Write-behind worker

`server/src/worker/` contains the background process that drains `queue:orders` into MongoDB:

- `order-worker.ts` — polling loop using XREADGROUP consumer group `workers/worker-1`. Every iteration calls `readPending()` (id=`0`, re-delivers unACKed PEL entries) first, then `readBatch()` (id=`>`, new messages) only when the PEL is empty. This ensures failed batches are retried after a MongoDB outage without losing messages. XACK fires only after `bulkRecordOrders` confirms. Exponential backoff: 500 ms initial, 30 s cap.
- `index.ts` — standalone entrypoint; connects Redis + MongoDB, starts worker, handles SIGTERM/SIGINT with ordered teardown (worker stop → disconnectMongo → redis.close).

**Deployment modes** (controlled by `WORKER_COLOCATED` env var):
- `false` (default for Docker) — worker runs as a separate `worker` container (Compose profile `worker`). Recommended for production: independent restart and scaling.
- `true` — worker runs inside the API process. Convenient for single-container deploys.

`make build` always builds both images. `make deploy` / `make up` activate the worker profile automatically unless `WORKER_COLOCATED=true`.

### Server source organization

- `bootstrap.ts` — composition root used by both production and tests via `BootstrapOverrides`
- `routes/` — HTTP translation only; no business logic
- `services/` — framework-free business logic with injected `clock` (enables time-travel in tests)
- `adapters/redis/` — Redis client, stock/orders/events helpers, reconcile, migrate, the Lua script, and `order-queue.ts` (stream producer/consumer)
- `adapters/mongo/` — client, models, seed, audit writer, and `bulk-audit.ts` (idempotent bulk writer for the worker)
- `worker/` — write-behind consumer worker and its standalone entrypoint
- `middleware/sale-resolver.ts` — slug → `SaleSummary` with a 60s in-memory TTL cache

### Client source organization

- `hooks/useSaleStatus.ts` — SSE primary + poll fallback + watchdog + not-found detection
- `hooks/useOrder.ts` — Buy Now flow state machine (phase, verdict, field error)
- `api/` — typed wire clients for sale and order endpoints

## Key invariants

**No bundler for the server.** `node src/index.ts` runs TypeScript directly via Node 24 native type stripping. `erasableSyntaxOnly: true` in `server/tsconfig.json` enforces this — do not use `enum`, `namespace`, or any TS feature with runtime semantics. Use `const` object maps instead of enums.

**Tests use real `bootstrap()`.** Tests never re-implement the boot sequence. `BootstrapOverrides` injects fakes at the adapter boundary (`fake-redis.ts`, `fake-mongo`), but full composition runs. The fake-redis contains a faithful JS port of the Lua script; `order-script.test.ts` pins them together.

**Write-behind is transparent to most tests.** By default `bootstrap()` wires the queue producer as `OrderAuditPort`. Tests that need immediate MongoDB writes (audit/cold-restart tests) pass `createOrderAudit: (productId) => createOrderRecorder(productId, mongo.ops.audit)` in `BootstrapOverrides` to bypass the queue. See `order-audit-restart.test.ts` (`directAudit: true`).

**Fail-closed on Redis loss.** The app rejects orders (503) rather than falling back to a non-atomic path. This is intentional — check `services/order.ts` before changing any error-handling around Redis failures.

**saleId drives key namespacing.** When refactoring Redis keys or adding new ones, the pattern `{noun}:{saleId}:{descriptor}` must be maintained consistently across `adapters/redis/`, the Lua script, and tests.

## Environment

Copy `.env.example` to `.env` for local dev. Key variables: `SALE_START_TIME`, `SALE_END_TIME`, `STOCK_QUANTITY`, `REDIS_URL`, `MONGODB_URI`, `PORT`, `WORKER_COLOCATED`. The stress harness uses `.env.stress` separately.

The worker entrypoint (`src/worker/index.ts`) only requires `REDIS_URL` and `MONGODB_URI` — it calls `loadWorkerConfig()`, not `loadConfig()`, so sale-window env vars are not needed for the worker process.

Docker Compose (`docker-compose.yml`) runs: `api`, `worker` (profile `worker`), `redis:8-alpine` (AOF persistence), `mongo:8`, `client` (nginx).
