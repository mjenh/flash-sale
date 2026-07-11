# Flash Sale System

Express API (Redis concurrency core, MongoDB audit) + React SPA. See
`_bmad-output/planning-artifacts/architecture/` for the architecture spine.

## Layout

```
backend/    Express 5 + TypeScript (Node 24 native type stripping), routes/services/adapters
frontend/   React 19 + Vite SPA, served by nginx in Docker (proxies /api to backend)
docker-compose.yml   frontend + backend + redis (AOF) + mongodb
Makefile    build / test / deploy targets
```

## Prerequisites

Node >= 24, Docker with the compose plugin.

## Commands

```
make install    # npm install in both services
make test       # run backend + frontend tests (vitest)
make build      # build both Docker images
make deploy     # build + start the full stack in local Docker
make down       # stop the stack
make logs       # tail service logs
make clean      # stop and remove volumes + images
```

After `make deploy`: frontend at http://localhost:8080, API health at
http://localhost:3000/api/health.

## Local dev (without Docker)

Run `docker compose up -d redis mongodb`, then `npm run dev` in `backend/`
(port 3000) and in `frontend/` (port 5173, proxies `/api` to 3000).
