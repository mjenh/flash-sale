.PHONY: install dev up-stores test typecheck build deploy up down restart logs ps stress clean

COMPOSE := docker compose

## ---- Local dev ----

install: ## npm install (all workspaces, single root lockfile)
	npm install

up-stores: ## start just redis + mongo for the local dev loop
	$(COMPOSE) up -d redis mongo

dev: ## concurrently: server :3000 + Vite client :5173 (/api proxied)
	npm run dev

## ---- Gates ----

test: ## vitest across all workspaces
	npm test

typecheck: ## tsc --noEmit in server and client
	npm run typecheck

## ---- Docker stack ----

build: ## build the api image
	$(COMPOSE) build

deploy: build ## build and start the full stack
	$(COMPOSE) up -d
	@echo "app + api: http://localhost:3000"

up: ## start the stack (no rebuild)
	$(COMPOSE) up -d

down: ## stop the stack
	$(COMPOSE) down

restart: down deploy

logs:
	$(COMPOSE) logs -f

ps:
	$(COMPOSE) ps

## ---- Validation ----

stress: ## 5000-vs-100 stress harness (lands in Story 3.1)
	npm run stress

clean: ## stop stack and remove volumes + images
	$(COMPOSE) down -v --rmi local
