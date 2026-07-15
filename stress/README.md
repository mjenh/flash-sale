# Flash Sale — Stress Harness

The end-to-end fairness proof for the flash sale system. It drives a large concurrent burst against a live API and verifies that the correctness guarantees hold: no oversell, exactly one order per buyer, and zero acceptance once the sale window is closed. It is one workspace inside an npm-workspaces monorepo — see the [root README](../README.md) for the full system overview.

## Project description

The stress harness is an **independent observer** of the deployed system. It shares no code with `server/` or `client/` — this is deliberate. The harness connects directly to Redis and MongoDB to read ground truth, and it connects to the API as a buyer would, over HTTP. This separation means the harness can catch bugs that would be hidden if it reused the server's own abstractions.

### What it tests

The harness runs a fixed scenario: **N unique buyers** firing concurrently at **S units of stock**, where N >> S. The default is 5,000 buyers against 100 units.

The full run sequence is:

1. **Stop** the API container (ensures a clean restart and guarantees the write-behind worker has drained the stream).
2. **Reset** the stores — wipes `stock:{saleId}:remaining`, `orders:{saleId}:users`, and the `queue:orders` stream from Redis, and drops the per-order MongoDB collections (`users`, `orders`, `orderlines`). Leaves `products`, `sales`, `saleproducts`, and `inventories` intact.
3. **Start** the API container and wait for it to pass its health check.
4. **k6 burst** — fires all N buyers concurrently. k6 enforces that every response is `202` (accepted) or `409` (rejected), with zero `5xx`. Exactly `STOCK_QUANTITY` responses must be `202`.
5. **Verify** — polls Redis and MongoDB until they converge, then asserts: `SCARD orders:{saleId}:users == STOCK_QUANTITY`, `stock:{saleId}:remaining == 0`, and MongoDB order count >= Redis order count (under-count is tolerated; over-count hard-fails).
6. **Window phase** — re-fires all N buyers after the sale window closes and asserts every response is `409`.

A passing run exits with code 0 and prints a phase-by-phase summary.

## Tech stack

