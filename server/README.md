# Flash Sale — Server

The Express 5 API that powers the flash sale. It decides who gets a unit, enqueues the result for durable persistence, and broadcasts real-time sale status to connected clients. It is one workspace inside an npm-workspaces monorepo — see the [root README](../README.md) for the full system overview.

## Project description

The server is the concurrency core of the flash sale. When a buyer submits an order, the server runs a single atomic Lua script against Redis that checks stock and per-buyer idempotency in one round-trip. If the order is accepted, the server enqueues it to a Redis Stream and returns HTTP 202 immediately — MongoDB is never on the hot path. A separate write-behind worker process drains that stream into MongoDB asynchronously.

Sale status (remaining stock, open/sold-out/ended) is broadcast over Server-Sent Events, with Redis pub/sub carrying the events between the API process and connected browser clients.

### Architecture at a glance

Three roles are strictly separated:

- **Redis** — the decision layer. `stock:{saleId}:remaining` and `orders:{saleId}:users` are the only keys read or written per request. The Lua script (`adapters/redis/order.lua`) is the sole writer while serving.
- **Redis Stream** (`queue:orders`) — the write-behind queue. The API enqueues accepted orders here; the worker drains them to MongoDB via XREADGROUP with at-least-once delivery and exponential backoff.
- **MongoDB** — the audit layer. Written only by the background worker. Read at cold start to rebuild Redis state (`bootstrap.ts` reconcile).

The full design, request flows, failure modes, and trade-off reasoning live in [`docs/architecture.md`](../docs/architecture.md).

## Tech stack

| Concern | Technology |
|---------|-----------|
| Runtime | Node.js 24 — native TypeScript type stripping, no build step, no bundler |
| Framework | Express 5 |
| Language | TypeScript 6 (`erasableSyntaxOnly: true` — no enums, no namespaces) |
| Decision store | Redis 8 with AOF persistence, driven by a single atomic Lua script |
| Write-behind queue | Redis Stream (`queue:orders`) + XREADGROUP consumer group |
| Audit store | MongoDB 8 via Mongoose 9 |
| Real-time | Server-Sent Events (SSE) over Redis pub/sub |
| Logging | pino + pino-http |
| Security headers | helmet |
| Testing | Vitest + Supertest |
| Linting | Biome |

## Prerequisites

- **Node.js 24+** — the server runs TypeScript directly via Node's native type stripping; no compilation or bundler is needed. Node 24 is the minimum required version.
- **Redis 8** — must be running and reachable before the server starts. AOF persistence is recommended (`--appendonly yes`).
- **MongoDB 8** — must be running and reachable. The server reads sale and product config from MongoDB at boot; the database must be seeded before the first start.

For local development the quickest way to get the stores up is:

```bash
docker compose up -d redis mongo   # from the repo root
```

## Configuration

All environment variables are parsed and validated once at boot by `src/adapters/config.ts`. An invalid or missing required value causes the process to exit before `listen()` is called.

