#!/usr/bin/env python3
"""Dev server for Larder: static files with `Cache-Control: no-cache` so the
browser always revalidates (python's plain http.server sends no cache headers,
which lets browsers serve stale JS during development).

Usage: python3 tools/serve.py [port] [directory]
"""
import functools
import http.server
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def log_message(self, *args):
        pass  # keep the console quiet


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
directory = sys.argv[2] if len(sys.argv) > 2 else '.'
server = http.server.ThreadingHTTPServer(('', port), functools.partial(Handler, directory=directory))
print(f'Serving {directory} on http://localhost:{port}')
server.serve_forever()
