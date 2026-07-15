.PHONY: install dev up-stores seed test typecheck lint build deploy up down restart logs worker-logs ps stress clean

COMPOSE := docker compose

# When WORKER_COLOCATED=true the api process runs the worker internally, so the
# "worker" Compose profile must NOT be activated (that would double-consume the
# stream). In all other cases activate the profile so the standalone worker
# container starts alongside the api.
ifeq ($(WORKER_COLOCATED),true)
WORKER_PROFILE :=
else
WORKER_PROFILE := --profile worker
endif

## ---- Local dev ----

install: ## npm install (all workspaces, single root lockfile)
	npm install

up-stores: ## start just redis + mongo for the local dev loop
	$(COMPOSE) up -d redis mongo

seed: ## provision sale + product data in MongoDB (run once before first start)
	node db/scripts/seed-db.ts

dev: ## concurrently: server :3000 + worker + Vite client :5173 (/api proxied)
	npm run dev

## ---- Gates ----

test: ## vitest across all workspaces
	npm test

typecheck: ## tsc --noEmit in server and client
	npm run typecheck

lint: ## biome check across server + client
	npm run lint

## ---- Docker stack ----

build: ## build all images (api + worker); always includes worker profile so the image is current
	$(COMPOSE) --profile worker build

deploy: build ## build, seed MongoDB, and start the full stack
	$(COMPOSE) up -d --wait redis mongo
	@echo "  Seeding MongoDB…"
	MONGODB_URI=mongodb://127.0.0.1:27017/flash-sale node db/scripts/seed-db.ts
	$(COMPOSE) $(WORKER_PROFILE) up -d
	@echo "  app (nginx): http://localhost:80"
	@echo "  api (direct): http://localhost:3000"

up: ## start the stack without rebuilding (stores must already be seeded)
	$(COMPOSE) $(WORKER_PROFILE) up -d

down: ## stop the stack
	$(COMPOSE) $(WORKER_PROFILE) down

restart: down deploy

logs: ## tail logs for all running services
	$(COMPOSE) $(WORKER_PROFILE) logs -f

worker-logs: ## tail worker logs only
	$(COMPOSE) logs -f worker

ps:
	$(COMPOSE) $(WORKER_PROFILE) ps

## ---- Validation ----

stress: ## 5000-vs-100 fairness proof: stop api -> reset -> start api -> k6 -> verifier -> window check
	$(COMPOSE) up -d --wait redis mongo
	node db/scripts/seed-db.ts \
	  --mongoUri mongodb://127.0.0.1:27017/flash-sale-stress \
	  --dataDir db/data/stress \
	  --dynamic-times
	COMPOSE_FILE=docker-compose.yml:docker-compose.stress.yml \
	  $(COMPOSE) --profile worker up -d worker
	COMPOSE_FILE=docker-compose.yml:docker-compose.stress.yml npm run stress

clean: ## stop stack and remove volumes + images
	$(COMPOSE) --profile worker down -v --rmi local
