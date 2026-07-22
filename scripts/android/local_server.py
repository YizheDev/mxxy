#!/usr/bin/env python3
"""Catch-all HTTP server that logs all requests and returns success responses."""
import json, sys, time, threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

class CatchAllHandler(BaseHTTPRequestHandler):
    def log_request(self, code='-', size='-'):
        pass  # Quiet logging

    def _log(self, method):
        body = b''
        if self.headers.get('Content-Length'):
            try:
                length = int(self.headers['Content-Length'])
                body = self.rfile.read(length)
            except:
                pass
        print(f"[{time.strftime('%H:%M:%S')}] {method} {self.path} headers={dict(self.headers)} body={body[:200]}", flush=True)

    def _respond(self, data=None, code=200, content_type='application/json'):
        if data is None:
            data = {"code": 0, "message": "ok"}
        if isinstance(data, dict):
            data = json.dumps(data).encode()
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', len(data))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._log('GET')
        path = urlparse(self.path).path

        # Game config
        if 'config' in path:
            self._respond({"game_id": "g18", "status": 1, "name": "mxxy"})
        # Login
        elif 'users/by_guest' in path or 'users' in path:
            self._respond({
                "user": {
                    "id": "offline_001",
                    "token": "offline_token_" + str(int(time.time())),
                    "login_channel": "local",
                    "login_type": 1,
                    "client_username": "offline_player",
                    "display_username": "Player",
                    "nickname": "Player",
                    "avatar": "",
                    "realname_status": 1,
                    "realname_verify_status": 0,
                    "need_aas": False,
                    "detect_is_new_user": True,
                    "mobile_bind_status": 0,
                    "related_login_status": 0,
                    "need_mask": False,
                    "need_bind": 0,
                    "global_game_user_id": "offline_001"
                },
                "force_pwd": False,
                "verify_status": {"need_passwd": 0, "need_email": 0, "need_real_name": 0, "need_sms": 0}
            })
        # User info
        elif 'info' in path:
            self._respond({"user": {"id": "offline_001", "nickname": "Player"}})
        # Orders/payment
        elif 'order' in path.lower():
            self._respond({"code": 0, "order": {"status": 0, "order_id": "local_order_001"}})
        # Payment methods
        elif 'payment' in path.lower():
            self._respond({"methods": [], "code": 0})
        # Login methods
        elif 'login_method' in path.lower():
            self._respond({"methods": [{"type": "guest", "name": "Guest Login"}], "code": 0})
        # Default
        else:
            self._respond()

    def do_POST(self):
        self._log('POST')
        self.do_GET()  # Handle same way

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.end_headers()

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    server = HTTPServer(('0.0.0.0', port), CatchAllHandler)
    print(f"Local catch-all server on port {port}", flush=True)
    server.serve_forever()
