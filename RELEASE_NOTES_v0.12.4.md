# HowCanvas v0.12.4 发布说明

发布日期：2026-08-29

## 新增

- 生图工作台和画布图片提示词工具栏新增独立的「电影风格」入口，位置位于图片参数与发送按钮之间。
- 支持摄影配方、影片类型，以及构图、调色、光影、镜头、运镜、质感、氛围、剪辑节奏八组维度；选择后即时合并到提示词框。
- Canvas、Workbench、Agent 和插件生成链路统一传递风格配置，并保存原始提示词、最终提示词和风格目录版本。

## 升级前备份

- 生产服务器当前发布提交：`424e9d1c000794a03731fd934b3cfd9918f1f1b6`（`v0.12.3`）。
- 升级前备份生产 `server-data`、`.env.deploy`、Compose/Nginx 配置和当前源码归档；备份位置：`/opt/infinite-canvas/backups/pre-v0124-film-style-20260829-123124/`（已生成并通过 SHA-256 校验）。
- Git 回撤点：`v0.12.3` 与本次发布前的 `pre-v0.12.4-20260829` 标签。

## 配置与数据迁移

- 无新增环境变量，无数据库结构迁移。
- 现有账户、画布、工作台记录和媒体文件保持不变。

## 升级步骤

1. 从 GitHub 获取本次发布提交的源码归档并校验 tracked-file manifest。
2. 保留 `.env.deploy` 和生产 `server-data`，执行 `docker compose -f docker-compose.deploy.yml config`。
3. 重建并重启 `app`、`backend`，必要时重建 `gateway`。
4. 写入 `.deployed-commit`，记录实际部署提交。

## 升级后验证

- 检查所有生产容器为 healthy。
- 检查 `/api/health`、首页 HTML、登录和工作台/画布页面。
- 检查本地、GitHub `main` 与服务器 `.deployed-commit` 为同一提交。

## 回滚方式

1. 停止受影响服务，恢复升级前源码归档、Compose/Nginx 配置和 `.deployed-commit`。
2. 使用 `docker compose -f docker-compose.deploy.yml up -d --build` 重建并启动服务。
3. 验证健康检查、登录和数据接口；仅在确认发生持久化数据损坏时恢复 `server-data` 备份。

## 已知事项

- Vite 构建仍会提示既有的大体积 chunk 和动态/静态导入告警，不影响发布。
- 「电影风格」仍需在真实账号和实际模型上进行人工视觉效果验收。

## 第三方来源

- 电影摄影维度参考 [oscar-director-skill](https://github.com/ddt080701-eng/oscar-director-skill) 固定提交 `30463aead09ccb5e93e5bced8fcc420e917a81d6`；本项目仅将其整理为属性化选项，并保留来源归因。