| Concern | Technology |
|---------|-----------|
| Runtime | Node.js 24 — native TypeScript type stripping |
| Language | TypeScript 6 |
| Load generation | [k6](https://k6.io) (run from `PATH` or pulled as `grafana/k6:2.1.0` via Docker if not installed) |
| Store clients | `redis` 6 (direct Redis connection for reset and verify steps) · `mongoose` 9 (direct MongoDB connection for verify step) |
| Orchestration | `run.ts` — a plain Node.js script that shells out to Docker Compose and k6 |
| Testing | Vitest |

The harness intentionally avoids importing any code from `server/`. It speaks to the stores directly using the same client libraries but none of the server's adapter code.

## Prerequisites

- **Node.js 24+** — the harness runs TypeScript directly via Node's native type stripping.
- **Docker and Docker Compose** — required to start, stop, and reset the API and infrastructure containers. The harness calls `docker compose` to control the stack.
- **k6** (optional) — if `k6` is on your `PATH`, the harness uses it directly. Otherwise it pulls and runs `grafana/k6:2.1.0` via Docker automatically.
- **A seeded database** — the stress harness seeds the database with `--dynamic-times` (sale window = now to now+2 h) so the window never drifts out of range between runs. The seeder is called automatically by `make stress`.
- **Redis 8 and MongoDB 8** — started by the harness as part of `make stress`. They do not need to be running beforehand.

## Configuration

The harness reads from `.env.stress` (repo root). The root `.env` is **not** read during a stress run — this keeps the stress database isolated from the development database.

Copy or edit `.env.stress` to change the scenario parameters:

```bash
# .env.stress (repo root)
STOCK_QUANTITY=100    # units on sale
ATTEMPTS=5000         # unique buyers (emails) fired by k6
VUS=500               # k6 virtual users for the burst (must be <= ATTEMPTS)
```

All variables are validated by `config.ts` at startup. `VUS` must not exceed `ATTEMPTS`.

### Full variable reference

| Variable | Default | Description |
|----------|---------|-------------|
| `STOCK_QUANTITY` | `100` | Units on sale. Must match the value seeded into MongoDB and loaded by the API. The harness seeds MongoDB with this value automatically via `seed-db.ts`. |
| `ATTEMPTS` | `5000` | Number of unique buyer emails k6 fires. Each email is used exactly once. |
| `VUS` | `500` | k6 virtual users for the concurrent burst. Must be ≤ `ATTEMPTS`. Controls concurrency, not the total order count. |
| `API_URL` | `http://localhost:3000` | Base URL of the API under test. |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL (used by reset and verify steps). |
| `MONGODB_URI` | `mongodb://localhost:27017/flash-sale-stress` | MongoDB connection URI (used by verify step). The stress harness uses an isolated database (`flash-sale-stress`) so it never touches the dev/prod data. |
| `RETRY` | `false` | Set to `1` or `true` to enable the optional retry scenario. When enabled, `200` (idempotent re-order) is added to the set of allowed response statuses. |
| `VERIFY_MAX_SAMPLES` | `30` | Maximum polling attempts before the verifier gives up waiting for MongoDB to converge. |
| `VERIFY_INTERVAL_MS` | `1000` | Interval between verifier polling attempts in ms. |
| `SALE_SLUG` | `flash-sale` | The slug of the active sale. Must match the slug seeded into MongoDB. |

Inline overrides work as expected:

```bash
STOCK_QUANTITY=200 ATTEMPTS=10000 make stress
```

## Running the harness

### Via Make (recommended)

```bash
make stress
```

This single target does everything: starts Redis and MongoDB if not running, seeds the stress database with a dynamic sale window, starts the worker container, and then runs the full harness sequence.

### Via npm

```bash
npm run stress        # equivalent to: node run.ts (reads .env.stress)
```

You are responsible for ensuring the Docker stack (Redis, MongoDB, API) is up and the database is seeded before running this form directly.

### Individual steps

```bash
npm run reset -w stress    # wipe Redis + MongoDB order state (offline — API must be stopped first)
npm run verify -w stress   # run only the verifier step against a live stack
```

## Expected output

A passing run prints a phase-by-phase summary and exits 0:

```
PASS  stop API
PASS  reset
PASS  start API
PASS  k6 thresholds
PASS  verifier
PASS  window phase

PASS — the fairness claim holds.
```

k6 enforces:
- Zero `5xx` responses.
- All responses are `202`, `409`, or `200` (the last only when `RETRY=1`).
- Exactly `STOCK_QUANTITY` accepted orders (`202`).

The verifier then confirms:
- `SCARD orders:{saleId}:users == STOCK_QUANTITY` (Redis set membership is the authoritative fairness count).
- `stock:{saleId}:remaining == 0`.
- MongoDB order count >= Redis order count (the async write-behind may leave a brief under-count; a hard over-count fails the run).

The window phase confirms all buyers are rejected `409` once the sale window is closed.

## Isolated database

The stress harness uses a separate MongoDB database (`flash-sale-stress`, set by `.env.stress` and enforced in `docker-compose.stress.yml`) so a stress run never touches the `flash-sale` development or production database. The `docker-compose.stress.yml` overlay redirects both the `api` and `worker` containers to this database during the run.

## Testing the harness itself

```bash
npm run test -w stress          # vitest run
npm run test:watch -w stress    # vitest watch mode
```

## Source layout

```
stress/
  run.ts          orchestrator: stop → reset → start → k6 → verify → window
  reset.ts        offline store wipe (guarded — API must be stopped first)
  k6-order.js     k6 script: concurrent buyer burst
  verify.ts       post-burst equality checks against Redis + MongoDB
  config.ts       env parsing and validation (fail-fast, independent of server config)
  report.ts       formats and writes the run summary
  test/           harness unit tests (Vitest)
  tsconfig.json
  package.json
```