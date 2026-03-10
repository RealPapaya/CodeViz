FROM golang:1.22-alpine AS builder

WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-w -s -X main.Version=${VERSION:-dev} -X main.BuildDate=${BUILD_DATE}" \
    -o /app/server ./cmd/server

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM gcr.io/distroless/static-debian12

COPY --from=builder /app/server /server
COPY config/ /config/

EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/server"]
CMD ["--config", "/config/app.yaml"]
