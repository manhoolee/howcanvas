#!/usr/bin/env bash
set -Eeuo pipefail

# Emergency recovery for the server-only Visual Workbench route.  This does
# not rebuild the Canvas Agent, backend, ins, or landing services.
root_dir="${HOWCANVAS_DEPLOY_DIR:-/opt/infinite-canvas}"
compose_file="${HOWCANVAS_COMPOSE_FILE:-docker-compose.deploy.yml}"
source_url="${VISUAL_WORKBENCH_NGINX_URL:-https://raw.githubusercontent.com/manhoolee/howcanvas/e742829520777e44af6b01f8ffe63c36147f20c7/nginx.deploy.conf}"

cd "$root_dir"
timestamp="$(date -u +%Y%m%d-%H%M%S)"
backup_dir="$root_dir/backups/restore-visual-workbench-$timestamp"
mkdir -p "$backup_dir"
cp -a nginx.deploy.conf "$backup_dir/nginx.deploy.conf"

tmp_file="$(mktemp)"
new_config="$root_dir/nginx.deploy.conf.new"
cleanup() {
    rm -f "$tmp_file" "$new_config"
}
trap cleanup EXIT

echo "备份网关配置：$backup_dir/nginx.deploy.conf"
curl --fail --silent --show-error --location "$source_url" -o "$tmp_file"

for marker in \
    "visual_workbench_message_rate_key" \
    "location /tools/visual-workbench/" \
    "172.19.0.1:13092/"; do
    grep --fixed-strings --quiet "$marker" "$tmp_file" || {
        echo "缺少网关标记：$marker" >&2
        exit 1
    }
done

cp --preserve=mode,ownership,timestamps "$tmp_file" "$new_config"
mv -f "$new_config" nginx.deploy.conf

restore_config() {
    echo "恢复网关配置：$backup_dir/nginx.deploy.conf" >&2
    cp -a "$backup_dir/nginx.deploy.conf" nginx.deploy.conf
    docker compose -f "$compose_file" up -d --force-recreate gateway >/dev/null || true
}

if ! docker compose -f "$compose_file" config --quiet; then
    restore_config
    exit 1
fi

if ! docker compose -f "$compose_file" exec -T gateway nginx -t; then
    restore_config
    exit 1
fi

docker compose -f "$compose_file" up -d --force-recreate gateway

echo "验证视觉工作台入口"
curl --fail --silent --show-error --max-time 20 -I http://ins.hoosland.com/tools/visual-workbench
curl --fail --silent --show-error --max-time 20 http://ins.hoosland.com/tools/visual-workbench/ >/dev/null
curl --fail --silent --show-error --max-time 20 http://ins.hoosland.com/tools/visual-workbench/api/health/ready
curl --fail --silent --show-error --max-time 20 http://can.hoosland.com/api/health

echo "视觉工作台路由恢复完成"
