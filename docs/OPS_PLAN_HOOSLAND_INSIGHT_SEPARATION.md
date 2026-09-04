# Hoosland 主页与 Insight 产品树分离行动方案

## 1. 目标

将 `hoosland.com` 主页和 `ins.hoosland.com` 的完整产品树迁出画布生产源码目录 `/opt/infinite-canvas`，包括 Insight 静态站、课程站、两套地产工作台、视觉工作台、运行数据与服务配置。画布版本发布或源码同步不再覆盖主页、Insight 页面及其下级应用。

## 2. 当前状态

- 主页容器 `infinite-canvas-landing-1` 只读挂载 `/opt/infinite-canvas/hoosland`。
- Insight 容器 `infinite-canvas-ins-1` 只读挂载 `/opt/infinite-canvas/hoosland-ins`。
- 两个目录属于画布 Git 发布树，发布包展开时可能覆盖服务器上的独立修改。
- 课程页面与笔记服务运行在 `/opt/infinite-canvas/course`。
- 地产工作台 A、B 分别运行在 `/opt/real-estate-agent` 和 `/opt/real-estate-agent-2`。
- 视觉工作台运行在 `/opt/hoosland-visual-workbench`。
- 三套工作台的数据和密钥配置分散在 `/srv` 与 `/etc`的对应目录。
- 网关仍通过 Compose 服务名 `landing` 和 `ins` 转发，迁移不需要改变域名路由。

## 3. 目标结构

| 域名 | 生产目录 | 容器挂载点 |
| --- | --- | --- |
| `hoosland.com` | `/opt/hoosland-home` | `/usr/share/nginx/html:ro` |
| `ins.hoosland.com` | `/opt/insight/site` | `/usr/share/nginx/html:ro` |

Insight 产品树使用以下结构：

```text
/opt/insight/
├── site/
├── course/
├── apps/
│   ├── real-estate/
│   ├── real-estate-2/
│   └── visual-workbench/
├── data/
│   ├── real-estate/
│   ├── real-estate-2/
│   └── visual-workbench/
├── config/
│   ├── real-estate/
│   ├── real-estate-2/
│   └── visual-workbench/
└── ops/
```

`docker-compose.deploy.yml` 只将 `site/` 挂载给静态 Nginx，应用源码、数据和密钥配置不对公网静态暴露。

## 4. 执行步骤

1. 记录旧目录、容器挂载、公网响应和关键文件 SHA-256。
2. 在 `/opt/infinite-canvas/backups` 建立本次迁移备份，保存旧 Compose 文件与两个静态目录归档。
3. 创建 `/opt/hoosland-home` 和 `/opt/insight` 的分层目录，先在服务运行期间完成全量预复制。
4. 将 Insight 静态内容收入 `site/`，将课程内容收入 `course/`，将三套工作台收入 `apps/`。
5. 将三套工作台的持久数据和配置分别收入 `data/` 和 `config/`；全程保留原有所有者、权限与密钥不可读边界。
6. 用文件清单和 SHA-256 比较新旧目录；应用停止后对动态数据执行最后一次增量同步。
7. 修改 systemd 服务的 `WorkingDirectory`、`ExecStart`、`HOME`、`EnvironmentFile` 和 `ReadWritePaths`，使主进程全部读写 `/opt/insight` 产品树。
8. 保留旧 `/opt`、`/srv` 和 `/etc` 目录为带时间戳的回滚副本，并在必要的旧路径建立指向新产品树的兼容软链接。
9. 将本地 `docker-compose.deploy.yml` 的 `landing` 和 `ins` 挂载改为绝对路径，通过 Compose 配置校验后提交到 GitHub。
10. 将已提交的 Compose 文件同步到服务器，仅重建 `landing` 和 `ins` 两个容器；不重建 `app`、`backend` 和 `gateway`。
11. 校验 systemd 服务、容器挂载、容器内文件哈希、主页文案、Insight 页面、课程、两套地产工作台和视觉工作台。

## 5. 验收标准

- `docker inspect` 显示 `landing` 来源为 `/opt/hoosland-home`、`ins` 来源为 `/opt/insight/site`。
- 两个容器健康，其他画布容器的容器 ID 和启动时间不变。
- `http://hoosland.com/` 返回 HTTP 200，并显示既定四个入口文案。
- `http://ins.hoosland.com/` 返回 HTTP 200，已有页面和静态资源可访问。
- `/course/`、`/tools/real-estate/`、`/tools/real-estate-2/` 和 `/tools/visual-workbench/` 均可访问，对应服务运行目录均在 `/opt/insight`。
- 三套工作台的持久数据与密钥配置实体均位于 `/opt/insight/data` 和 `/opt/insight/config`，权限不宽于迁移前。
- 本地 `main`、GitHub `main` 与服务器 Compose 文件的相关内容一致。

## 6. 回滚方案

1. 停止本次迁移的五个主服务，从带时间戳的回滚副本恢复旧 `/opt`、`/srv`、`/etc` 路径和 systemd 配置。
2. 从本次备份恢复旧 `docker-compose.deploy.yml`，仅重建 `landing` 和 `ins` 容器。
3. 执行 `systemctl daemon-reload` 并重启原服务，再执行容器、数据、哈希和公网验证。

## 7. 边界

- 不修改 Nginx 域名和 URL 路由。
- 不修改账号、画布、媒体、数据库内容和 `.env.deploy`。
- 密钥配置只做保属性迁移和路径替换，不读取、不打印、不提交 Git。
- 不删除旧站点、应用、数据、配置或历史备份；旧实体改名为带时间戳的回滚副本。
