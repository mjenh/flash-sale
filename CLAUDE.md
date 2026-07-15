# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
npm run dev              # concurrent server (:3000) + Vite client (:5173)
npm test                 # vitest run across all workspaces
npm run typecheck        # tsc --noEmit in server + client

# Per-workspace
npm run dev -w server
npm run test -w server
npm run test:watch -w server
npm run dev -w client
npm run test -w client

# Single test file
npx vitest run server/test/order-service.test.ts
npx vitest run server/test/order-service.test.ts -t "test name pattern"

# Docker stack
make build               # docker compose build
make deploy              # build + start full stack (api + Redis + MongoDB)
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

**MongoDB (audit layer):** Written asynchronously *after* the Redis decision. Never read on the request path — only at cold-start to rebuild Redis state. `bootstrap.ts` performs reconcile (warm vs. cold start) before the server accepts requests.

**SSE broadcaster:** Redis pub/sub on `sale:{saleId}:events` carries type-only events. The client SSE hook falls back to polling if the stream drops, with a watchdog for stale connections.

### Server source organization

- `bootstrap.ts` — composition root used by both production and tests via `BootstrapOverrides`
- `routes/` — HTTP translation only; no business logic
- `services/` — framework-free business logic with injected `clock` (enables time-travel in tests)
- `adapters/redis/` — Redis client, stock/orders/events helpers, reconcile, migrate, and the Lua script
- `adapters/mongo/` — client, models, seed, and audit writer
- `middleware/sale-resolver.ts` — slug → `SaleSummary` with a 60s in-memory TTL cache

### Client source organization

- `hooks/useSaleStatus.ts` — SSE primary + poll fallback + watchdog + not-found detection
- `hooks/useOrder.ts` — Buy Now flow state machine (phase, verdict, field error)
- `api/` — typed wire clients for sale and order endpoints

## Key invariants

**No bundler for the server.** `node src/index.ts` runs TypeScript directly via Node 24 native type stripping. `erasableSyntaxOnly: true` in `server/tsconfig.json` enforces this — do not use `enum`, `namespace`, or any TS feature with runtime semantics. Use `const` object maps instead of enums.

**Tests use real `bootstrap()`.** Tests never re-implement the boot sequence. `BootstrapOverrides` injects fakes at the adapter boundary (`fake-redis.ts`, `fake-mongo`), but full composition runs. The fake-redis contains a faithful JS port of the Lua script; `order-script.test.ts` pins them together.

**Fail-closed on Redis loss.** The app rejects orders (503) rather than falling back to a non-atomic path. This is intentional — check `services/order.ts` before changing any error-handling around Redis failures.

**saleId drives key namespacing.** When refactoring Redis keys or adding new ones, the pattern `{noun}:{saleId}:{descriptor}` must be maintained consistently across `adapters/redis/`, the Lua script, and tests.

## Environment

Copy `.env.example` to `.env` for local dev. Key variables: `SALE_START_TIME`, `SALE_END_TIME`, `STOCK_QUANTITY`, `REDIS_URL`, `MONGODB_URI`, `PORT`. The stress harness uses `.env.stress` separately.

Docker Compose (`docker-compose.yml`) runs all three services: `api`, `redis:8-alpine` (AOF persistence), `mongo:8`.
