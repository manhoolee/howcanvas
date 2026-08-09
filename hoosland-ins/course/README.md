# AIV4 离线包

将 `AIV4.html`（AI 辅助方案工作 120 分钟分享 v4）打包成可独立运行的目录，含前端 HTML、assets、留言系统后端。

## 目录结构

    AIV4_bundle/
    ├─ index.html              # 主交付物（相对路径指向 assets/）
    ├─ assets/                 # 主交付物引用的 9 个图片/SVG
    └─ server/
       ├─ run_servers.sh       # 一键启动 2987 (HTML) + 2988 (留言 API)
       ├─ _server.py           # 端口 2987：静态文件 + /api/notes 反代到 2988
       └─ notes_server.py      # 端口 2988：意见共享后端（读/写/删 JSON 文件）

## 启动

    cd server
    ./run_servers.sh

脚本会：

1. `pkill -f "_server.py"` 和 `pkill -f "notes_server.py"` 杀掉旧进程。
2. `setsid python3 notes_server.py` —— 留言 API（端口 2988，写到 `/var/lib/hoosland/notes_log.json`）。
3. `setsid python3 _server.py` —— 主 server（端口 2987，根目录切换为 `../`，对外提供静态资源 + 反代 `/api/notes`）。
4. 最后打印进程和 curl 自检结果。

## 端口与依赖

- 2987：HTML + assets（`SimpleHTTPRequestHandler`，从 `../` 暴露 `index.html`）。
- 2988：意见 API（`ThreadingHTTPServer`，独立 JSON 文件存储，不依赖数据库）。
- 仅依赖 Python 3 标准库（`http.server`、`socketserver`、`urllib`、`json`）。
- 留言存储路径在 `notes_server.py` 顶部：`NOTES_FILE = '/var/lib/hoosland/notes_log.json'`。如需变更，编辑该常量后重启 `notes_server.py`。

## 在浏览器打开

- 本机访问：http://127.0.0.1:2987/
- 局域网/公网：将 2987 端口在防火墙放通（`run_servers.sh` 监听 `0.0.0.0`）。

## 客户端关键调用

    const NOTES_API = '/api/notes';
    fetch(NOTES_API)                                  // 读
    fetch(NOTES_API, { method: 'POST', body: ... })   // 写
    fetch(NOTES_API + '?id=...', { method: 'DELETE' })// 删

所有跨域请求已配置 CORS（`*`，`GET/POST/DELETE/OPTIONS`）。
