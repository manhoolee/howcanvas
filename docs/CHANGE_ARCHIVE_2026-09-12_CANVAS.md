# 修改记录：计费、视频交付与十路图片并发

日期：2026-09-12（北京时间）  
范围：HowCanvas v0.12.9 至 v0.12.11  
发布代码：`09b4cf5` → `7b02420` → `eaf662e`  
背景和实测数据见[当日工作日志](WORK_LOG_2026-09-12.md)。

## 已上线的模块变更

| 模块 | 主要文件 | 变更后的行为 |
| --- | --- | --- |
| 原子积分账务 | `server/credit-accounting.mjs`、`server/database.mjs` | SQLite 维护可用、冻结、消费和分录；预扣、确认及退回事务提交，金额按整数精度计算 |
| 任务去重 | `server/generation-billing.mjs`、`server/index.mjs` | 用户与请求标识唯一占位；相同指纹重放原响应，参数冲突返回 409，避免重复生成和扣费 |
| 视频按秒计费 | `server/video-delivery.mjs`、`server/index.mjs` | 点/秒模式按 15 秒预扣，持久取回并测量实际时长后结算，一次返还差额 |
| 渠道历史 | `server/channel-history.mjs`、`server/index.mjs` | 视频原任务绑定渠道版本和凭据空间，保护未完成依赖，支持停用新生成及恢复查询凭据 |
| 计费与用户入口 | `web/src/components/billing-ledger.tsx`、`web/src/pages/account/billing.tsx`、`web/src/pages/account/index.tsx`、`web/src/components/layout/user-menu.tsx`、`web/src/router.tsx` | 用户可查看本账号预扣、实耗、退款和明细；服务端权限隔离 |
| 价格设置与展示 | `web/src/components/video-price-summary.tsx`、`web/src/components/video-settings-panel.tsx`、`web/src/pages/admin/index.tsx` | 明确按条/按秒价格、预计预扣、实耗及差额，不自动把原按条价格转换为按秒 |
| 客户端请求标识 | `web/src/services/api/generation-request.ts`、`image-task.ts`、`video.ts` | 创建请求重试复用标识，状态查询和原结果读取不创建新收费任务 |
| 视频下载时限 | `server/video-delivery.mjs`、`.env.example` | `VIDEO_DOWNLOAD_TIMEOUT_MS` 默认 600000，底层响应头和响应体等待同步延长，连接上限仍为 60 秒 |
| 视频交付阶段 | `web/src/lib/video-task-status.ts`、`web/src/components/canvas/canvas-node.tsx`、`web/src/pages/canvas/project.tsx`、`web/src/pages/video/index.tsx`、`web/src/types/canvas.ts` | 展示生成、取回、核验、等待重试和待核实；已知大小时展示实际下载进度 |
| 十路图片队列 | `server/index.mjs`、`server/.env.example` | 程序允许上限由 8 改为 10，启动时记录实际并发；生产从 4 调至 10，未配置环境仍默认 2 |
| 依赖与约定 | `server/Dockerfile`、`server/package.json`、`AGENTS.md` | 视频工具与测试入口随版本更新；明确生产 SSH、源码清单和底层传输超时检查要求 |
| 升级与设计文档 | `RELEASE_NOTES_v0.12.9.md`、`RELEASE_NOTES_v0.12.10.md`、`RELEASE_NOTES_v0.12.11.md`、`docs/` | 补齐升级、迁移、验证、回滚、并发限制、多渠道研究及每日记录 |

上表中的 `image-task.ts`、`video.ts` 简写文件位于 `web/src/services/api/`。与这些变更对应的后端测试包含 `credit-accounting.test.mjs`、`generation-billing.test.mjs`、`generation-billing.integration.test.mjs`、`video-delivery.test.mjs` 和 `security.test.mjs`。

## 最终运行配置

| 项目 | 收尾值或状态 |
| --- | --- |
| 后端代码版本 | v0.12.11 |
| 前端实际产物 | v0.12.10，页面仍显示该版本属于预期 |
| 图片执行 | `IMAGE_TASK_CONCURRENCY=10`，全站共享；普通图片与 Seedream 共用队列 |
| 新安装未配置图片并发 | 默认 2；允许 1 至 10 |
| 图片上游等待 | 沿用 1200000ms；不是包含队列的总等待上限 |
| 视频下载 | 默认 600000ms，单次取回时限 |
| 视频查询、取回和核验池 | 2 个槽；不等于上游视频生成只允许两项 |
| 模型计算 | 图片、视频和 LLM 推理由外部 API 执行 |
| 硬件 | 4 核、16GB、约 220GB 磁盘、14Mbps；8 核/18Mbps 方案未实施 |
| 渠道 | 现有外部渠道直接调用；本机已有 New API，但画布尚未接入同模型自动渠道池 |

只设置环境变量不能突破代码上限；若以后验证 12–16 路，需同步修改和发布程序。更高并发不能替代公网媒体带宽扩容。

## 数据变化和账务边界

