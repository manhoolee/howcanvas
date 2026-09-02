# HowCanvas 开发文档

本文档面向参与开发、维护和部署 HowCanvas 的开发者。项目处于持续开发阶段，数据结构和接口可能变化；涉及用户数据、计费或生产部署的改动，应先阅读对应的修改档案和 `SECURITY.md`。

## 1. 项目概览

HowCanvas（浩瀚画布）是一个 React + Vite 的图片创作工作台，包含：

- 无限画布、节点、连线、项目和媒体资源；
- 图片、视频、音频和文本生成；
- 生图工作台与生成历史；
- 服务器账户、渠道、模型和计费；
- 浏览器缓存与服务器数据同步；
- 本地 Canvas Agent、MCP 和插件系统。

生产部署由三个容器组成：

```text
浏览器
  ↓ :80
gateway (nginx)
  ├── 静态资源 → app (nginx)
  └── /api     → backend (Express)
                         ↓
                    server-data
```

## 2. 目录结构

```text
.
├── web/                         # React/Vite 前端
│   └── src/
│       ├── pages/               # 页面：canvas、image、video、admin 等
│       ├── components/          # 通用组件和画布组件
│       ├── services/            # API、云同步、媒体缓存
│       ├── stores/              # Zustand 状态和 localForage 入口
│       ├── lib/                 # 业务辅助、Agent、画布操作
│       └── types/               # TypeScript 类型
├── server/                      # Express 后端和持久化逻辑
│   ├── index.mjs                # API、认证、渠道代理、计费、文件接口
│   └── .env.example             # 生产环境变量模板
├── canvas-agent/                # 本地 Agent 和 MCP 服务
├── plugins/                     # 插件 SDK 和内置插件
├── docs/                        # 项目文档站和开发文档
├── Dockerfile                   # 前端生产镜像
├── docker-compose.deploy.yml    # app/backend/gateway 生产编排
├── nginx.deploy.conf            # 生产网关路由
├── docs/CHANGE_ARCHIVE_*.md     # 重要改动、部署和回滚档案
└── PROJECT_REVIEW_*.md          # 阶段性项目 review
```

## 3. 环境要求

建议使用：

- Node.js 20+；
- Bun 1.3+；
- Docker 和 Docker Compose；
- Git。

前端依赖使用 Bun 安装，但测试脚本通过 Node 调用 TypeScript 和 Vite 入口。修改依赖时应同步对应 lockfile。

## 4. 本地开发

### 4.1 启动前端

```bash
cd web
bun install
bun run dev
```

默认 Vite 地址通常为 `http://localhost:5173`。前端开发代理配置以 `web/vite.config.*` 为准。

### 4.2 启动后端

后端是独立的 Express 服务。先安装依赖并准备开发环境变量：

```bash
cd server
bun install
cp .env.example .env
```

开发环境可以使用默认开发配置；生产环境不得使用默认 `AUTH_SECRET` 或默认管理员密码。根据 `server/package.json` 的 scripts 启动后端，默认监听 8787 端口。

### 4.3 Docker 本地运行

```bash
docker compose up -d
```

该 Compose 配置适合快速运行静态前端。需要完整账户、渠道和工作台 API 时，应使用包含 backend 和 gateway 的部署编排：

```bash
docker compose -f docker-compose.deploy.yml up -d --build
docker compose -f docker-compose.deploy.yml ps
```

## 5. 常用开发命令

项目根目录已提供统一检查入口：

```bash
npm run test:server   # server/index.mjs 语法检查
npm run test:agent    # canvas-agent 测试
npm run test:web      # 前端 TypeScript + Vite 生产构建
npm test              # 按顺序执行全部检查
```

只改前端时，至少运行：

```bash
npm run test:web
```

构建可能出现动态导入提示和 chunk 超过 500KB 的警告。只要构建最终输出 `built`，这些通常不是阻断错误；若新增依赖或页面加载异常，应进一步处理 chunk 拆分。

