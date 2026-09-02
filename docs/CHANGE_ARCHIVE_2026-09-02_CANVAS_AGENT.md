# 修改档案：Canvas Agent 鉴权、结果交付、固定选区与任务执行

日期：2026-09-02
对应版本：v0.12.5–v0.12.6
范围：HowCanvas 主站、画布 Agent、服务端 AI 代理、生产网关
状态：v0.12.6 已提交并部署生产，健康、静态包和数据完整性检查通过；登录后端到端验收仍待人工完成

## 1. 背景与问题

本次工作集中处理画布 Agent 的四类问题：

1. 选择非首个服务器渠道或模型时出现“鉴权失败，请检查 API Key、套餐权限或模型权限”；
2. 普通 JSON、SSE 增量事件或异步失败没有正确显示文字，用户看到空消息或无结果；
3. 画布中点选的元素没有进入 Agent 上下文，用户无法确认本轮请求使用了哪些元素；
4. 部署画布 Agent 后，独立视觉工作台入口 `/tools/visual-workbench/` 被网关配置覆盖。
5. 已发送消息的选区上下文仍可能在后续轮次被当前实时选区替换，任务指向不够稳定。
6. Agent 对明确需求仍有过多无关询问、需求复述和猜测，不能稳定执行用户要求。

本次还明确了两个不同的 Agent 链路：

- 画布页面的“方案三：Skill + LLM”走服务器 `/api/ai/<channel-id>` 代理；
- 本地 Codex Agent 是用户电脑上的 `127.0.0.1:17371` 桥接进程，负责连接本机 Codex app-server，不是可直接放进生产 Docker 的多租户服务。

## 2. 当日时间线与提交

以下提交均在 2026-09-02 产生，`main` 与 `origin/main` 已同步：

| 时间（北京时间） | 提交 | 内容 |
| --- | --- | --- |
| 11:41:16 | `836f5ae` | 接入视觉 Skill，修复服务器渠道/模型鉴权映射与失效配置清理 |
| 13:23:55 | `ec2730f` | 修复 Agent 普通 JSON、Responses SSE、Chat Completions SSE 和增量输出交付 |
| 14:20:50 | `2f54c2a` | 新增画布选区摘要与媒体信息脱敏 |
| 14:22:35 | `ee4c7ea` | 修复选区状态进入 Agent 上下文的时序问题 |
| 14:36:04 | `12ae856` | 将选区上下文传入本地/服务器 Agent，对话显示选中数量和类型图标 |
| 15:19:58 | `c404a65` | 固化独立视觉工作台生产代理路由 |
| 15:58:03 | `e742829` | 增加生产网关配置保护规则，避免误覆盖视觉工作台路由 |
| 16:03:55 | `f7c99d1` | 增加带备份、标记校验和回滚的路由恢复脚本 |
| 16:04:15 | `db01b4a` | 将恢复脚本固定到可复现的 Git 提交 |
| 17:00:52 | `cac0844` | 整理 v0.12.5 发布说明、修改档案、CHANGELOG、版本号和进度文档，创建发布 tag |
| 17:19:14 | `a97b499` | 记录生产 SSH 部署提交、备份位置和线上健康检查结果 |
| 22:25:05 | `ce8d88a` | 将每条消息的选区固定为发送时快照，增加对话级任务执行契约，发布 v0.12.6 |
| 22:30 左右 | 生产发布 | 完成 v0.12.6 备份、app 重建、健康检查、数据一致性与静态包验证 |
| 22:36:09 | `b091de5` | 记录 v0.12.6 生产提交、回滚备份、镜像和验证结果 |

## 3. 实现内容

### 3.1 鉴权、模型和视觉 Skill

- 服务端校验 Agent 文本模型是否存在、是否具备文本能力；失效配置会被清理，不再静默回退到错误渠道。
- 前端将服务端保存的 `channelId::model` 映射为服务器渠道选择格式，首轮请求不会误用本地空 Key 渠道。
- 服务器 AI 请求继续通过 `/api/ai/<channel-id>` 代理，真实 API Key 不下发浏览器。
- 画布 Agent 增加视觉工作台 Skill 的允许列表、管理员配置、系统提示词和 `skill({ name })` 调用入口。
- 当前配置的 DeepSeek 模型在服务器上通过 `/models` 和最小 Chat Completions 请求验证，均返回 HTTP 200；探测过程中未输出密钥。

### 3.2 文字输出、流式事件和错误交付

- 兼容普通 JSON、Responses SSE、Chat Completions SSE 及 Codex 结构化事件。
- 合并仅包含增量片段的消息，处理 `item/updated`、工具调用、`turn.failed` 和初始化错误。
- 成功但没有文字时显示明确的无结果提示，不再静默留下空消息。
- 生产 Nginx 对 `/api/ai/` 关闭缓冲和缓存，避免流式片段被网关攒住。

