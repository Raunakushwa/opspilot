# OpsPilot developer commands. `make setup` then `make dev` is the full path
# from a fresh clone to a running stack.
SHELL := /bin/bash
COMPOSE := docker compose

.DEFAULT_GOAL := help
.PHONY: help setup dev up down logs ps build lint typecheck test test-integration format migrate db-reset clean

help: ## List available targets
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[1m%-18s\033[0m %s\n", $$1, $$2}'

setup: ## Install dependencies and create .env from the template
	@test -f .env || (cp .env.example .env && echo "created .env from .env.example - review the passwords")
	pnpm install
	cd apps/ai-service && uv sync

dev: ## Start the whole stack in the background and follow the logs
	$(COMPOSE) up --build -d
	$(COMPOSE) logs -f api worker ai-service web

up: ## Start the stack in the background
	$(COMPOSE) up --build -d

down: ## Stop the stack (volumes are kept)
	$(COMPOSE) down

ps: ## Show service status
	$(COMPOSE) ps

logs: ## Follow logs for all services
	$(COMPOSE) logs -f

seed: ## Load the demo organization (idempotent)
	$(COMPOSE) run --rm -e SEED_DEMO=true migrate

migrate: ## Run database migrations and provision the application role
	$(COMPOSE) run --rm migrate

db-reset: ## Destroy the database volume and re-run migrations (DESTRUCTIVE)
	$(COMPOSE) rm -sf postgres
	docker volume rm -f opspilot_postgres-data
	$(COMPOSE) up -d postgres
	$(COMPOSE) run --rm migrate

build: ## Build every package
	pnpm build

lint: ## Lint every package (TypeScript and Python)
	pnpm lint

typecheck: ## Type-check every package
	pnpm typecheck

test: ## Run unit tests
	pnpm test

test-integration: ## Run integration tests (requires Docker)
	pnpm test:integration

format: ## Format the repository
	pnpm format && cd apps/ai-service && uv run ruff format .

clean: ## Remove build output and caches
	rm -rf {apps,packages}/*/{dist,.next,.turbo,coverage} .turbo
