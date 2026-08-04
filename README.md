<p align="center">
  <img src="web/public/logo.svg" width="96" alt="HowCanvas logo">
</p>

<h1 align="center">HowCanvas</h1>

<p align="center">
  <a href="https://linux.do/"><img src="https://img.shields.io/badge/Linux.do-Community-2b6de8?style=flat-square" alt="Linux.do"></a>
  <a href="https://github.com/manhoolee/howcanvas"><img src="https://img.shields.io/github/stars/manhoolee/howcanvas?style=flat-square&logo=github" alt="GitHub stars"></a>
  <a href="https://github.com/manhoolee/howcanvas/tags"><img src="https://img.shields.io/github/v/tag/manhoolee/howcanvas?style=flat-square&label=version" alt="Version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-f97316?style=flat-square" alt="License"></a>
  <a href="https://vite.dev/"><img src="https://img.shields.io/badge/Vite-7-646cff?style=flat-square&logo=vite&logoColor=white" alt="Vite"></a>
  <a href="https://reactrouter.com/"><img src="https://img.shields.io/badge/React_Router-7-ca4245?style=flat-square&logo=reactrouter&logoColor=white" alt="React Router"></a>
</p>

<p align="center">
  <a href="docs/content/docs/overview/quick-start.mdx">快速开始</a> · <a href="docs/content/docs/overview/features.mdx">功能介绍</a> · <a href="docs/content/docs/overview/docker.mdx">Docker 部署</a> · <a href="docs/content/docs/canvas/canvas-node-manual.mdx">画布节点操作手册</a> · <a href="docs/content/docs/canvas/canvas-shortcuts.mdx">画布快捷键</a> · <a href="CLA.md">贡献者协议</a> · <a href="SECURITY.md">漏洞提交</a> · <a href="docs/content/docs/progress/todo.mdx">待办事项</a> · <a href="canvas-agent/README.md">本地 Canvas Agent</a> · <a href="plugins/infinite-canvas">Codex app 插件</a>
</p>

> 本项目 fork 自 [basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas)，在此基础上进行了大量功能扩展和独立演进。
>
> 非专业开发人员业余 vibecoding 的第一个项目，代码质量有限，请多多包涵。

HowCanvas（浩瀚画布）是一款面向图片创作的开源工作台。它把画布编排、AI 图片生成、参考图编辑、对话助手、提示词库和素材沉淀放在同一个界面里，适合用来探索视觉方案并连续迭代图片结果。

> [!CAUTION]
> 项目目前处于开发阶段，不保证历史数据兼容。各种本地存储格式都可能直接调整，欢迎关注后续更新，当前更适合个人/工作室本地部署或局域网内部使用，不建议直接公网多人共用。
>
> 如果你需要稳定维护自己的分支，建议自行 fork 后独立开发。

## 赞助商

<table>
  <tr>
    <td width="190" align="center">
      <a href="https://www.atlascloud.ai/zh?utm_source=github&amp;utm_medium=link&amp;utm_campaign=infinite-canvas"><img src="assets/atlascloud.svg" width="163" alt="Atlas Cloud"></a>
    </td>
    <td>
      <a href="https://www.atlascloud.ai/zh?utm_source=github&amp;utm_medium=link&amp;utm_campaign=infinite-canvas">Atlas Cloud</a> is a full-modal AI inference platform that gives developers a single AI API to access video generation, image generation, and LLM APIs. Instead of managing multiple vendor integrations, you connect once and get unified access to 300+ curated models across all modalities. Check out <a href="https://www.atlascloud.ai/console/coding-plan">Atlas Cloud's new coding plan promotion</a> for more budget-friendly API access.
    </td>
  </tr>
</table>

## 核心功能

- 画布：多画布项目、节点拖拽缩放、连线、小地图、撤销重做、导入导出。
- AI 创作：管理员在后台配置多渠道 AI 模型，所有 AI 请求由服务器统一代理转发，支持文生图、图生图、文本问答、音频和视频生成；API Key 仅存服务器，不下发浏览器。
- 画布助手：围绕选中节点和上游节点对话、生图，并把结果插回画布。
- 多用户权限：账号登录、角色管理（管理员/用户）、按功能授权、算力额度控制。
- 本地 Agent：通过本机 Canvas Agent 连接 Codex / Claude Code，让 Agent 通过 MCP 操作当前画布。
- Codex App 插件：提供 Codex app 插件，安装后会自动注册 MCP 并尝试拉起本地 Agent。
- 插件系统：支持通过 URL 动态安装 / 启用 / 更新 / 卸载远程节点插件，并提供 TypeScript SDK 自行开发画布节点插件。
- 提示词库：内置多来源提示词库，可按标签和来源筛选，支持添加自定义提示词来源。