## 6. 前端架构

### 6.1 页面与状态

页面位于 `web/src/pages`，主要页面包括：

- `pages/canvas/index.tsx`：画布项目列表；
- `pages/canvas/project.tsx`：画布编辑器；
- `pages/image/index.tsx`：生图工作台；
- `pages/video/index.tsx`：视频工作台；
- `pages/admin/index.tsx`：管理员设置、渠道和用户管理；
- `pages/auth/index.tsx`：登录和注册。

跨页面状态主要使用 Zustand，浏览器持久化使用 localForage。新增状态时要明确它属于：

1. 当前页面临时状态；
2. 当前账户浏览器缓存；
3. 服务器主数据。

不要把服务器主数据只放在 React state 或 localStorage 中。

### 6.2 API 调用

统一后端请求入口在 `web/src/services/api/backend.ts`。这里负责：

- Cookie/认证请求；
- 401 失效通知；
- 账户、配置、画布、工作台和媒体 API；
- 请求超时和响应解析。

新增后端接口时，优先在 `backend.ts` 增加类型化方法，不要在页面中散落裸 `fetch`。图片和视频渠道调用分别集中在 `services/api/image.ts` 与 `services/api/video.ts`。

## 7. 服务器数据与账户隔离

后端以登录用户为边界保存数据。生产部署的数据卷默认挂载到：

```text
./server-data:/app/data
```

常见数据包括：

- 用户、设置、渠道配置；
- `canvas/`：账户画布 JSON 和画布媒体；
- `workbench/`：账户工作台列表和生成媒体；
- 个人资产和生成文件。

所有账户私有文件接口都必须从认证用户 ID 推导路径，不能让客户端直接传入任意文件系统路径。`storageKey` 必须经过命名空间和字符校验，不能直接拼接未经校验的路径。

### 7.1 后端接口约定

主要接口前缀：

```text
/api/auth/*           登录、注册、当前用户、退出
/api/config/*         当前账户配置
/api/ai/*             AI 渠道代理和计费请求
/api/canvas/*         画布列表、版本和媒体
/api/workbench/*      图片/视频工作台列表和媒体
/api/assets/*         个人资产
/api/admin/*          管理员接口
/api/health           健康检查
```

认证接口、账户接口和媒体接口默认不应被缓存；生产 API 响应使用 `Cache-Control: no-store`。改变认证或计费接口时，要同步检查 Origin、限流、错误状态码和审计日志。

## 8. 生图工作台同步设计

生图工作台使用两类浏览器缓存：

- `image_generation_logs`：历史记录 JSON；
- `image_files`：按 `storageKey` 保存的图片 Blob。

服务器保存对应的工作台 JSON 和 `files/` 媒体文件。`storageKey` 示例：

```text
image:4fwLxBhuADBYu2lrwckPr
```

### 8.1 打开工作台

入口是 `pages/image/index.tsx` 的账户初始化 effect：

1. 读取本地记录并立即显示；
2. 调用 `syncWorkbenchLogs("image", logStore)`；
3. 服务器列表与本地列表按 ID 合并；
4. 同 ID 用较新的 `updatedAt/createdAt`；
5. 合并列表写回本地和服务器；
6. `syncWorkbenchMedia` 按最新记录优先下载缺失图片；
7. 媒体缓存完成后重新读取记录，生成当前会话有效的对象 URL。

### 8.2 发起和完成任务

新任务的顺序：

```text
创建“生成中”记录
  ↓
同步工作台列表
  ↓
调用渠道生成
  ↓
图片写入本地 image_files
  ↓
使用同一记录 ID 更新成功/失败
  ↓
上传图片到服务器 workbench/files
  ↓
再次合并列表
```

保存操作通过队列串行化，避免“生成中”和最终记录互相覆盖。

### 8.3 修改同步代码时的注意事项

