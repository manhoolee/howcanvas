# 修改记录：HowCanvas v0.12.8

日期：2026-09-10（北京时间）  
代码基线：v0.12.7 / `3eb746e`  
代码发布：v0.12.8 / `d6a1fae`  
工作背景与时间线见 [当日工作日志](WORK_LOG_2026-09-10.md)。

## 文件与行为

| 模块 | 主要文件 | 修改结果 |
| --- | --- | --- |
| GPT Image 2.5 参数 | `web/src/lib/gpt-image-25.ts`、`web/src/services/api/image.ts` | 基础模型名加精确 size，独立质量校验、自适应、尺寸合法性与透明背景约束 |
| 模型与菜单 | `model-picker.tsx`、`image-settings-panel.tsx`、`canvas-image-settings-popover.tsx`、`use-config-store.ts` | 两个前端模型入口，分辨率/比例/自定义宽高联动，原渠道模型登记保留 |
| 工作台与 Agent 参数 | `web/src/pages/image/index.tsx`、`web/src/lib/agent/agent-site-tools.ts` | 使用当前模型的对应菜单与质量枚举 |
| 多选对齐 | `canvas-node-geometry.ts`、`canvas-context-menu.tsx`、`canvas-node.tsx`、`canvas.ts`、`project.tsx` | 六种边缘/中心对齐，组内内容联动、菜单边缘定位及右键事件保护 |
| 连线删除 | `canvas-connections.tsx` | 删除控件恢复 pointer events，阻止按下事件传给画布，鼠标与键盘均可删除 |
| 复制继承 | `web/src/pages/canvas/project.tsx` | 新节点复制入边、出边并生成新 ID，保留原节点与原连接，支持撤销和保存 |
| URL 交付 | `server/image-delivery-routing.mjs`、`server/index.mjs` | 指定 T8 模型改用 URL 返回，兼容 JSON 和 multipart，服务器继续保存原图 |
| 时序记录 | `server/index.mjs` | 增加上游请求开始、响应头、首字节、响应体大小和返回格式，保留落盘及客户端回执 |
| 长任务传输 | `server/ai-transport.mjs`、`server/index.mjs`、`server/package*.json` | 增加 Undici 6.28.1，显式配置响应头/体等待 1200 秒与连接 60 秒 |
| 配置示例 | `.env.example`、`server/.env.example` | 说明 AI 等待和生成后下载分别计时 |
| 发布防覆盖 | `scripts/release-source-manifest.mjs`、`AGENTS.md`、`.gitignore`、`.dockerignore` | 基于已提交字节建立清单，识别源码差异，明确规范开发目录与运行数据边界 |
| 版本与文档 | `VERSION`、`CHANGELOG.md`、`RELEASE_NOTES_v0.12.8.md`、`docs/` | 版本升级、独立升级说明、参数与交付证据、待测试清单、工作日志和修改索引 |

表内部分文件为简写：画布组件位于 `web/src/components/canvas/`，对齐工具位于 `web/src/lib/canvas/`，类型位于 `web/src/types/`，状态位于 `web/src/stores/`。

## 验证记录

| 检查 | 覆盖与结果 |
| --- | --- |
| GPT Image 2.5 实际 API | 覆盖两模型各分辨率/质量选项、预设实际宽高和自适应；逐项覆盖，不执行 96 组交叉组合 |
| 参数自动检查 | 30 个分辨率/比例预设合法性、文生图/图生图准确 size 与质量、非法尺寸拒绝 |
| 对齐工具 | `web/tests/canvas-alignment.test.cjs`，9 项通过 |
| 对齐浏览器 | `canvas-alignment-ui.cjs`，六种对齐、撤销重做、保存、主题与手机视口通过 |
| 连线浏览器 | `canvas-connections-ui.cjs`，鼠标/Enter/Space/缩放删除、副本连接与原连接、撤销保存和右键删除通过 |
| URL 路由及安全 | `server/image-delivery-routing.test.mjs`、`server/security.test.mjs`，6 项通过；生产 Node 22 路由 3 项通过 |
| 超时 | `server/ai-transport.test.mjs`，8 项通过，包含默认 300 秒复现、610 秒成功、1201 秒截止和取消；与路由/安全合计 14 项通过 |
| 实际交付 | 用户 16:24 任务，上游 49 秒，前端约 56 秒显示，供应商完成后约 6.3 秒交付 |
| 发布清单 | 完整源码和生产 Canvas 按 Git 提交逐文件校验；故意修改预期 VERSION 哈希时，校验以失败状态退出 |
| 在线运行 | 前端发布构建完成；画布/独立工作台四个 HTTP 端点 200；新版本静态资源和后端 16 个文件校验通过 |

新增测试预览仅用于开发测试，不作为正式业务路由。既有构建仍提示大资源块与同模块静态/动态导入混用，构建成功；本次没有扩展为打包重构。

## 部署与回滚

前端镜像：`sha256:c42ea66d4589218543eb3613af915c5dd1d830832489d61031e7a31cc195cec2`。  
后端镜像：`sha256:78f7abcfec02dbd7b456e6354fb58a812f7235795be69faaf937dc37d04e0572`。

前端版本更新于 16:58；后端超时修复已于 16:40 更新，发布版本号时没有再次重启后端。文档补充提交不改变这些运行代码与静态资源。

| 归档阶段 | 位置 |
| --- | --- |
| GPT Image 2.5 | `/opt/infinite-canvas/backups/gpt-image-25-20260910-quick/` |
| 多选对齐 | `/opt/infinite-canvas/backups/canvas-alignment-20260910/` |
| 连线交互 | `/opt/infinite-canvas/backups/canvas-connections-20260910/` |
| URL 图片交付 | `/opt/infinite-canvas/backups/image-delivery-url-20260910/` |
| 超时修复 | `/opt/infinite-canvas/backups/image-timeouts-20260910/` |
| v0.12.8 正式发布 | `/opt/hoosland-archive/canvas-history-v0.12.8-20260910/` |

后续归档统一使用生产目录之外的位置。完整源码、SHA-256 清单和最终部署回执随补充文档重新校验；GitHub main、本地 checkout、服务器 `.deployed-commit` 对应同一最终提交。代码版本标签保留在 `d6a1fae`，不强制改写已推送标签。

回滚按 [v0.12.8 升级说明](../RELEASE_NOTES_v0.12.8.md) 执行，无数据库结构迁移。不要将源码回滚误操作成用户数据恢复。

## 已知限制

- 六档质量已验证可以出图，但质量收益没有经过量化对照。
- 供应商自身超时、网络中断、浏览器冻结和长期跨设备场景仍有外部限制。
- 当前生成并发仍为 2，任务与节点的服务端持久关联及预览图未在本次实现。
- HTTPS 独立待办保留；运行密钥、数据库、媒体与历史备份不纳入源码同步或公开发布。
