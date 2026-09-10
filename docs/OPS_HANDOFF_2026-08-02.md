# Hoosland 运维交接记录 — 2026-08-02

## 一、今日完成

- 登录生产服务器 `114.132.45.243:2222`，确认 SSH 可用。
- 盘点主站、Can 画布、OWUI、HoosChat、两个 MySQL 实例和 Hermes Agent。
- 将完整生产数据同步到本机：
  - 本地目录：`/Users/hoosland/Documents/hoosland-emergency-backup-20260802/`
  - 规模：约 3.3G
  - 已包含主站/画布数据、OWUI 数据和上传文件、Chat 数据、MySQL 数据、Hermes 配置/认证状态/工作区/运行环境、`.env`、Docker/Nginx 配置、SSH 授权文件和恢复元数据。
- 本地备份最终核对通过：关键 `.env`、数据库目录、Hermes 服务文件、Docker 清单和 `authorized_keys` 均存在。
- GitHub 私人仓库 `manhoolee/hoosland` 已保存可维护源码和部署配置，最新主分支提交为 `41c74ac`。完整生产数据以本地备份为准。

## 二、今日排查结论（系统恢复前）

- 宿主机没有独立运行的 Nginx；Nginx 主要运行在 Docker 网关容器中。
- Docker 网关监听宿主机 `80`；宝塔面板监听 `8888`；SSH 使用 `2222`。
- 两个 MySQL 容器分别映射 `13306` 和 `13307`，没有发现抢占 `80/443/2222` 的端口冲突。
- `infinite-canvas-gateway-1` 内部 `nginx -t` 通过。
- 当前问题更像是 Docker 网关、宿主机响应层或宝塔/Docker 配置边界问题；不能仅凭现有证据认定是数据库安装直接造成。
- 生产路由的关键配置在 `/opt/infinite-canvas/nginx.deploy.conf` 和 Docker Compose 中，已包含在本地备份。宝塔 `vhost` 标准模板目录未作为恢复依赖纳入。

## 三、系统重装前注意事项（已执行）

1. 先把本地备份目录复制到另一块磁盘或移动硬盘，再启动重装；不要只保留单份备份。
2. 重装前从腾讯云控制台记录/导出：DNS 解析、安全组、端口放行、实例磁盘和网络配置。
3. 重装后保持职责单一：Docker 网关统一管理网站 `80/443` 路由，宝塔不要覆盖 Docker 网关配置。
4. 恢复顺序建议为：系统与 Docker → `/opt/infinite-canvas` 源码/配置 → `.env` → 画布与数据库数据 → OWUI/Chat → Hermes 运行环境与 systemd → 网关路由 → 公网回归测试。
5. 恢复后逐项验证：`hoosland.com`、`can.hoosland.com`、`owui.hoosland.com`、`chat.hoosland.com`，并检查登录、画布、数据库连接和 Hermes 网关。

## 四、当前状态

- 本地完整备份：已完成。
- 服务器：已完成系统重装并恢复服务；宝塔面板未被覆盖。
- SSH：`114.132.45.243:2222`，密钥连接已验证。

## 五、重装后恢复记录

- 新系统：OpenCloudOS 9.6，Docker 28.0.1，磁盘 220G，内存 15G。
- 宝塔保持独立运行：面板 `8888`，Bt-Panel 和 Bt-Task 均正常。
- Docker 网关继续独占网站 `80`；宝塔 Nginx 未接管 `80/443`，避免端口和配置冲突。
- 恢复的 Docker 服务：Canvas 网关、Canvas 前端、Canvas 后端、Landing、OWUI、HoosChat、两个 MySQL，共 8 个容器。
- 恢复 Hermes：
  - 工作区：`/root/hermes-workspace`
  - 配置/记忆/会话：`/root/.hermes`
  - 运行环境：`/usr/local/lib/hermes-agent`
  - systemd：`/etc/systemd/system/hermes-gateway.service`
- 为兼容宝塔原 Docker 项目路径，建立了以下软链接：
  - `/www/dk_project/dk_app/flarum` → `/www/flarum`
  - `/www/dk_project/dk_app/mysql` → `/www/mysql`
  - `/www/dk_project/dk_app/openwebui` → `/www/openwebui`
