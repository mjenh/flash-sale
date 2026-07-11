.PHONY: install build build-backend build-frontend test test-backend test-frontend \
        typecheck deploy up down restart logs ps clean

COMPOSE := docker compose

## ---- Local dev ----

install: ## npm install in both services
	cd backend && npm install
	cd frontend && npm install

typecheck: ## tsc --noEmit in both services
	cd backend && npm run typecheck
	cd frontend && npm run typecheck

## ---- Build ----

build: build-backend build-frontend ## build both Docker images

build-backend:
	$(COMPOSE) build backend

build-frontend:
	$(COMPOSE) build frontend

## ---- Test ----

test: test-backend test-frontend ## run all tests

test-backend:
	cd backend && npm test

test-frontend:
	cd frontend && npm test

## ---- Deploy (local Docker) ----

deploy: build ## build images and start the full stack
	$(COMPOSE) up -d
	@echo "frontend: http://localhost:8080  |  api: http://localhost:3000/api/health"

up: ## start the stack (no rebuild)
	$(COMPOSE) up -d

down: ## stop the stack
	$(COMPOSE) down

restart: down deploy

logs:
	$(COMPOSE) logs -f

ps:
	$(COMPOSE) ps

clean: ## stop stack and remove volumes + images
	$(COMPOSE) down -v --rmi local