### 3.3 画布选区进入上下文

- 新增紧凑的选区摘要，传递节点 ID、类型、标题、文本/提示词摘要和状态。
- 文本、图片、视频、音频、配置、组、插件节点均可显示；媒体节点不会把 Blob/Data URL 或完整媒体内容写入对话历史。
- 本地 Agent 和服务器 Skill + LLM 请求均携带 `selectionContext` 与 `canvasSelection`。
- v0.12.6 在发送时调用 `snapshotAgentCanvasSelection` 创建独立副本，并在消息中记录选区所属项目 ID。
- 输入框和已发送的用户消息显示“已选”数量、节点类型图标和名称，每条历史消息持续携带自己的发送时快照。
- Agent 不得使用 `canvas_get_selection` 覆盖固定快照；需要节点最新值时，通过 `canvas_get_state` 按快照中的节点 ID 匹配。

### 3.4 对话任务执行约束

- 方案三和本地 Agent 共用任务执行原则：用户要求明确且可执行时直接操作，不以复述、空泛建议或额外规划取代实际执行。
- 仅在缺失会改变结果的关键信息、操作有明确安全风险或将产生付费请求时询问。
- 删除、付费生成、自动运行和不可逆 `apply_ops` 保留确认；普通读取、创建、更新、移动和连线可按明确指令连续执行。

### 3.5 生产路由恢复

- `nginx.deploy.conf` 固化 `/tools/visual-workbench/` 到独立视觉工作台服务的代理路由。
- `scripts/restore-visual-workbench-route.sh` 会备份配置、校验路由标记、验证 Compose/Nginx 配置，失败时自动回滚。
- 生产执行恢复脚本后，仅强制重建 `gateway`，解决 bind mount 配置文件替换后旧容器仍持有旧 inode 的问题。

## 4. 生产部署记录

- 服务器：`114.132.45.243:2222`
- 部署目录：`/opt/infinite-canvas`
- 执行方式：通过已有 root SSH 会话执行恢复和容器操作；没有把密钥写入仓库或日志。
- 首次功能部署标记：`12ae85673ea5dd95ea84b2b362c8e9f33102dd6e`。
- v0.12.5 发布对齐后的部署标记：`/opt/infinite-canvas/.deployed-commit` = `cac0844c8d3f077cb4c4fa173251737bfd3708fc`
- v0.12.6 最终部署标记：`/opt/infinite-canvas/.deployed-commit` = `ce8d88acf348463caac866b1c373e1dc10f8c457`
- 路由恢复备份：`/opt/infinite-canvas/backups/restore-visual-workbench-20260902-082601/nginx.deploy.conf`
- v0.12.5 升级备份：`/opt/infinite-canvas/backups/pre-v0125-20260902-090919/`，包含发布前源码归档、SQLite 在线备份、配置和当前部署标记。
- v0.12.6 升级备份：`/opt/infinite-canvas/backups/pre-v0126-20260902-222633/`，包含发布前源码、配置、完整数据归档、SQLite 在线备份、校验和、部署产物和旧部署标记。
- v0.12.6 回滚镜像：`infinite-canvas-app:pre-v0126-20260902-222633`；新 app 镜像：`sha256:5ae8cd96813cc2c782ee2dd688f198591d7c32a88f7043b2c5381727a4bd0357`。
- 首次路由修复只重建 gateway；版本对齐时按 SSH 仅重建 app，未重启 backend、数据卷或独立视觉工作台。
- app、backend、gateway、地产工作台和 landing 容器均已检查并保持 healthy。
- v0.12.6 发布仅重建并重启 app，backend、gateway、ins 和 landing 未重启。服务器既有运维/历史文档未被强制覆盖。

生产检查结果：

| 地址 | 结果 |
| --- | --- |
| `http://can.hoosland.com/api/health` | HTTP 200，返回 `infinite-canvas-server` |
| `http://ins.hoosland.com/tools/visual-workbench` | HTTP 308，跳转到带斜杠地址 |
| `http://ins.hoosland.com/tools/visual-workbench/` | HTTP 200，返回工作台 HTML |
| `http://ins.hoosland.com/tools/visual-workbench/api/health/ready` | HTTP 200，`ready: true` |

视觉工作台的 `build_id` 属于独立服务，不能用来判断画布 Agent 版本；画布主站以 `.deployed-commit` 和主站静态包为准。

## 5. SSH 与鉴权故障诊断

### 5.1 SSH 封禁原因

sshd 日志显示，`120.196.61.67` 的 root 公钥登录在 14:52:40 和 14:52:41 已成功；随后同一 IP 连续尝试 `ubuntu`、`debian`、`ec2-user`、`administrator` 等无效用户，触发 fail2ban 的 `maxretry=3` 规则。