- 未恢复备份中的 `authorized_keys`，保留了重装后重新绑定的 SSH 密钥。

## 六、恢复验证结果

- `hoosland.com`、`can.hoosland.com`、`owui.hoosland.com`、`chat.hoosland.com` 公网 HTTP 均返回 `200`。
- Canvas `/api/health` 返回 `{"ok":true,"service":"infinite-canvas-server"}`。
- OWUI `/health` 返回 `{"status":true}`。
- 两个 MySQL 应用账户连接验证通过。
- Hermes systemd 为 `active/enabled`，飞书 WebSocket 已连接。
- Hermes 工作文件核对：
  - 南沙天悦海湾案例 14 个文件；
  - 马场地块案例 10 个文件；
  - 老照片修复图 39 张；
  - HTML 相册 `gallery/index.html`；
  - 6 个地产 skill、5 个 Garden skill；
  - `restore-1930s-guangzhou-restored.zip` 1 份。

## 七、OWUI 兼容性修复

- 现象：`process_filter_functions() missing 1 required positional argument: 'filter_context'`。
- 根因：`dyrnq/open-webui:main` 已要求 `filter_context`，服务器挂载的旧版 `middleware.py` 未传该参数。
- 修复：5 处调用补充 `filter_context=None`，并重启 OWUI。
- 原补丁备份：`/www/openwebui/HOOSWEBUI/openwebui_patch/middleware.py.bak-20260802-filter-context`。
- 修复后 OWUI 健康检查本机和公网均返回 `200`，新日志未再出现该错误。

## 八、遗留事项与注意

1. 当前备份只找到 1 份 Hermes 工作区 ZIP；此前提到的另外 3 份飞书发送 ZIP 不在本地生产备份中，需要从其他介质或飞书记录恢复。
2. gpt-image-2 skill、`edit.js` 和老照片修复产物已恢复；专门的历史执行链路脚本未在备份中确认。
3. Hermes memory 接近上限，自动记忆保存曾失败；这不影响工作区文件，但需要后续整理 `/root/.hermes/memories/MEMORY.md`。
4. `.env`、认证文件和数据库目录含敏感数据，交接时不要提交到公开仓库或复制到非加密介质。
5. 本地 3.3G 备份仍应复制到第二块磁盘或移动硬盘，作为独立恢复介质。

## 九、Canvas v0.11.9 故障处理

### 9.1 登录与账号切换

- 现象：登录后长时间无法进入画布；切换账号后卡在登录页或立即失去会话。
- 处理：登录成功后的画布所有权同步改为后台执行，避免 `/api/canvas/meta` 阻塞跳转；退出登录改为等待服务端会话清理完成后再进入登录页。
- 服务端继续使用单账号有效会话、会话版本和 `AUTH_EXPIRED` 错误码，账号切换时旧会话会失效。
- 当前验证：登录页返回 `200`；未登录请求 `/api/auth/me` 返回预期 `401` 和 `AUTH_EXPIRED`。

### 9.2 Grok Video 3

- 独立渠道：`ch32135fe4`。
- 模型：`grok-video-3`。
- 前端提交路径：`POST /api/ai/ch32135fe4/v1/videos`。
- 请求按渠道真实契约发送 JSON，字段包括 `duration`、`images`、`model`、`prompt`、`ratio`、`resolution`。
- 任务结果兼容读取 `output`、`url`、`result_url`、`video_url`、`metadata.url` 等字段。
- Grok 与普通 T8 图像/文本渠道已经分开，默认视频模型为 `ch32135fe4::grok-video-3`。

### 9.3 Seedance

- 独立渠道：`ch58dc87bb`，上游为 `https://api.seedance.nz`。
- 当前模型：
  - `seedance-2.0-global-fast-i2v`
  - `seedance-2.0-global-fast-multi`
  - `seedance-2.0-global-fast-t2v`
