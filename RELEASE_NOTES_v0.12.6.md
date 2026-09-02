# HowCanvas v0.12.6 发布说明

发布日期：2026-09-02
发布范围：画布 Agent 选区上下文、方案三任务执行契约与本地 Agent 指令约束

## 本次发布

- 选中的画布元素在用户消息发送时生成独立快照，历史对话持续携带当时的节点 ID、标题、类型和摘要。
- Agent 不再用 `canvas_get_selection` 读取的实时选区覆盖已固定的消息上下文；需要最新数据时使用 `canvas_get_state` 按固定 ID 匹配。
- 方案三和本地 Agent 增加对话级任务执行契约，已明确要求直接执行，减少无关询问、猜测、需求复述和空泛方案。
- 工具确认收紧到删除、实际生成和不可逆操作；读取、创建、更新、移动和连线可按用户明确要求连续执行。

## 升级前备份

- 备份生产源码、`.env.deploy`、`server-data`、Compose/Nginx 配置、当前镜像和 `.deployed-commit`。
- 保留 v0.12.5 作为完整回滚点。

## 配置与数据

- 没有新增必填环境变量。
- 没有数据库结构迁移，不修改账户、画布、媒体文件或持久化卷。

## 升级步骤

1. 核对本地发布提交与跟踪文件清单。
2. 在服务器创建可回滚备份。
3. 保留 `.env.deploy`、`server-data` 和持久化卷，更新跟踪源码。
4. 检查 Compose 配置后重建 `app`。本次服务器方案三不需要重建 `backend` 或 `gateway`。
5. 写入实际发布提交到 `.deployed-commit`，并完成健康检查和静态包验证。

## 升级后验证

- Web TypeScript 检查通过。
- Canvas Agent 测试 16/16 通过。
- `app`、`backend`、`gateway`、`ins` 和 `landing` 容器应保持 healthy。
- `http://can.hoosland.com/api/health` 应返回 HTTP 200。
- 主站静态包应包含固定选区和任务执行契约文本。

## 回滚方式

1. 恢复 v0.12.5 源码、app 镜像和 `.deployed-commit`。
2. 仅重建 `app`，再验证主站、登录、画布及 `/api/health`。
3. 本次无数据迁移，不应删除或恢复数据卷。

## 已知事项

- 真实登录账号下的“固定选区 → 连续对话 → 画布操作”仍需上线后人工回归。
- 付费图片/视频生成仍会等待用户确认，本次不主动发起付费请求。
- 公网 HTTPS、`COOKIE_SECURE=true` 和自动部署流水线仍待完成。

## 生产上线记录

- 上线时间：2026-09-02 22:30 CST。
- 上线提交：`ce8d88acf348463caac866b1c373e1dc10f8c457`，生产 `VERSION=0.12.6`。
- 仅重建并重启 `app`；`backend`、`gateway`、`ins` 和 `landing` 未重启，五个容器全部 healthy。
- 新 `app` 镜像：`sha256:5ae8cd96813cc2c782ee2dd688f198591d7c32a88f7043b2c5381727a4bd0357`。
- 回滚备份：`/opt/infinite-canvas/backups/pre-v0126-20260902-222633`；回滚镜像：`infinite-canvas-app:pre-v0126-20260902-222633`。
- 备份校验和 SQLite `quick_check` 通过；`media_assets` 上线前后均为 682，`site_counters` 均为 1，`users.json` 均为 15。
- `http://can.hoosland.com/`、`/api/health` 和 `/visual-workbench/` 均返回 HTTP 200；生产静态包已检出固定选区与任务执行契约文本。
- 服务器保留既有运维/历史文档，本次只校验并上线运行代码、版本文件和当期发布记录。
