# HowCanvas 文档索引

## 项目介绍

- [快速开始](/docs/overview/quick-start)
- [功能介绍](/docs/overview/features)
- [Docker 部署](/docs/overview/docker)
- [第三方 GitHub 提示词仓库](/docs/overview/third-party-prompt-repositories)

## 操作手册

- [简明 HTML 操作指南](../web/public/guide.html)

- [画布节点操作手册](/docs/canvas/canvas-node-manual)
- [画布快捷键](/docs/canvas/canvas-shortcuts)

## 开发与数据

- [后台监控行动方案](ADMIN_MONITOR_PLAN.md)
- [画布运行中心与统计口径](ADMIN_MONITOR.md)
- [v0.12.15 监控上线验收](ADMIN_MONITOR_ACCEPTANCE.md)

- [本地开发](/docs/development/local-development)
- [画布数据结构](/docs/development/canvas-data-structure)
- [生成计费与台账](GENERATION_BILLING.md)
- [图片与视频并发配置](CONCURRENCY_SETTINGS.md)
- [视频按秒计费系统升级方案（设计与验收依据）](VIDEO_SECONDS_BILLING_UPGRADE.md)
- [v0.12.9 升级与回滚说明](../RELEASE_NOTES_v0.12.9.md)
- [v0.12.12 生成积分预览与升级说明](../RELEASE_NOTES_v0.12.12.md)
- [画布同模型多渠道调度与服务连续性升级方案（调研与设计评审稿）](MULTI_CHANNEL_ROUTING_UPGRADE.md)

## 商务合作

- [开源协议](/docs/business/license)
- [贡献者协议](/docs/business/cla)
- [商务合作](/docs/business/business)

## 支持与安全

- [漏洞提交](/docs/support/security)
- [赞助支持](/docs/support/sponsor)

## 项目进度

- [2026-09-12 工作日志：计费、视频交付、并发实测与积分预览](WORK_LOG_2026-09-12.md)
- [2026-09-12 画布修改记录](CHANGE_ARCHIVE_2026-09-12_CANVAS.md)

- [更新日志](/docs/progress/changelog)
- [待测试](/docs/progress/pending-test)
- [TODO](/docs/progress/todo)
- [2026-09-02 工作日志](WORK_LOG_2026-09-02.md)
- [2026-09-10 工作日志](WORK_LOG_2026-09-10.md)
- [2026-09-10 画布修改记录](CHANGE_ARCHIVE_2026-09-10_CANVAS.md)

## 说明

- 登录后的画布项目、媒体文件、“我的素材”和账户数据以服务器为主，浏览器仅保留当前账户的版本化缓存。
- AI 渠道和 API Key 由管理员在后台统一配置，所有 AI 请求通过服务器代理，密钥不会下发到浏览器。

## 原理说明

- [本地 Codex 连接画布原理](/docs/development/local-codex-canvas)