- 新协议使用 `POST /v1/videos` 创建任务，通过 `/v1/videos/:taskId` 查询状态。
- 服务端保留旧路径 `/v1/contents/generations/tasks` 的兼容转换，旧客户端请求会转换到 `/v1/videos`。
- 前端请求增加 `X-Infinite-Canvas-Model`，服务端据此校验模型是否属于当前渠道和账号权限。
- 已完成真实视频生成验证；交接回归不要自动再次提交付费生成任务。

### 9.4 签名视频跨域

- 现象：Seedance 已生成视频，但浏览器直接下载火山 TOS 签名 URL 时被 CORS 拦截，控制台显示 `net::ERR_FAILED 200 (OK)`。
- 修复：新增鉴权接口 `/api/media/proxy?url=...`，由服务端读取允许域名中的签名视频，再交给前端保存到个人工作台。
- 当前允许的输出域名包括 Volces、`aiproxy.vip` 和 `api.seedance.nz`。
- 前端代理失败时仍保留原始 URL，避免生成结果完全丢失。

### 9.5 Canvas 502 与网关动态解析

- 现象：`PUT /api/canvas` 返回 `502 Bad Gateway`；每次重建 app/backend 后都需要重启 gateway 才能恢复。
- 根因：Nginx 启动时静态解析 `app`、`backend`、`landing` 的 Docker IP，容器重建并更换 IP 后继续访问旧地址。
- 修复：`nginx.deploy.conf` 使用 Docker DNS `127.0.0.11`，通过变量动态解析三个服务名。
- 验证：不重启 gateway，再次强制重建 app/backend；两者 IP 从 `.2/.4` 实际互换为 `.4/.2`，gateway 启动时间保持不变，`/api/health` 自动恢复 `200`。
- 以后修改只读挂载的 `nginx.deploy.conf` 后，仍需强制重建 gateway 以载入新配置：

```bash
cd /opt/infinite-canvas
docker compose -f docker-compose.deploy.yml up -d --no-build --force-recreate --no-deps gateway
```

## 十、本地、生产与 GitHub 对齐

- 版本保持：`0.11.9`。
- 本地仓库：`/Users/hoosland/小浩浩/HHcanvas/infinite-canvas`。
- 生产目录：`/opt/infinite-canvas`。
- 服务器有效的 SQLite、会话、权限、AI 路由和媒体代理实现已完整同步回本地，包括：
  - `server/index.mjs`
  - `server/database.mjs`
  - `server/security.test.mjs`
  - `server/package.json` / `server/package-lock.json`
  - `server/Dockerfile`
- 本次修复相关文件已逐项核对 SHA-256，本地与生产一致。
- GitHub 私有仓库：`manhoolee/infinite-canvas-dev`。
- 分支：`agent/private-dev-initial`。
- 提交：`0c8eec26c5614f49cf6b4916d830134400dfa047`（`release: stabilize v0.11.9 production routes`）。
- 该分支与远端 `main` 是独立历史，本次没有强推 `main`，也没有创建全仓差异 PR。
- GitHub 提交地址：<https://github.com/manhoolee/infinite-canvas-dev/commit/0c8eec26c5614f49cf6b4916d830134400dfa047>。

## 十一、v0.11.9 发布验证

- 本地后端：Node 语法检查通过；安全边界与 Seedance 路由共 5 项测试通过。
- 本地前端：TypeScript `--noEmit` 与 Vite 生产构建通过。
- Nginx：本地容器配置检查和线上 `nginx -t` 均通过。
- 生产镜像：app/backend 构建成功，backend 新依赖审计为 0 个漏洞。
- 当前生产前端主资源：`index-mrONFUDv.js`。
- 当前容器：app、backend、gateway、landing 均为 healthy。
- 公网验证：
  - `http://hoosland.com/` → `200`，标题“桌子的世界 Hoosland”；
  - `http://can.hoosland.com/` → `200`，标题“浩仔无限空间”；
  - `http://can.hoosland.com/login` → `200`；
  - `http://can.hoosland.com/api/health` → `200`，返回 `{"ok":true,"service":"infinite-canvas-server"}`；
  - `http://owui.hoosland.com/` → `200`，标题“Open WebUI”。