- 不要用空的本地列表直接覆盖服务器列表；
- 不要在所有图片下载完成前阻塞历史列表显示；
- 不要把跨刷新不可用的 `blob:` URL 当成持久化数据；
- 记录中应保留 `storageKey`，对象 URL 只在当前浏览器会话中生成；
- 图片下载失败必须单文件隔离，并允许下一次打开重试；
- 删除功能需要独立的版本/墓碑协议，不能依赖提交更短列表表达删除。

## 9. 画布开发

画布节点类型和数据结构位于 `web/src/types/canvas*`。画布编辑器主要逻辑位于 `web/src/pages/canvas/project.tsx`，节点组件和工具条位于 `web/src/components/canvas`。

图片节点工具条由 `canvas-node-hover-toolbar.tsx` 负责。图片节点快捷工具来自 `canvas-image-toolbar-tools.tsx`，用户配置保存在浏览器 localStorage。修改工具条时要同时考虑：

- 节点缩放和 viewport 变换；
- 鼠标进入/离开工具条时的保持逻辑；
- 拖拽事件不能被工具条按钮传播到画布；
- 图片、视频、音频、文本和配置节点的不同按钮集合；
- 小屏幕和工具数量增长后的布局。

### 9.1 画布 AI 任务恢复

画布中的异步图片和视频生成必须在节点元数据中保留任务 ID，不得在成功或查询失败后立即清除。当前字段为：

```text
图片：serverTaskId
视频：videoTaskId + videoTaskProvider + videoTaskModel
状态：taskStatus + taskStatusUpdatedAt
```

刷新任务时只能调用查询和结果下载接口，不得进入新任务创建或计费流程。任务仍在运行时只更新状态；任务成功时重新下载媒体，写入浏览器媒体库，再由画布云同步上传到账号私有存储。

Seedance 在 T8 渠道中使用官方任务路由：

```text
POST /seedance/v3/contents/generations/tasks
GET  /seedance/v3/contents/generations/tasks/{task_id}
```

Grok Video 3 必须配置为调用格式 `Grok Video V2` 的独立渠道，且该渠道只能包含 `grok-video-3` 视频模型：

```text
POST /v2/videos/generations
GET  /v2/videos/generations/{task_id}
```

创建请求使用 JSON `images` 数组，不得复用 OpenAI 风格视频接口的 multipart `input_reference[]`。多图提示词必须用 `@img1` 到 `@img7` 对应图片顺序；画布会将“图片1”等引用自动转换为该格式。

查询已有任务不得再次扣除平台额度，也不得自动创建上游任务。如果旧节点没有任务 ID，只能由用户从渠道任务详情中补入，不能依据 Prompt 盲目重试。

## 10. Agent 与插件

`canvas-agent/` 是本地 Agent/MCP 服务，负责与本机 Codex 或 Claude Code 交互；网页端 Agent 相关逻辑位于 `web/src/lib/agent` 和 `web/src/components/canvas`。

插件代码位于 `plugins/`，插件开发应遵循：

- 使用插件 SDK 提供的类型和操作；
- 不绕过网页确认直接执行画布写操作或可能扣费的生成；
- 不把 API Key 暴露给浏览器或插件脚本；
- 对远程插件内容、脚本执行和 URL 访问保持最小权限；
- 修改插件工具目录后同步更新 Skill/Agent 的工具白名单。

## 11. 生产部署

### 11.1 配置

部署前准备：

```bash
cp server/.env.example .env.deploy
```

至少检查并替换：

- `AUTH_SECRET`：生产环境必须使用足够长度的随机值；
- `ADMIN_PASSWORD`：首次初始化管理员时使用；
- `COOKIE_SECURE`：启用 HTTPS 后设置为 `true`；
- `CORS_ORIGINS`：仅配置确实需要的跨域来源；
- AI 上游超时、限流和用户存储配额。

不要提交 `.env`、`.env.deploy`、API Key、用户数据或服务器私钥。

### 11.2 构建与启动