v0.12.9 为旧账号建立权威积分账户，导入期初余额并处理明确的历史预扣；升级前完成副本验证和停写备份。v0.12.10、v0.12.11 没有新增数据结构迁移，不再次初始化账户，也不覆盖旧数据库。

运行期间新创建 12 个真实图片任务及其 12 条账单，正常结算；按用户后续指令在测试账号下新增一张 12 节点画布，并完成原任务媒体到画布存储的同步。生成原图、画布媒体及数据备份保留，原有项目经比对未变化。

不把“发布前后余额一致”套用到后续真实消费阶段。详细账号余额、账单和提示词位于受限测试归档；公开日志只保留验收结论。未知的旧图片任务及历史视频收费问题仍需专项对账。

## 验证与证据

| 验证范围 | 实际证据与边界 |
| --- | --- |
| v0.12.9 既有验证 | 独立升级说明记录本地 14 项后端检查，及模拟 6 秒视频的 15 秒预扣、实耗和退差额；不将模拟文件视为供应商付费视频实测 |
| v0.12.10 既有验证 | 独立升级说明记录 12 项后端检查、类型及前端状态验证；正式发布阶段未为此新增付费视频 |
| v0.12.11 发布 | 445 个生产 Canvas 文件及 21 个后端运行文件校验无差异，环境与启动日志为 10，健康端点正常；该时点没有执行真实付费压测 |
| 发布后图片实测 | 明确授权后四种模型各三张，12/12 成功；同时执行峰值 10、排队峰值 2，整批保存 166.6 秒 |
| 资金幂等 | 每单预扣和结算各一次；12 次相同提交返回原任务；冲突参数 409；重复 GET、ACK 和前端恢复无额外扣费 |
| 客户端媒体 | 12 路同时下载 25.94MB，14.92 秒，13.91Mbps；每张哈希、字节数和图片解码通过 |
| 真实前端 | 12 图原任务恢复、显示、缓存、项目和媒体保存、同浏览器刷新、无缓存新浏览器恢复通过；新增生成请求 0，捕获页面脚本异常 0 |
| 持久证据 | 12 成功节点、12 份画布媒体哈希、12 条真实前端绘制回执；旧画布内容相同 |
| 未覆盖 | 失败/取消/余额不足与异常退款、十个独立用户持续负载、4K 混合图和视频并发、多渠道容灾与单机故障 |

结果为单轮样本，不能直接推导所有模型或高峰时段的稳定上限。本机健康接口速度不代表公网用户体验，纯下载速度也不等于完整浏览器加载速度。

## 发布资料与文档同步

| 资料 | 服务器位置 |
| --- | --- |
| v0.12.9 备份、迁移与发布回执 | `/opt/hoosland-archive/canvas-history-v0.12.9-20260912/` |
| v0.12.10 备份与发布回执 | `/opt/hoosland-archive/canvas-history-v0.12.10-20260912/` |
| 中间 4 槽配置归档 | `/opt/hoosland-archive/canvas-image-concurrency-4-20260912T104440Z/` |
| v0.12.11 备份与发布回执 | `/opt/hoosland-archive/canvas-history-v0.12.11-20260912/` |
| 十二图测试、账务核对和原图 | `/opt/hoosland-archive/canvas-image-loadtest-20260912/` |
| 当日文档提交、源码包及同步回执 | `/opt/hoosland-archive/canvas-docs-20260912/` |
| 项目文档区 | `/opt/infinite-canvas/docs/` |

文档同步只复制本轮已提交的文档和截图，先验证原部署清单，再验证完整归档与目标目录，保留既有运维/历史文件。最终源码提交更新部署标记和清单；运行版本仍为 v0.12.11，镜像、用户数据、环境配置和网关不因文档同步而变化。

v0.12.11 后端镜像为 `sha256:95ee787b77fb37c4ce098fcf078ee24d3b94ae5f5724f1b107f9c62cdfd0334e`；前端复用 v0.12.10 镜像 `sha256:02d37495f9a349877c2881895779c4fc5872dbcbfda9265453581b166c5af536`。文档补充不构建应用、不重启容器，也不重新生成图片。

## 回滚与后续

若只因并发压力退回，可在任务排空后将图片配置降至 4 并按既有说明重新创建后端。版本回退应使用兼容当前 SQLite 账务的镜像和源码；不得覆盖上线后的新交易、媒体或新画布。文档回退只恢复文档及对应清单，不操作业务数据。

多渠道设计仍是方案：既有 New API 可承担经验证的渠道分配，画布继续维护业务任务与一次结算；视频查询必须绑定创建时原渠道，未知受理结果不能盲目切换重发。同机网关不是多实例高可用。

当前保留：HTTPS 与安全 Cookie、静态资源压缩/缓存、预览图和媒体分发、用户公平队列、渠道配额、视频查询与下载分池、断点续传、旧账核查、异常退款和持续多用户验收。用户决定先保持 10 路，本次没有部署 12、16 或更高图片并发。