- 发布后最近日志没有持续 5xx、后端异常或媒体代理错误。
- SQLite 发布前后 `PRAGMA integrity_check` 均为 `ok`，journal mode 为 `wal`。
- 当前生产入口是 HTTP；交接检查不要假设存在 HTTPS 接口。

## 十二、v0.11.9 备份与回滚

- 发布前服务器备份：`/opt/infinite-canvas/backups/pre-0.11.9-dns-sync-20260802-183721/`。
- `code.tgz`：约 284M，SHA-256：`135b0cc7ee6774139f7e90029af215a20a414424bbefb2841b451a1a7c836ee3`。
- `server-data.tgz`：约 544M，SHA-256：`a83fecd2d3d480442f1cd4109b761ecc9590c3a95d694582ba44aeed4dd7c055`。
- 回滚前先停止写入并再次备份当前 `server-data`；不要直接覆盖正在使用的 SQLite/WAL 文件。
- 回滚顺序：停止 app/backend → 恢复代码与 `server-data` → 重建 app/backend → 强制重建 gateway → 检查 SQLite → 验证三个公网域名。

## 十三、下一班优先检查

1. 使用普通账号与管理员账号分别执行一次登录、退出、切换账号回归，确认旧账号素材不会在新账号下继续请求；单次旧素材 `401` 可以是账号隔离的正常结果，持续出现时再排查。
2. 观察 Grok 和 Seedance 新任务的提交、轮询、结果保存与计费；已提交但状态不明的任务不要自动重复创建，避免重复扣费。
3. 给 `/api/media/proxy` 增加单次响应大小限制、并发限制和可选 Range 支持，降低大文件长期占用连接的风险。
4. 本地工作区仍有用户自己的 `.agents` 修改、`BACKUP_SCOPE.md`、`tmp/` 和 `web/src/services/api/video.ts.before-server-align`，这些内容未进入 `0c8eec2`；后续提交继续按明确文件暂存，不要执行 `git add -A`。
5. 将本地 3.3G 灾备目录和本次服务器发布备份各复制一份到独立介质。

## 十四、快速接手命令

```bash
# 登录生产服务器
ssh -i /Users/hoosland/Documents/codex.pem -p 2222 root@114.132.45.243

# 查看 Canvas 服务
cd /opt/infinite-canvas
docker ps --format '{{.Names}} {{.Status}}' | grep infinite-canvas
docker exec infinite-canvas-gateway-1 nginx -t
docker logs --since 10m infinite-canvas-gateway-1
docker logs --since 10m infinite-canvas-backend-1

# 公网只读检查
curl --connect-timeout 5 --max-time 15 http://can.hoosland.com/api/health
curl --connect-timeout 5 --max-time 15 -I http://hoosland.com/
curl --connect-timeout 5 --max-time 15 -I http://owui.hoosland.com/
```

交接时不要在聊天、文档或 GitHub 中粘贴渠道 API Key、管理员密码、`.env`、SQLite 数据或签名视频 URL。

## 十五、晚间登录同步续修

- 复核时间：2026-08-02 21:00 后。
- 复核发现：交接文档记录“登录完成后后台同步画布”，但当时生产和本地 `use-auth-store.ts` 仍在 `await bindCanvasOwner()`；登录请求成功后仍会等待 `/api/canvas/meta`、画布媒体恢复和工作台同步，文档与代码不一致。
- 同时发现生产已有按账号隔离的 `workbench-cloud-sync.ts`，认证 store 仍按旧签名调用 `syncAllWorkbenchLogs()`，会导致工作台登录同步在运行时失败；本地还缺少这组实现的图片/视频页和图片任务配套源码。
- 本轮修复：
  - 登录、注册和会话初始化在认证成功后立即返回，画布与工作台同步转为后台任务；
  - 后台任务超过 10 秒只记录警告，不再阻塞页面；账号再次切换时旧 generation 自动失效；
  - 工作台缓存按账号建立独立 IndexedDB，并通过 auth epoch 阻止旧账号任务继续写入；
  - 普通账号只同步其拥有权限的 image/video 工作台，管理员同步两类；
  - 图片页、视频页、应用同步和图片任务恢复源码与生产有效实现完成对齐；
  - 账号页、顶部账号菜单和移动端抽屉均等待服务端注销完成后再进入登录页；本地认证状态先清空，避免过期会话触发递归退出。