Sale timing, stock quantity, and product pricing are **not** environment variables — they live in MongoDB and are provisioned by `db/scripts/seed-db.ts`. See [Seeding the database](#seeding-the-database) below.

Copy `.env.example` (repo root) to `.env` to configure local development:

```bash
cp .env.example .env
```

### API server (`AppConfig`)

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | `redis://localhost:6379` | Redis 8 connection URL. AOF must be enabled on the server. |
| `MONGODB_URI` | `mongodb://localhost:27017/flash-sale` | MongoDB 8 connection URI. Must point to the database seeded by `seed-db.ts`. |
| `PORT` | `3000` | TCP port the HTTP server listens on. |
| `REDIS_CONNECT_TIMEOUT_MS` | `2000` | Boot-time Redis connect timeout in ms. Increase for TLS/Atlas/cluster environments. |
| `REDIS_COMMAND_TIMEOUT_MS` | `1000` | Per-command Redis timeout in ms. A timeout is treated as unreachable and returns 503. |
| `REDIS_RECONNECT_MAX_MS` | `2000` | Reconnect backoff ceiling in ms. Raise if Redis failover takes longer than 2 s. |
| `MONGO_SELECTION_TIMEOUT_MS` | `5000` | MongoDB server-selection timeout in ms. Atlas replica-set elections can exceed 5 s. |
| `HTTP_BODY_LIMIT` | `8kb` | Express JSON body size limit. Increase if an upstream gateway pre-aggregates chunks. |
| `SALE_RESOLVER_CACHE_TTL_MS` | `60000` | In-memory TTL (ms, max 60 000) for the slug → sale cache. Lower in development for faster iteration. |
| `WORKER_COLOCATED` | `false` | Set to `true` to run the write-behind worker inside the API process (single-container deploys). Leave unset or `false` to run the worker as a separate process or container. |

### Write-behind worker (`WorkerConfig`)

The worker entrypoint (`src/worker/index.ts`) calls `loadWorkerConfig()`, not `loadConfig()`, so it only needs the variables below — sale-window and product variables are not required.

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | `redis://localhost:6379` | Same connection as the API. |
| `MONGODB_URI` | `mongodb://localhost:27017/flash-sale` | Same database as the API. |
| `REDIS_CONNECT_TIMEOUT_MS` | `2000` | Same semantics as the API. |
| `REDIS_COMMAND_TIMEOUT_MS` | `1000` | Same semantics as the API. |
| `REDIS_RECONNECT_MAX_MS` | `2000` | Same semantics as the API. |
| `WORKER_CONSUMER_ID` | `worker-<hostname>` | Unique XREADGROUP consumer name per replica. Each pod must use a distinct value so PEL re-delivery is scoped per-instance. |
| `WORKER_GROUP` | `workers` | Consumer group name shared by all workers draining the same stream. Override only when running independent consumer groups (e.g. analytics vs. audit). |

## Seeding the database

Sale and product data are not seeded automatically. Run the idempotent seeder once before the first server start:

```bash
# From the repo root
npm run seed           # uses $MONGODB_URI or defaults to localhost:27017
# or
make seed              # same, targeted at the local Docker Compose stack
```

The seeder provisions four collections from the JSON files in `db/data/`:

| File | Collection | Unique key |
|------|-----------|-----------|
| `products.json` | `products` | `sku` |
| `sales.json` | `sales` | `slug` |
| `saleproducts.json` | `saleproducts` | `saleSlug` + `productSku` |
| `inventories.json` | `inventories` | `productSku` |

The script is idempotent — re-running updates mutable fields. `inventories.initialQuantity` uses `$setOnInsert` and is never overwritten.

> **Important:** changing `stockQuantity` in `db/data/sales.json` while Redis already holds sale state is a warm-start no-op. Reset Redis state first (`docker compose down -v` or the stress harness reset step) so the next boot takes the cold path and rebuilds from MongoDB.

## Running locally

### Development mode (recommended)

Start the stores, seed the database, then start the server. From the **repo root**:

```bash
npm install
docker compose up -d redis mongo
npm run seed
npm run dev                    # runs both the API server and the write-behind worker concurrently
```

The dev script uses `node --watch` for hot-reload on file changes. The API server listens on `:3000`.

To run the API server and worker independently:

```bash
npm run dev -w server          # API server only (hot-reload)
npm run dev:worker -w server   # write-behind worker only (hot-reload)
```

### Production (Docker)

Use the Docker Compose stack from the repo root:

```bash
make deploy    # build images, seed MongoDB, start full stack
```

The worker runs as a separate container by default. Set `WORKER_COLOCATED=true` to run the worker inside the API process instead:

```bash
WORKER_COLOCATED=true make deploy
```

### Running standalone

If you want to start the server process directly (no `--watch`):

```bash
node src/index.ts              # API server
node src/worker/index.ts       # write-behind worker
```

## Testing

```bash
npm test                       # vitest run (all server tests)
npm run test:watch -w server   # vitest watch mode
npx vitest run server/test/order-service.test.ts   # single file
npx vitest run server/test/order-service.test.ts -t "pattern"   # single test
```

Tests use the real `bootstrap()` composition root with fake adapters injected at the store boundary (`fake-redis.ts`, `fake-mongo`). The fake Redis contains a faithful JavaScript port of the Lua script — `order-script.test.ts` pins them together.

## Code quality gates

```bash
npm run lint -w server         # biome check — run before committing
npm run typecheck -w server    # tsc --noEmit (strict, erasableSyntaxOnly)
```

Biome violations block CI. The `erasableSyntaxOnly` compiler flag enforces that no TypeScript with runtime semantics (enums, namespaces, parameter properties) is used — the code runs directly under Node 24's type stripper.

## Source layout

```
src/
  index.ts          boot entry: bootstrap() then listen(); honours WORKER_COLOCATED
  bootstrap.ts      single composition root shared with tests (BootstrapOverrides)
  app.ts            Express pipeline + central error middleware
  routes/           HTTP translation only — no business logic here
  services/         framework-free business logic with injected clock
  adapters/
    redis/          Redis client, stock/orders/events helpers, Lua script,
                    reconcile, migrate, order-queue.ts (stream producer/consumer)
    mongo/          Mongoose client, models, bulk-audit.ts (idempotent bulk writer)
    config.ts       env parsing and validation (fail-fast at boot)
  middleware/
    sale-resolver.ts  slug → SaleSummary with 60 s in-memory TTL cache
  worker/
    order-worker.ts   XREADGROUP polling loop, at-least-once, exponential backoff
    index.ts          standalone worker entrypoint
test/               unit and integration tests (Vitest + Supertest)
```

## Key invariants

- **No bundler.** `node src/index.ts` runs TypeScript directly. `erasableSyntaxOnly: true` is a hard constraint — do not add `enum`, `namespace`, or any TS feature with runtime semantics. Use `const` object maps instead of enums.
- **Fail closed on Redis loss.** Orders are rejected with 503 rather than falling back to a non-atomic path. Do not alter error-handling around Redis failures without reading `services/order.ts` first.
- **The Lua script is the sole writer of the two state keys** while the server is serving. `adapters/redis/order.lua`, `bootstrap.ts` (reconcile), and the stress harness reset are the only permitted writers.
- **`saleId` drives key namespacing.** All Redis keys follow `{noun}:{saleId}:{descriptor}`. Maintain this consistently across `adapters/redis/`, the Lua script, and tests.