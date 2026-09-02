# HowCanvas v0.12.5 发布说明

发布日期：2026-09-02
发布范围：HowCanvas 主站、画布 Agent 集成、服务器 AI 代理与生产网关

完整的开发、修改、部署和验收记录见：[2026-09-02 Canvas Agent 修改档案](docs/CHANGE_ARCHIVE_2026-09-02_CANVAS_AGENT.md)；按时间整理的工作日志见：[2026-09-02 工作日志](docs/WORK_LOG_2026-09-02.md)。

## 本次发布

- 画布 Agent 支持将当前选中的文本、图片、视频、音频、配置、组和插件节点以安全摘要带入对话。
- 输入区和已发送的用户消息显示选中数量、节点类型图标和名称，便于确认上下文范围。
- 接入六个视觉工作台 Skill，并提供模型可调用的 `skill({ name })` 入口。
- 修复服务器多渠道文本模型映射、鉴权错误透传、普通 JSON/SSE/增量文字交付和无结果提示。
- 恢复并保护独立视觉工作台生产路由，提供带备份和自动回滚的网关恢复脚本。

## 升级前备份

- 当前生产主站部署提交：`cac0844c8d3f077cb4c4fa173251737bfd3708fc`。
- v0.12.5 发布前的功能源码提交为 `12ae85673ea5dd95ea84b2b362c8e9f33102dd6e`，本次版本对齐仅增加版本和发布文档并重建 app。
- 升级前备份 `server-data/`、`.env.deploy`、Compose/Nginx 配置及当前 `.deployed-commit`。
- 本次路由修复已生成备份：`/opt/infinite-canvas/backups/restore-visual-workbench-20260902-082601/nginx.deploy.conf`。
- 本次版本升级备份：`/opt/infinite-canvas/backups/pre-v0125-20260902-090919/`。
- 代码回撤点：`v0.12.4`；发布提交完成后使用 `v0.12.5` 作为新回撤点。

## 配置变化

- 没有新增必填环境变量。
- AI 渠道和 API Key 仍只保存在服务器配置，浏览器不接收真实 Key。
- 视觉 Skill 由管理员配置；未知或未启用的 Skill 会被拒绝。
- 本地 Canvas Agent 仍默认监听 `127.0.0.1:17371`，不作为服务器多租户进程运行。
- 当前 HTTP 部署的 `COOKIE_SECURE` 保持未启用；切换 HTTPS 后必须显式设为 `true`。

## 数据迁移

- 无数据库结构迁移。
- 不修改账户、画布、工作台记录、媒体文件和持久化卷。

## 升级步骤

1. 备份生产配置、数据目录、当前镜像和 `.deployed-commit`。
2. 获取 `v0.12.5` 源码并核对 Git 提交和 tracked-file manifest。
3. 保留生产 `.env.deploy` 与 `server-data`，执行：

   ```bash
   docker compose -f docker-compose.deploy.yml config
   docker compose -f docker-compose.deploy.yml up -d --build app backend
   ```

4. 若网关配置发生变化，先执行固定版本的视觉工作台路由恢复脚本，再只重建 gateway：

   ```bash
   curl -fsSL https://raw.githubusercontent.com/manhoolee/howcanvas/v0.12.5/scripts/restore-visual-workbench-route.sh | bash
   docker compose -f docker-compose.deploy.yml up -d --no-deps --force-recreate gateway
   ```

5. 写入实际部署提交到 `/opt/infinite-canvas/.deployed-commit`，再执行升级后检查。

## 升级后验证

- `GET http://can.hoosland.com/api/health` 返回 HTTP 200。
- 视觉工作台无斜杠地址返回 308，带斜杠页面返回 200，`/api/health/ready` 返回 `ready: true`。
- app、backend、gateway 健康；地产工作台和 landing 路由仍可用。
- `npm run test:server`：6/6 通过。
- `npm --prefix web run typecheck`：通过。
- `npm run test:agent`：15/16 通过；Windows 文件权限 mode 位测试仍需 Linux/CI 确认。
- 已检查线上静态包包含 `canvasSelection`、`selectionContext`、鉴权错误和无文字结果处理逻辑。
- 本次未主动发起付费图片或视频生成。

## 回滚方式

### 仅回滚视觉工作台路由

恢复备份的 `nginx.deploy.conf`，然后执行：

```bash
docker compose -f docker-compose.deploy.yml up -d --no-deps --force-recreate gateway
```

### 完整回滚到 v0.12.4

1. 停止受影响的 app/backend/gateway 服务。
2. 恢复 `v0.12.4` 源码或镜像、Compose/Nginx 配置和 `.deployed-commit`。
3. 重新启动服务并验证健康检查、登录、画布和数据接口。
4. 除非确认发生持久化数据损坏，否则不要执行 `docker compose down -v`，也不要恢复数据卷。

## 已知事项与未完成验收

- 本次上线的服务器“方案三：Skill + LLM”已经与 `@basketikun/canvas-agent` 脱钩，不依赖 npm 包；该包只属于可选的本地 Codex/Claude 桥接模式，拥有独立版本和发布节奏，不构成 v0.12.5 服务器部署依赖。
- 尚未完成已登录浏览器中的“选中元素—发送 Agent—显示图标/上下文—完整文字—实际修改画布”端到端回归。
- Agent 仍需补齐 `content[]`/`output_text` 解析、SSE 断线保留已收文字、turn 状态轮询和控制面错误提示。
- 本地 Agent 的 Codex 登录态属于运行它的用户；线上网页登录 Cookie 或服务器渠道 Key 不会替代本机 Codex 鉴权。
- 公网 HTTPS、自动生产部署流水线和正式 npm 发布尚未完成。

## 生产记录

- 环境：公网 HTTP，服务器 `114.132.45.243:2222`，目录 `/opt/infinite-canvas`。
- 部署方式：手工 SSH/Compose；GitHub Actions 当前不自动更新生产服务器。v0.12.5 已通过 SSH 仅重建 app 并将 `.deployed-commit` 对齐到发布提交。
- 健康检查、回滚备份和未解决风险已记录在上述修改档案中。