- 版本继续保持 `0.11.9`。
- 本地验证：TypeScript `--noEmit`、Vite 构建、后端安全与 Seedance 共 5 项测试全部通过。
- 新生产备份：`/opt/infinite-canvas/backups/pre-0.11.9-login-sync-20260802-212708/`。
  - `code.tgz` SHA-256：`9c07e647b40dbeb4f874ea9ceb9559b32a4c143394ba8214e7399390c405e059`；
  - `server-data.tgz` SHA-256：`49f8377a60aa0dbd7d98ae6c5270c2f39a6f30a3f09b4bc0ddd8d9e09e44bb9c`；
  - 备份前 SQLite 完整性为 `ok`。
- 生产前端已重建，主资源为 `index-D4QU1ANH.js`；app healthy，gateway 未重启并继续正常代理新 app。
- 发布后 `/`、`/login`、`/api/health`、`/api/auth/config` 均返回 `200`，TTFB 约 17–26ms；最近无 5xx 和后端异常，SQLite 仍为 `ok`。
- 尚需用户侧做一次真实账号验收。如仍感觉慢，只需记录：账号角色、点击登录的北京时间、浏览器、卡在登录按钮还是已经进入画布后加载慢；不要发送密码。

## 十六、登录首屏与画布媒体渐进加载修复

- 复核时间：2026-08-02 21:30 后。
- 用户真实登录日志确认：认证请求已经返回 `200`，但旧前端仍在 `/login` 引用页下请求 `/api/canvas/meta`、完整画布和数十个 `/api/canvas/files/*`；单个媒体约 0.7–4.8 MB，下载持续超过一分钟，构成登录慢的直接原因。
- 本轮修复：
  - 登录成功仅立即切换账号缓存边界，画布同步延后到认证路由完成并绘制两帧之后；退出账号仍立即清空当前画布视图；
  - 登录阶段不再同步 image/video 工作台，进入相应工作台页面后再按页面需要同步；
  - 画布登录同步只比较逐账号服务端版本戳，版本一致不下载完整项目，版本变化只获取项目元数据；
  - 删除登录阶段全画布媒体恢复，打开具体项目时优先使用当前账号的 IndexedDB 缓存，缺失媒体使用同源账号隔离 URL 在画布内渐进加载；
  - 图片和媒体 IndexedDB 缓存加入账号命名空间，账号切换时撤销旧账号 object URL；清理缓存只处理当前账号命名空间；
  - 画布媒体缓存 URL 包含账号标识，服务端校验该标识并返回私有不可变缓存头；服务端实际文件路径继续强制使用认证账号目录；
  - 画布服务端版本戳由全局单值改为逐账号持久化，避免切换账号后误用上一账号版本；
  - 登录页不再启动 5 个 jsDelivr 提示词源刷新，请求延迟到认证成功、离开登录页后执行。
- 版本继续保持 `0.11.9`。
- 本地验证：TypeScript `--noEmit`、Vite 构建、后端安全与 Seedance 共 5 项测试全部通过；新增媒体 owner 查询匹配、私有缓存头和跨账号拒绝断言。
- 生产备份：`/opt/infinite-canvas/backups/pre-0.11.9-login-progressive-20260802-214454/`。
  - `code.tgz` SHA-256：`61a05ee896320b0fbf62fbd0e14d90704a7bf60bd9cff3568c2f6c3bc82c60b9`；
  - `server-data.tgz` SHA-256：`82f73c558378522fe9dbdf3fbb06ed023a709a1129556176ae2749a1b66a0b19`；
  - 备份前后 SQLite 完整性均为 `ok`。
