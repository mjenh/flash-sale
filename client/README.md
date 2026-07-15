# Flash Sale — Client

The React 19 SPA that serves as the buyer-facing storefront for the flash sale. It is one workspace inside an npm-workspaces monorepo — see the [root README](../README.md) for the full system overview.

## Project description

The client is a single-page application that shows the current state of the flash sale and lets buyers place orders. It connects to the API over a standard HTTP/JSON interface and subscribes to real-time sale events via Server-Sent Events (SSE), with automatic fallback to polling if the SSE stream drops.

In development the Vite dev server proxies `/api` requests to the Express API running on `:3000`, so no CORS configuration is needed. In production the app is compiled to static assets and served by an nginx container that handles the same proxy.

## Tech stack

| Concern | Technology |
|---------|-----------|
| UI library | React 19 |
| Language | TypeScript 6 |
| Build tool | Vite 8 |
| Routing | React Router v7 |
| Real-time | Server-Sent Events with polling fallback and stale-connection watchdog |
| Testing | Vitest + React Testing Library + jsdom |
| Linting | Biome |
| Production serving | nginx (static assets + `/api` reverse proxy) |

## Prerequisites

- **Node.js 24+** — required by the workspace. The client uses `node --env-file-if-exists` syntax and the workspace engine field pins `>=24`.
- **A running API server** — the client proxies all `/api` requests to `http://localhost:3000` in development. Start the server first (see the [server README](../server/README.md) or the root development workflow).

For a full local stack including Redis and MongoDB:

```bash
# From the repo root
docker compose up -d redis mongo
npm run seed
npm run dev          # starts server + worker + Vite client together
```

## Configuration

The client's only runtime configuration is the API base URL, which Vite injects at build time as an environment variable.

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_URL` | `http://localhost:3000` | Base URL of the API server. Used when building for environments where the Vite dev proxy or the nginx proxy is not present. In development and in the Docker Compose stack this is handled by the proxy and does not need to be set explicitly. |
| `VITE_PORT` | `5173` | Port the Vite dev server listens on. |

These variables are not read by the API server — they are only relevant to the client.

Copy `.env.example` (repo root) to `.env` to configure them for local development:

```bash
cp .env.example .env
```

In the Docker Compose production stack, nginx proxies `/api` to the API container directly — `VITE_API_URL` is baked in at image build time and should point to the relative path or the nginx-resolved upstream.

## Running locally

### Development mode

The simplest approach is to start everything from the repo root:

```bash
# From the repo root
npm install
npm run dev          # server :3000 + worker + Vite client :5173
```

To start only the client dev server (when the API is already running separately):

```bash
npm run dev -w client
```

Open [http://localhost:5173](http://localhost:5173). The Vite dev server is configured to proxy `/api` to `http://localhost:3000` so requests reach the local API without CORS issues.

### Production build

```bash
npm run build -w client   # type-checks then produces dist/
npm run preview -w client # serves the dist/ output locally for inspection
```

The Docker production workflow (from the repo root) builds the client into the nginx image automatically:

```bash
make deploy    # builds Dockerfile.client (Vite build → nginx) and starts the full stack
```

The compiled SPA is served at [http://localhost](http://localhost) (port 80). nginx handles both static asset serving and the `/api` reverse proxy to the API container.

## Testing

```bash
npm run test -w client          # vitest run (all client tests, jsdom environment)
npm run test:watch -w client    # vitest watch mode
```

Tests use React Testing Library with a jsdom environment. The test setup is in `src/test/`.

## Code quality gates

```bash
npm run lint -w client         # biome check src/
npm run typecheck -w client    # tsc --noEmit (strict)
```

Run lint before committing — Biome violations block CI. TypeScript is configured in strict mode.

## Source layout

```
src/
  main.tsx          application entry point
  router.tsx        React Router: / → redirect to /sale/:slug · /sale/:slug · * → 404
  router.test.tsx   route-level tests
  api/
    sale.ts         typed wire client for sale endpoints (slug-parameterized)
    order.ts        typed wire client for order submission
  components/       presentational UI components
  hooks/
    useSaleStatus.ts  SSE primary + poll fallback + stale-connection watchdog + not-found detection
    useOrder.ts       Buy Now flow state machine (phase, verdict, field errors)
  pages/            page-level components wired to the router
  styles/           global CSS
  utils/            shared utilities
  test/             test setup and helpers
index.html          Vite entry HTML
vite.config.ts      dev proxy (/api → localhost:3000), React plugin, Vitest config
nginx.conf          production: static serving + /api reverse proxy to the API container
tsconfig.json       TypeScript config (strict mode)
```

## Real-time behaviour

`useSaleStatus` implements a three-level resilience ladder for live sale state:

1. **SSE** — the primary channel. Connects to `GET /api/sales/:slug/events` and receives `order.accepted`, `sale.sold_out`, `sale.started`, and `sale.ended` events.
2. **Poll fallback** — if the SSE stream drops or cannot be established, the hook falls back to polling the status endpoint on a fixed interval.
3. **Stale-connection watchdog** — a timer that detects a connected-but-silent SSE stream (missed heartbeats) and forces a reconnect.

This means the UI remains accurate even if the SSE connection is interrupted by a network blip, a load balancer timeout, or a server restart.