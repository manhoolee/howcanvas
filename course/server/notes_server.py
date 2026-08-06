#!/usr/bin/env python3
"""
轻量后端: 共享意见栏
- GET  /api/notes            -> 读所有意见
- POST /api/notes            -> 加一条意见
- DELETE /api/notes?id=<id>  -> 删一条
"""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

NOTES_FILE = '/var/lib/hoosland/notes_log.json'  # 2026-07-07 systemd 化，迁到 /var/lib
PORT = 2988


def load_notes():
    if not os.path.exists(NOTES_FILE):
        return []
    try:
        with open(NOTES_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return []


def save_notes(notes):
    with open(NOTES_FILE, 'w', encoding='utf-8') as f:
        json.dump(notes, f, ensure_ascii=False, indent=2)


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send_json(204, {})

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/api/notes':
            self._send_json(200, load_notes())
        else:
            self._send_json(404, {'error': 'not found'})

    def do_POST(self):
        path = urlparse(self.path).path
        if path != '/api/notes':
            return self._send_json(404, {'error': 'not found'})

        length = int(self.headers.get('Content-Length', 0))
        try:
            raw = self.rfile.read(length).decode('utf-8')
            note = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            return self._send_json(400, {'error': 'bad json'})

        # 校验必要字段
        for k in ('id', 'slide', 'page', 'time', 'text'):
            if k not in note:
                return self._send_json(400, {'error': 'missing field: ' + k})

        notes = load_notes()
        # 防重复 (同 id 不重复加)
        if not any(n.get('id') == note['id'] for n in notes):
            notes.append(note)
            save_notes(notes)
        return self._send_json(200, {'ok': True, 'count': len(notes)})

    def do_DELETE(self):
        qs = parse_qs(urlparse(self.path).query)
        nid = qs.get('id', [''])[0]
        if not nid:
            return self._send_json(400, {'error': 'missing id'})

        notes = load_notes()
        before = len(notes)
        notes = [n for n in notes if n.get('id') != nid]
        save_notes(notes)
        return self._send_json(200, {'ok': True, 'removed': before - len(notes)})

    def log_message(self, fmt, *args):
        # 静默, 避免日志噪音
        return


if __name__ == '__main__':
    print(f'意见共享服务已启动: 端口 {PORT}, 文件: {NOTES_FILE}')
    ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