结论：本次封禁不是 root 密钥错误，也不是 Canvas Agent API Key 错误，而是无效用户名尝试触发的自动封禁。本机 Windows 直连 SSH 另外受限于当前环境没有对应私钥；生产修复使用已有 root 会话完成。

### 5.2 应用鉴权边界

- 服务器渠道 Key/模型探测成功，当前没有发现新的 Agent 401/403 日志。
- 生产 `.env.deploy` 未设置 `COOKIE_SECURE`；按服务端代码在 HTTP 下会使用 `false`，暂没有证据表明 Secure Cookie 是本次问题原因。
- 未登录访问 `/api/config/ai` 返回 401 属于预期行为；仍需在真实登录会话中验证浏览器请求的渠道、模型和授权头是否一致。

## 6. 验证记录

- 服务端：`npm run test:server`，6/6 通过。
- Web：`npm --prefix web run typecheck`，通过。
- Canvas Agent：15/16 通过；唯一失败是 Windows 文件权限 mode 位断言（期望 `0700/0600`，Windows 返回 `438 !== 448`），需在 Linux/CI 再确认。
- v0.12.6 Canvas Agent：16/16 通过；Web TypeScript 检查再次通过。
- 线上主站静态包已包含 `canvasSelection`、`selectionContext`、鉴权错误和无文字结果处理逻辑。
- v0.12.6 生产静态包已检出固定选区和任务执行契约文本。
- 备份 SHA-256 校验通过，备份与生产 SQLite `PRAGMA quick_check` 均为 `ok`。
- 上线前后 `media_assets=682`、`site_counters=1`、`users.json=15`，没有发现数据丢失。
- 未主动发起付费图片/视频生成请求。

## 7. 未完成事项与已知限制

1. 本次上线的服务器“方案三：Skill + LLM”已经与 `@basketikun/canvas-agent` 脱钩，不依赖 npm 包；`canvas-agent/` 及其 npm 包只服务可选的本地 Codex/Claude 桥接模式，独立版本不影响服务器发布。
2. 尚未在已登录浏览器完成“点选元素 → 发送 Agent → 检查图标/上下文 → 查看完整文字 → 实际修改画布”的端到端回归。
3. Agent 事件解析仍需继续补充协议 fixture，重点覆盖 SSE 断开保留已收文字和更多上游响应变体。
4. `turn` 控制面仍是异步立即返回，状态/错误缺少可轮询交付；控制面 POST 失败和生成器尚未就绪的情况需要显式反馈。
5. 本地 Canvas Agent 是单用户本机进程，不应直接作为共享服务器进程暴露；若要做服务器多租户 Agent，需要独立的认证、线程和画布隔离设计。
6. 公网 HTTPS、`COOKIE_SECURE=true`、正式自动部署流水线尚未完成；本次仅验证 HTTP 线上链路。

## 8. 升级、回滚与数据影响

- 本次没有新增环境变量，没有数据库结构迁移，不删除账户、画布、工作台记录或媒体卷。
- 升级前应备份 `.env.deploy`、`server-data`、Compose/Nginx 配置和当前 `.deployed-commit`。
- 路由单独回滚：恢复 `nginx.deploy.conf` 备份后执行 `docker compose -f docker-compose.deploy.yml up -d --no-deps --force-recreate gateway`。
- v0.12.6 完整回滚：使用 `pre-v0126-20260902-222633` 备份和 `infinite-canvas-app:pre-v0126-20260902-222633` 镜像恢复 v0.12.5 源码、配置和 `.deployed-commit`，再验证 `/api/health`、登录和数据接口；除非确认数据损坏，不要删除或恢复持久化卷。

## 9. GitHub 发布记录

- v0.12.6 功能提交：`ce8d88acf348463caac866b1c373e1dc10f8c457`。
- v0.12.6 发布标签指向功能提交，生产记录提交为 `b091de5`。
- 本档案和当日工作日志更新后与 `main` 一并推送，推送后通过远端引用验证分支与标签指向。

## 10. 后续执行顺序

1. 如继续维护本地 Codex/Claude 桥接模式，再单独规划 `canvas-agent/` 的版本与发布；这不阻塞服务器方案三。优先完成已登录生产环境的选区、流式输出和实际画布修改回归。
2. 修复内容数组解析、SSE 断线保留、turn 状态交付和控制面错误提示，并补协议 fixture。
3. 在 Linux CI 确认 Agent 权限测试，在已登录生产环境完成一次非付费端到端回归。
4. 完成 HTTPS、Cookie 安全配置和自动部署/发布流水线后，再将剩余待测试项从 pending-test 移入正式功能说明。
