# Hoosland 主页与 Insight 静态内容分离行动方案

## 1. 目标

将 `hoosland.com` 主页和 `ins.hoosland.com` 的静态内容迁出画布生产源码目录 `/opt/infinite-canvas`，避免画布版本发布或源码同步覆盖两个站点。

## 2. 当前状态

- 主页容器 `infinite-canvas-landing-1` 只读挂载 `/opt/infinite-canvas/hoosland`。
- Insight 容器 `infinite-canvas-ins-1` 只读挂载 `/opt/infinite-canvas/hoosland-ins`。
- 两个目录属于画布 Git 发布树，发布包展开时可能覆盖服务器上的独立修改。
- 网关仍通过 Compose 服务名 `landing` 和 `ins` 转发，迁移不需要改变域名路由。

## 3. 目标结构

| 域名 | 生产目录 | 容器挂载点 |
| --- | --- | --- |
| `hoosland.com` | `/opt/hoosland-home` | `/usr/share/nginx/html:ro` |
| `ins.hoosland.com` | `/opt/insight` | `/usr/share/nginx/html:ro` |

`docker-compose.deploy.yml` 使用上述绝对路径。画布代码发布仅更新 `/opt/infinite-canvas`，不再改写两个静态站点的生产内容。

## 4. 执行步骤

1. 记录旧目录、容器挂载、公网响应和关键文件 SHA-256。
2. 在 `/opt/infinite-canvas/backups` 建立本次迁移备份，保存旧 Compose 文件与两个静态目录归档。
3. 创建 `/opt/hoosland-home` 和 `/opt/insight`，从旧目录保属性复制全部内容。
4. 用文件清单和 SHA-256 比较新旧目录，确认复制无差异。
5. 将本地 `docker-compose.deploy.yml` 的 `landing` 和 `ins` 挂载改为绝对路径，通过 Compose 配置校验后提交到 GitHub。
6. 将已提交的 Compose 文件同步到服务器，重建 `landing` 和 `ins` 两个容器；不重建 `app`、`backend` 和 `gateway`。
7. 校验容器新挂载、健康状态、容器内文件哈希、主页入口文案、Insight 页面及关键子路径。
8. 保留 `/opt/infinite-canvas/hoosland` 和 `/opt/infinite-canvas/hoosland-ins` 作为源码树中的参考副本，生产容器不再读取它们。

## 5. 验收标准

- `docker inspect` 显示 `landing` 来源为 `/opt/hoosland-home`、`ins` 来源为 `/opt/insight`。
- 两个容器健康，其他画布容器的容器 ID 和启动时间不变。
- `http://hoosland.com/` 返回 HTTP 200，并显示既定四个入口文案。
- `http://ins.hoosland.com/` 返回 HTTP 200，已有页面和静态资源可访问。
- 本地 `main`、GitHub `main` 与服务器 Compose 文件的相关内容一致。

## 6. 回滚方案

1. 从本次备份恢复旧 `docker-compose.deploy.yml`。
2. 仅重建 `landing` 和 `ins` 容器，使挂载重新指向 `/opt/infinite-canvas/hoosland` 和 `/opt/infinite-canvas/hoosland-ins`。
3. 重新执行容器、哈希和公网验证。

## 7. 边界

- 不修改 Nginx 域名路由。
- 不修改账号、画布、媒体、数据库和 `.env.deploy`。
- 不删除旧静态目录或历史备份。
