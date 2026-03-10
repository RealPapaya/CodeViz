# TestProject

> A polyglot demo project for testing VIZCODE — contains intentionally varied file types, languages, import graphs, and function call chains.

## Tech Stack

| Layer       | Language / Tech            |
|-------------|----------------------------|
| Backend API | Go 1.22 + chi              |
| Worker      | Python 3.12 + asyncio      |
| Processor   | Rust 1.76 + tokio          |
| Frontend    | React 18 + TypeScript      |
| Database    | PostgreSQL 15              |
| Cache       | Redis 7                    |
| Infra       | Terraform + AWS            |
| Messaging   | gRPC + Protobuf            |

## Project Structure

```
testproject/
├── main.go                  # Go entry point
├── server/                  # HTTP server (Go)
├── worker/                  # Concurrent worker pool (Go)
├── src/
│   ├── core/                # Engine, scheduler, pipeline (Python)
│   ├── api/                 # REST handlers (Python)
│   ├── utils/               # Logger, cache, metrics (Python)
│   └── processor.rs         # Async job processor (Rust)
├── frontend/
│   ├── components/          # React components (TSX)
│   ├── api/                 # HTTP client (TypeScript)
│   ├── utils/               # Formatters (JavaScript)
│   └── styles/              # CSS modules
├── database/                # SQL schema + migrations
├── proto/                   # Protobuf definitions
├── shaders/                 # GLSL vertex + fragment shaders
├── infra/                   # Terraform (AWS VPC, RDS, Redis)
├── scripts/                 # Deploy (Bash), Migrate (Ruby)
├── tests/                   # pytest unit tests
└── config/                  # YAML configuration
```

## Quick Start

```bash
# Go server
make build && ./bin/testproject

# Python worker
python -m src.core.engine

# Frontend
npm ci --prefix frontend && npm run dev --prefix frontend

# Run all tests
make test && make py-test
```

## Architecture

```
Browser  →  Go HTTP Server  →  Job Queue  →  Python Engine
                |                               |
                ↓                               ↓
           gRPC Service            PostgreSQL + Redis
                |
                ↓
         Rust Processor
```

## Development

```bash
# Copy env template
cp .env.example .env

# Start services
docker-compose up -d

# Run migrations
make db-migrate ENV=development
```
