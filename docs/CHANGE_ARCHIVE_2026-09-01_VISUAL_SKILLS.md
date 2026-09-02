# 修改档案：画布 Agent 复刻视觉工作台 Skill

日期：2026-09-01
范围：HowCanvas（浩瀚画布）画布 Agent
状态：已部署并通过线上健康检查

## 1. 需求修正

最初误将改动部署到视觉工作台页面；该版本已回滚到原生产版本 `20260831-visual-workbench-16-image-lightbox-click-outside`。最终需求确认为：把工作台的视觉 Skill 能力复刻到画布 Agent，并提供可发现、可审计的 Skill 调用入口。

## 2. 实现内容

第一阶段接入六个视觉 Skill 的类型、后端允许列表、管理员配置、系统提示词和工具能力映射，并新增复合插件说明：

- `visual-workbench-controller`
- `visual-prompt-optimizer`
- `visual-image-generator`
- `chinese-fairyland-suite`
- `oscar-director-cinematography`
- `fantasy-photo-utility`

第二阶段补齐实际调用入口：新增模型可见的 `skill({ name })` 函数工具；画布 Agent 面板校验 Skill 是否启用，返回 Skill 执行契约，并在消息/事件日志中显示加载结果。此前“配置存在但 Agent Skill 没有调用入口”的问题已解决。

## 3. 代码变更清单

- `web/src/services/api/backend.ts`：扩展 `AgentSkillId`。
- `server/index.mjs`：扩展 `AGENT_SKILL_IDS`、默认配置及保存过滤。
- `web/src/lib/agent/agent-llm-skills.ts`：新增六个视觉指令、能力映射、Skill 定义和 `skill` 工具 Schema。
- `web/src/components/canvas/canvas-local-agent-panel.tsx`：执行 `skill` 工具、启用校验、结果摘要和确认链路。
- `web/src/pages/admin/index.tsx`：管理员可选择六个视觉 Skill。
- `plugins/infinite-canvas/skills/visual-workbench/SKILL.md`：新增工作台视觉能力的插件侧复合说明。
- `docs/VISUAL_SKILLS_CANVAS_AGENT.md`：开发与维护说明。

## 4. 生产部署记录

- 服务器：`114.132.45.243:2222`，部署目录 `/opt/infinite-canvas`。
- 编排：`docker-compose.deploy.yml`；重建受影响的 app/backend 容器并刷新网关依赖。
- 第一阶段备份：`/opt/infinite-canvas/backups/visual-skills-20260901-1719`。
- 第二阶段备份：`/opt/infinite-canvas/backups/visual-skills-20260901-1735`。
- 线上地址：<http://can.hoosland.com>。
- 健康检查：`GET /api/health` 返回 `{"ok":true,"service":"infinite-canvas-server"}`。
- 前端资源指纹已包含 `加载视觉 Skill`、`已加载` 和 `visual-workbench-controller`，确认第二阶段代码已被浏览器加载。

生产 `server-data/settings.json` 当前启用四个原有通用 Skill 加六个视觉 Skill；运行时配置未写入源码归档。

## 5. 验证结果

- `web`：`npm run typecheck` 通过。
- `web`：`npm run build` 通过（仅有 Vite chunk/dynamic import 警告）。
- 服务端：`npm run test:server` 6/6 通过。
- Agent：`npm run test:agent` 15/16 通过；唯一失败是 Windows 目录权限模式既有断言 `438 !== 448`，未修改 `canvas-agent` 相关代码。
- Docker app/backend/gateway 均已启动并通过健康检查。

## 6. 回滚方案

只回滚第二阶段入口时，从 `visual-skills-20260901-1735` 恢复以下两个前端文件并只重建 app：

- `web/src/lib/agent/agent-llm-skills.ts`
- `web/src/components/canvas/canvas-local-agent-panel.tsx`

完全回滚视觉 Skill 接入时，恢复 `visual-skills-20260901-1719` 中的源码和 `server-data/settings.json`，再重建 app/backend；保留服务器数据卷，不执行 `docker compose down -v`。

## 7. 版本与后续事项

本次上线是对当前工作树的生产 overlay，未创建新的 Git commit；本地仍以 `main` 的 `362ee90` 为基线，服务器 `.deployed-commit` 也仍记录 `362ee90`。后续应将上述源码和文档提交到版本库并更新部署标记，避免仅依赖备份目录识别线上补丁。
