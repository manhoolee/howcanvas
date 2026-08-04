#!/usr/bin/env bash
set -euo pipefail
trap 'echo "DOCKER_SMOKE=FAIL line=${LINENO}" >&2' ERR

base_url="${HOWCANVAS_BASE_URL:-http://127.0.0.1:3000}"
compose_project="${COMPOSE_PROJECT_NAME:-howcanvas}"
admin_username="${ADMIN_USERNAME:-admin}"
admin_password="${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}"
smoke_username="smoke-$(date +%s)-${RANDOM}"
smoke_password="smoke-user-password"
cookie_file="$(mktemp)"
trap 'rm -f "$cookie_file"' EXIT

for attempt in $(seq 1 60); do
    if curl --fail --silent "${base_url}/api/health" >/dev/null; then
        break
    fi
    if [ "$attempt" -eq 60 ]; then
        docker compose -p "$compose_project" ps
        exit 1
    fi
    sleep 2
done

health="$(curl --fail --silent "${base_url}/api/health")"
[[ "$health" == *'"ok":true'* ]]
frontend="$(curl --fail --silent "${base_url}/")"
[[ "${frontend,,}" == *'<html'* ]]

admin="$(curl --fail --silent -c "$cookie_file" -H 'Content-Type: application/json' \
    -d "{\"username\":\"${admin_username}\",\"password\":\"${admin_password}\"}" \
    "${base_url}/api/auth/login")"
[[ "$admin" == *'"role":"admin"'* ]]

created="$(curl --fail --silent -b "$cookie_file" -H 'Content-Type: application/json' \
    -d "{\"username\":\"${smoke_username}\",\"password\":\"${smoke_password}\",\"displayName\":\"Smoke User\"}" \
    "${base_url}/api/admin/users")"
[[ "$created" == *"\"username\":\"${smoke_username}\""* ]]

docker compose -p "$compose_project" up -d --force-recreate backend >/dev/null
for attempt in $(seq 1 30); do
    if curl --fail --silent "${base_url}/api/health" >/dev/null; then
        break
    fi
    if [ "$attempt" -eq 30 ]; then
        exit 1
    fi
    sleep 2
done

persisted="$(curl --fail --silent -H 'Content-Type: application/json' \
    -d "{\"username\":\"${smoke_username}\",\"password\":\"${smoke_password}\"}" \
    "${base_url}/api/auth/login")"
[[ "$persisted" == *"\"username\":\"${smoke_username}\""* ]]

for attempt in $(seq 1 30); do
    healthy_services="$(docker compose -p "$compose_project" ps --format json | awk '/"Health":"healthy"/ {count++} END {print count + 0}')"
    if [ "$healthy_services" -eq 3 ]; then
        break
    fi
    if [ "$attempt" -eq 30 ]; then
        exit 1
    fi
    sleep 2
done

echo "DOCKER_SMOKE=PASS"
echo "health_endpoint=PASS"
echo "frontend_html=PASS"
echo "admin_login=PASS"
echo "persisted_user_after_backend_restart=PASS"
echo "healthy_services=${healthy_services}"