- 生产 app/backend 已重建，主资源为 `index-BkyagOXo.js`，四个容器均 healthy；gateway 未重启且继续正确解析重建后的容器。
- 公网 `/`、`/login`、`/api/health`、`/api/auth/config` 均为 `200`，TTFB 约 15–33 ms。Playwright 全新会话确认登录页仅有 `/api/auth/me` 和 `/api/auth/config` 两个动态请求，不再请求提示词 CDN、画布、画布媒体或工作台。
- 回滚：恢复本节备份中的代码与 `server-data`，重建 app/backend；若公网代理未自动恢复，再按第十节命令强制重建 gateway。
- 尚需现有真实账号做最终登录验收，重点观察点击登录后是否立即进入画布，以及画布媒体是否在画布内逐步出现。

## 十七、v0.12.0 账号媒体索引与差异同步

- 发布时间：2026-08-02 22:26 后；正式版本升级为 `0.12.0`。
- 服务端在现有 SQLite 增加 `media_assets` 索引表，主键为账号、作用域和 `storageKey`，记录大小、MIME、SHA-256、更新时间与内容版本。作用域分为 `canvas`、`workbench-image`、`workbench-video`，接口只返回当前登录账号有权限访问的条目。
- 启动时从现有画布文件、工作台记录和 sidecar meta 补齐索引；上传内容相同保持版本不变，大小、MIME 或哈希变化才升级版本。媒体上传响应、HEAD/GET 和画布 file-meta 都返回或携带索引信息。
- 客户端为每个账号建立独立的服务端索引快照、本地媒体指纹与同步标记。认证成功并进入画布后只后台拉取小型 `/api/media-index`；账号切换会更换数据库命名空间，并通过 owner、auth epoch 和 generation 校验阻止旧账号异步任务回写。
- 画布打开时优先复用当前账号 IndexedDB。远端版本变化或本地缺失时先用带账号和版本的同源 URL 渐进显示，再以最多 2 路并发写入本地缓存；登录页不等待媒体下载。
- 画布保存和图片/视频工作台同步先用服务端索引与本地指纹判断 `reuse`、`download`、`upload` 或 `missing`。索引一致不再读取大 Blob、逐文件 HEAD 或重复上传；只有新增、变更、缺失项计算哈希或传输。
- 首次升级对旧本地缓存采用 `storageKey + size` 快速复用，并在后台补算 SHA-256；浏览器没有 WebCrypto 时使用 `@noble/hashes` 分块计算，避免 HTTP 生产入口下无法建立指纹。
- 本地测试：服务端语法与 6 项安全/路由/数据库测试全部通过；前端 TypeScript `--noEmit` 和 Vite 生产构建通过。
- 发布前备份：`/opt/infinite-canvas/backups/pre-0.11.9-media-index-20260802-220423/`。
  - `code.tgz` SHA-256：`89df2f3bc238a49187702621f0f2e2346c7bea51930ccfd0a891e706af701ebb`；
  - `server-data.tgz` SHA-256：`34260f82dee70c93c2eba76f76ab86399503dc84c509a68e0ce0e0d1106013c3`；
  - 备份前 SQLite 完整性为 `ok`。
- 生产 app/backend 已重建，主资源为 `index-0LEYfjfv.js`；gateway 未重启并成功动态代理重建后的容器，四个容器均 healthy。
- 首次启动已为 13 个账号确认主记录并建立 164 条媒体索引：画布 119 条、图片工作台 45 条、视频工作台 0 条；现有媒体索引覆盖 3 个有媒体账号，所有条目均有 SHA-256，SQLite 完整性为 `ok`。
- 公网 `/`、`/login`、`/api/health`、`/api/auth/config` 均为 `200`，TTFB 约 18–27ms；未登录访问 `/api/media-index` 返回预期的 `401 AUTH_EXPIRED`。
- 回滚：停止写入并再次备份当前 `server-data`，恢复本节备份中的代码和数据后重建 app/backend；不要单独删除 `media_assets` 表或覆盖运行中的 SQLite/WAL。
- 尚需真实账号做一次最终体验验收：点击登录后应立即进入画布；旧媒体从本地缓存出现，只有新增、变化或缺失素材在画布内渐进加载。不要在交接信息中提供密码或渠道密钥。

