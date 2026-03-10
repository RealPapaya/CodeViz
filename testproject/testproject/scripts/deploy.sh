#!/usr/bin/env bash
# scripts/deploy.sh — CI/CD deployment script
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
APP_NAME="${APP_NAME:-testproject}"
REGISTRY="${REGISTRY:-ghcr.io/myorg}"
DEPLOY_ENV="${DEPLOY_ENV:-staging}"
NAMESPACE="app-${DEPLOY_ENV}"
KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"
TIMEOUT="${DEPLOY_TIMEOUT:-300}"

IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD)}"
IMAGE="${REGISTRY}/${APP_NAME}:${IMAGE_TAG}"

log()   { echo "[$(date '+%H:%M:%S')] $*"; }
info()  { log "INFO  $*"; }
warn()  { log "WARN  $*" >&2; }
error() { log "ERROR $*" >&2; exit 1; }

# ── Preflight checks ─────────────────────────────────────────────────────────
check_dependencies() {
    local deps=(docker kubectl helm git)
    for dep in "${deps[@]}"; do
        command -v "$dep" &>/dev/null || error "Missing dependency: $dep"
    done
    info "All dependencies found."
}

check_kube_context() {
    local ctx
    ctx=$(kubectl config current-context)
    info "Kubernetes context: $ctx"
    if [[ "$ctx" == *"prod"* && "$DEPLOY_ENV" != "production" ]]; then
        warn "Context looks like production but DEPLOY_ENV=$DEPLOY_ENV"
        read -rp "Continue? [y/N] " yn
        [[ "$yn" =~ ^[Yy]$ ]] || error "Aborted."
    fi
}

# ── Docker ────────────────────────────────────────────────────────────────────
build_image() {
    info "Building image: $IMAGE"
    docker build \
        --build-arg BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --build-arg GIT_COMMIT="$IMAGE_TAG" \
        --tag "$IMAGE" \
        --file Dockerfile \
        .
    info "Build complete."
}

push_image() {
    info "Pushing $IMAGE..."
    docker push "$IMAGE"
    info "Push complete."
}

# ── Helm ──────────────────────────────────────────────────────────────────────
deploy_helm() {
    info "Deploying via Helm to namespace: $NAMESPACE"
    helm upgrade "$APP_NAME" ./charts/"$APP_NAME" \
        --install \
        --namespace "$NAMESPACE" \
        --create-namespace \
        --set image.tag="$IMAGE_TAG" \
        --set image.repository="${REGISTRY}/${APP_NAME}" \
        --set env="$DEPLOY_ENV" \
        --values "./charts/${APP_NAME}/values-${DEPLOY_ENV}.yaml" \
        --timeout "${TIMEOUT}s" \
        --wait \
        --atomic
    info "Helm deploy complete."
}

# ── Health check ─────────────────────────────────────────────────────────────
wait_for_rollout() {
    info "Waiting for rollout: deployment/${APP_NAME}"
    kubectl rollout status "deployment/${APP_NAME}" \
        --namespace "$NAMESPACE" \
        --timeout "${TIMEOUT}s"
    info "Rollout complete."
}

smoke_test() {
    local base_url
    base_url=$(kubectl get svc "$APP_NAME" -n "$NAMESPACE" \
        -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "localhost")

    info "Running smoke test against http://${base_url}/health ..."
    local status
    status=$(curl -sf -o /dev/null -w "%{http_code}" "http://${base_url}/health" || echo "000")
    if [[ "$status" == "200" ]]; then
        info "Smoke test passed (HTTP $status)."
    else
        error "Smoke test failed (HTTP $status)."
    fi
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
    info "=== Deploying $APP_NAME:$IMAGE_TAG to $DEPLOY_ENV ==="
    check_dependencies
    check_kube_context
    build_image
    push_image
    deploy_helm
    wait_for_rollout
    smoke_test
    info "=== Deployment complete ✓ ==="
}

main "$@"