```bash
docker compose -f docker-compose.deploy.yml config
docker compose -f docker-compose.deploy.yml build app backend
docker compose -f docker-compose.deploy.yml up -d
docker compose -f docker-compose.deploy.yml ps
```

健康检查：

```bash
curl -fsS http://127.0.0.1/api/health
curl -I http://127.0.0.1/
```

更新前端后至少重建 `app`；修改后端或环境变量后重建 `backend`。如果 gateway 仍指向旧容器 IP，重建 gateway：

```bash
docker compose -f docker-compose.deploy.yml up -d --force-recreate gateway
```

### 11.3 数据备份

部署和数据迁移前先备份 `server-data/`。备份应包括：

- 用户和配置 JSON；
- canvas/workbench 列表；
- 画布、工作台和资产媒体文件。

恢复数据时保持目录权限、用户 ID 和文件命名空间不变，并在恢复后验证登录、`/api/health`、工作台列表和图片媒体接口。

## 12. 常见问题排查

### 首页正常但 API 返回 401

检查登录 Cookie、浏览器会话是否过期，以及是否在登录/退出切换期间存在旧请求。不要通过关闭认证来绕过问题；先清理会话并重新登录。

### 工作台列表为空

先检查本地缓存是否加载，再检查 `GET /api/workbench/image` 是否返回列表。服务器 JSON 存在时，重点检查前端认证、同步请求是否被 401/超时打断，以及页面是否在媒体同步完成后重新加载列表。

### 记录存在但图片不可见

检查三项：

1. 记录是否包含 `storageKey`；
2. 服务器 `workbench/<user>/files/<storageKey>` 是否存在；
3. 浏览器是否成功请求 `/api/workbench/image/files/<storageKey>`。

`blob:` URL 不能跨刷新复用，必须从本地 Blob 缓存重新生成。

### 生成扣费但前端没有图

保留渠道返回的 trace ID，检查 `/api/ai/.../images/edits` 的响应体，而不是只看 HTTP 状态码。部分渠道会在 500 响应中携带已经生成的图片数据；前端解析器会优先尝试恢复。

### 容器启动但页面/API 不通

```bash
docker compose -f docker-compose.deploy.yml ps
docker compose -f docker-compose.deploy.yml logs --tail=200 backend
docker compose -f docker-compose.deploy.yml logs --tail=200 gateway
curl -fsS http://127.0.0.1/api/health
```

如果 gateway 日志显示 upstream 连接失败，重建 gateway 以刷新 backend/app 容器地址。

## 13. 提交前检查清单

- 是否区分了浏览器临时状态、本地缓存和服务器主数据？
- 是否处理了登录失效、账号切换和异步请求竞态？
- 是否避免空列表覆盖服务器历史？
- 是否保留 `storageKey`，没有持久化失效的 `blob:` URL？
- 是否为网络请求增加错误处理、超时或取消？
- 是否同步更新 TypeScript 类型和 API 方法？
- 是否运行 `npm test` 或至少运行受影响模块的检查？
- 是否更新对应的修改档案和相关开发文档？
- 是否检查日志、文档和提交内容中没有 API Key、密码或私钥？

## 14. 相关文档

- [README.md](../README.md)：项目介绍、快速开始和生产部署概览
- [VISUAL_SKILLS_CANVAS_AGENT.md](VISUAL_SKILLS_CANVAS_AGENT.md)：画布 Agent 视觉 Skill 接入、调用契约和维护说明
- [CHANGE_ARCHIVE_2026-09-01_VISUAL_SKILLS.md](CHANGE_ARCHIVE_2026-09-01_VISUAL_SKILLS.md)：本次上线的代码、部署、验证和回滚档案
- [PROJECT_REVIEW_2026-07-28.md](PROJECT_REVIEW_2026-07-28.md)：阶段性项目 review
- [server/.env.example](../server/.env.example)：生产配置模板
- [SECURITY.md](../SECURITY.md)：安全问题报告说明
- [canvas-agent/README.md](../canvas-agent/README.md)：本地 Agent 与 MCP
