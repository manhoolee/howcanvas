#!/bin/bash
# 启动 HTML 主 server (2987) + 意见 API server (2988)
# 两者都用 setsid 启动, 完全脱离 session
cd /root/workspace/output

# 杀掉旧进程
pkill -f "_server.py" 2>/dev/null
pkill -f "notes_server.py" 2>/dev/null
sleep 0.5

# 启动 notes server (先启动, 主 server 依赖它)
setsid python3 notes_server.py > notes_server.log 2>&1 < /dev/null &
sleep 0.5

# 启动主 server
setsid python3 _server.py > _server.log 2>&1 < /dev/null &

sleep 1
echo "=== 进程 ==="
ps aux | grep -E "(_server|notes_server)" | grep -v grep | head -10
echo ""
echo "=== 2987 主 server /api/notes ==="
curl -s http://127.0.0.1:2987/api/notes
echo ""
echo "=== 2987 HTML ==="
curl -sI http://127.0.0.1:2987/AI_120min_分享_v4.html | head -1
