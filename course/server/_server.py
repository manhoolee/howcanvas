#!/usr/bin/env python3
import http.server
import socketserver
import sys
import os
import urllib.request
import urllib.parse
import json

PORT = 2987
NOTES_BACKEND = 'http://127.0.0.1:2988'

COURSE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
os.chdir(COURSE_DIR)

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        # CORS for direct /api/notes access (e.g. from a different origin)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        super().end_headers()

    def guess_type(self, path):
        if path.endswith('.html'):
            return 'text/html; charset=utf-8'
        if path.endswith('.js'):
            return 'application/javascript; charset=utf-8'
        if path.endswith('.css'):
            return 'text/css; charset=utf-8'
        if path.endswith('.json'):
            return 'application/json; charset=utf-8'
        return super().guess_type(path)

    def _proxy_notes(self, method):
        """Forward /api/notes requests to the notes_server on 2988."""
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length) if length else None
        url = NOTES_BACKEND + self.path
        req = urllib.request.Request(url, data=body, method=method)
        # forward Content-Type
        ct = self.headers.get('Content-Type')
        if ct:
            req.add_header('Content-Type', ct)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                resp_body = resp.read()
                self.send_response(resp.status)
                self.send_header('Content-Type', resp.headers.get('Content-Type', 'application/json; charset=utf-8'))
                self.send_header('Content-Length', str(len(resp_body)))
                self.end_headers()
                self.wfile.write(resp_body)
        except Exception as e:
            err = json.dumps({'error': str(e)}).encode('utf-8')
            self.send_response(502)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(err)))
            self.end_headers()
            self.wfile.write(err)

    def do_OPTIONS(self):
        if self.path.startswith('/api/notes'):
            return self._proxy_notes('OPTIONS')
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        if self.path.startswith('/api/notes'):
            return self._proxy_notes('GET')
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith('/api/notes'):
            return self._proxy_notes('POST')
        return super().do_POST()

    def do_DELETE(self):
        if self.path.startswith('/api/notes'):
            return self._proxy_notes('DELETE')
        return super().do_DELETE()


class ReuseServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True  # 子线程随主线程退出

if __name__ == '__main__':
    try:
        with ReuseServer(("0.0.0.0", PORT), Handler) as httpd:
            sys.stderr.write(f"Serving on port {PORT} (with /api/notes proxy to 2988)\n")
            sys.stderr.flush()
            httpd.serve_forever()
    except OSError as e:
        sys.stderr.write(f"Error: {e}\n")
        sys.exit(1)