完整功能说明见 [功能介绍](docs/content/docs/overview/features.mdx)。

## 快速开始

账号登录后，画布项目、画布媒体文件和账户数据以服务器为主，可跨设备、跨浏览器恢复。浏览器会保存当前账户缓存，版本一致时无需重新下载完整画布。管理员在后台统一配置 AI 渠道与模型，普通用户无需自行填写 API Key。

### 本地开发

需要 Node.js 22+、npm 和 Bun 1.3+。当前版本依赖后端完成登录、数据保存和 AI 请求代理，因此需要同时启动 `server` 与 `web`。

```bash
git clone https://github.com/manhoolee/howcanvas.git
cd howcanvas
```

复制本地开发配置，并在 `server/.env` 中将示例密码替换为自己的密码：

```bash
cp server/.env.example server/.env
```

Windows PowerShell 使用 `Copy-Item server/.env.example server/.env`。

在仓库根目录打开两个终端。终端 1 启动后端：

```bash
cd server
npm ci
npm run dev
```

终端 2 启动前端：

```bash
cd web
bun install
bun run dev
```

访问 `http://localhost:3000`，使用 `server/.env` 中的管理员账号登录；`http://localhost:3000/api/health` 返回 `{"ok":true}` 表示前后端连接正常。Windows PowerShell 如果限制执行 `.ps1`，请使用 `npm.cmd` 和 `bun.cmd`。

首次登录后，在「管理后台 -> 渠道与模型」中添加 AI 渠道并配置模型，普通用户方可使用 AI 功能。

### Docker 部署

需要 Docker Engine 24+ 和 Docker Compose v2。默认 Compose 会从源码构建前端、后端与同源网关。

```bash
git clone https://github.com/manhoolee/howcanvas.git
cd howcanvas
cp .env.example .env
```

在 `.env` 中至少替换 `AUTH_SECRET` 和 `ADMIN_PASSWORD`，然后启动：

```bash
docker compose config
docker compose up -d --build
docker compose ps
```

访问 `http://localhost:3000`，`http://localhost:3000/api/health` 返回 `{"ok":true}` 表示服务就绪。账号、画布和媒体文件保存在 Docker 命名卷 `howcanvas_server-data`；执行 `docker compose down` 不会删除数据，不要在未备份时执行 `docker compose down -v`。

对公网提供服务时，应在端口 3000 前配置 HTTPS 反向代理，并在 `.env` 中设置 `COOKIE_SECURE=true`。Windows PowerShell 使用 `Copy-Item .env.example .env`。

## 效果展示

<table width="100%">
  <tr>
    <td width="50%"><img src="https://i.ibb.co/TDFvGWDT/image.png" alt="image" border="0"></td>
    <td width="50%"><img src="https://i.ibb.co/zVwJq3YS/image.png" alt="image" border="0"></td>
  </tr>
  <tr>
    <td width="50%"><img src="https://i.ibb.co/PvY3qhhK/image.png" alt="image" border="0"></td>
    <td width="50%"><img src="https://i.ibb.co/7D04LwN/image.png" alt="image" border="0"></td>
  </tr>
  <tr>
    <td width="50%"><img src="https://i.ibb.co/bj30FtS5/5.png" alt="5" border="0"></td>
    <td width="50%"><img src="https://i.ibb.co/hxRvjw51/image.png" alt="image" border="0"></td>
  </tr>
  <tr>
    <td width="50%"><img src="https://i.ibb.co/jkWsF8q1/image.png" alt="image" border="0"></td>
    <td width="50%"><img src="https://i.ibb.co/XrnfXHx7/image.png" alt="image" border="0"></td>
  </tr>
</table>

## 联系方式

项目定制二次开发需求 / 生图 API 需求可联系。

邮箱：AR2000@VIP.163.com

## 赞助支持

本项目长期开放广告赞助合作，欢迎品牌 / 产品投放，你的支持是持续更新的动力！

有广告赞助意向请通过上方联系方式沟通。

## 社区支持

学 AI，上 L 站：[LinuxDO](https://linux.do/)



## 开源协议

本项目使用 GNU Affero General Public License v3.0，见 [LICENSE](LICENSE)。

## Star History

<a href="https://www.star-history.com/?repos=manhoolee%2Fhowcanvas&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=manhoolee/howcanvas&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=manhoolee/howcanvas&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=manhoolee/howcanvas&type=date&legend=top-left" />
 </picture>
</a>