## 十八、v0.12.0 登录页 `authConfig` 热修复

- 用户反馈新主资源 `index-0LEYfjfv.js` 在登录页抛出 `TypeError: authConfig is not a function`，React Router 因渲染异常进入默认错误边界。
- 根因：服务器登录页已有注册开关逻辑，会调用 `backend.authConfig()`；本地登录页仍为旧版。本次媒体索引发布只同步了本地 `backend.ts`，覆盖了服务器原有方法，形成跨文件源码漂移。
- 修复：恢复 `backend.authConfig()` 对 `/api/auth/config` 的调用，并把服务器有效登录页完整对齐回本地；以后 TypeScript 构建会直接拦截该方法缺失。
- 热修复后对 `web/src` 做了只读校验和审计，除服务器遗留的 `.bak` 文件外仍有 22 个历史源文件与本地内容不同，主要集中在画布插件、Agent、版本检查和旧页面。它们没有参与本次登录热修复，也没有被批量覆盖；后续应逐文件判定保留本地或服务器版本，再完成全量源码收口。
- 热修复备份：`/opt/infinite-canvas/backups/pre-0.12.0-authconfig-hotfix-20260802-2237/`；`files.tgz` SHA-256 为 `a94afe76ebe3e18f74ec880b27b8b38890a8ae8f63b468ee9ac0bc1001775c16`，旧 app 镜像为 `sha256:a313f1719e3c4ad5f4252098f6ce2cabf078400e7df7c01d4a189d24698a0b2f`。
- 本地服务端 6 项测试、前端 TypeScript 与生产构建均通过。生产仅重建 app，backend、SQLite 和媒体索引未改动。
- 新生产主资源：`index--DmtpZMj.js`。Playwright 全新未登录会话确认登录表单正常显示、`/api/auth/config` 返回 `200`，不再出现 `authConfig` 或 React Router 渲染错误；`/api/auth/me` 的未登录 `401` 为预期认证状态。
- 版本保持 `0.12.0`。回滚时可恢复本节备份文件并使用记录的旧 app 镜像，随后再次检查登录页；该旧镜像包含本次错误，只用于故障定位，不建议直接长期回滚。

## 十九、今日收班状态

- 收班时间：2026-08-02 22:40 后。今天的生产修改到此结束，除紧急故障外不再继续发布。
- 当前生产版本：`0.12.0`；前端主资源：`index--DmtpZMj.js`；GitHub 分支：`agent/private-dev-initial`；最后提交：`92031f00c55d72aba6313c0f2872dd9fef07d43d`。
- 当前运行状态：app、backend、gateway、landing 全部 healthy；`/login` 返回 `200`，`/api/health` 返回正常服务状态。登录页 Playwright 回归通过，注册开关接口返回 `200`。
- 今日完成：Grok Video 3 与 Seedance 独立路由和鉴权修复、签名视频同源代理、Canvas 502 网关修复、账号切换与登录首屏解阻、画布渐进加载、v0.12.0 账号媒体索引和差异同步、`authConfig` 登录回归热修复。
- 数据状态：SQLite 完整性为 `ok`；已建立 164 条媒体索引，所有现有索引均包含 SHA-256；画布与工作台数据未重建。
- 明日第一优先级：使用真实普通账号和管理员账号分别验证登录、切换账号、打开旧画布、进入图片/视频工作台，确认立即进入界面、旧缓存复用和跨账号隔离。
- 明日第二优先级：逐文件审查第十八节记录的 22 个本地/服务器历史源码差异。先确定每个文件的权威版本，再合并、测试和发布；禁止直接全量 rsync 覆盖任一端。
- 工作区仍保留用户自己的 `.agents/**`、`BACKUP_SCOPE.md`、`tmp/` 与 `web/src/services/api/video.ts.before-server-align`，今天的提交没有包含或改写这些内容。
- 如夜间出现紧急故障，先保存发生时间、账号角色、浏览器控制台首条错误和失败请求 URL；不要发送密码、Cookie、渠道 Key 或完整签名媒体地址。
