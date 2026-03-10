# Makefile — Developer shortcuts
.DEFAULT_GOAL := help
.PHONY: help build run test lint fmt proto clean docker-build docker-push

APP       := testproject
VERSION   ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
BUILD_DIR := ./bin

# ── Help ──────────────────────────────────────────────────────────────────────
help:
	@grep -E '^[a-zA-Z_-]+:.*?##' $(MAKEFILE_LIST) | \
	  awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-18s\033[0m %s\n",$$1,$$2}'

# ── Go ────────────────────────────────────────────────────────────────────────
build: ## Build the Go binary
	go build -ldflags="-X main.Version=$(VERSION)" -o $(BUILD_DIR)/$(APP) ./cmd/server

run: ## Run locally with hot-reload (requires air)
	air -c .air.toml

test: ## Run all tests
	go test ./... -race -count=1 -timeout 120s

test-short: ## Run tests excluding integration
	go test ./... -short -race -timeout 30s

coverage: ## Generate HTML coverage report
	go test ./... -coverprofile=coverage.out
	go tool cover -html=coverage.out -o coverage.html
	@echo "Coverage report: coverage.html"

lint: ## Run golangci-lint
	golangci-lint run ./...

fmt: ## Format all Go code
	gofmt -w .
	goimports -w .

vet: ## Run go vet
	go vet ./...

# ── Python ────────────────────────────────────────────────────────────────────
py-lint: ## Lint Python code with ruff
	ruff check src/

py-fmt: ## Format Python code
	black src/ scripts/
	isort src/ scripts/

py-test: ## Run Python tests
	pytest tests/ -v --tb=short

# ── Protobuf ──────────────────────────────────────────────────────────────────
proto: ## Generate gRPC stubs from .proto files
	buf generate

proto-lint: ## Lint proto files
	buf lint

# ── Docker ────────────────────────────────────────────────────────────────────
docker-build: ## Build Docker image
	docker build --build-arg VERSION=$(VERSION) -t $(APP):$(VERSION) .

docker-push: ## Push Docker image to registry
	docker tag $(APP):$(VERSION) $(REGISTRY)/$(APP):$(VERSION)
	docker push $(REGISTRY)/$(APP):$(VERSION)

# ── DB ────────────────────────────────────────────────────────────────────────
db-migrate: ## Run database migrations
	ruby scripts/migrate.rb --env $(ENV)

db-rollback: ## Roll back last migration
	ruby scripts/migrate.rb --env $(ENV) --rollback

db-seed: ## Seed development database
	psql $$DATABASE_URL < database/seeds.sql

# ── Misc ──────────────────────────────────────────────────────────────────────
clean: ## Remove build artifacts
	rm -rf $(BUILD_DIR) coverage.out coverage.html

deps: ## Install all dev dependencies
	go mod tidy
	pip install -r requirements-dev.txt
	npm ci --prefix frontend
