# Flash Sale System

Express API (Redis concurrency core, MongoDB audit) + React SPA. See
`_bmad-output/planning-artifacts/architecture/` for the architecture spine.
The full README deliverable (Mermaid diagram, design rationale, stress-test
instructions) lands in Story 3.2.

## Layout

npm-workspaces monorepo:

```
server/   Express 5 + TypeScript (Node 24 native type stripping)
          src/{index,bootstrap,app}.ts · routes/ · services/ · adapters/{redis/,mongo/,payment/,config.ts} · test/
client/   React 19 + Vite SPA — built into the api image, served at /
stress/   k6 + verifier + reset harness (lands in Story 3.1)
docker-compose.yml   api + redis:8-alpine (AOF) + mongo:8 — the one-command stack
Dockerfile           multi-stage api image (client build -> node:24-alpine)
```

## Run it

```
docker compose up      # one command: healthchecked stores, then the api on :3000
```

Sale configuration is env-var only (defaults in `docker-compose.yml` / `.env.example`):
`SALE_START_TIME`, `SALE_END_TIME` (required, ISO 8601, parsed to UTC at boot),
`STOCK_QUANTITY` (default 100), `REDIS_URL`, `MONGODB_URI`, `PORT` (default 3000).
Invalid or missing required config fails the boot before the server listens.

## Develop

```
npm install                      # all workspaces
docker compose up -d redis mongo # stores only
cp .env.example .env             # adjust the sale window as needed
npm run dev                      # server :3000 + Vite client :5173 (/api proxied)
npm test                         # vitest across workspaces
npm run typecheck                # tsc --noEmit gate (strict, erasable-syntax only)
```
