"""The lead finder's figures for the live site while the Jarvis PC is off: the
same code Jarvis runs on the PC (scripts/leadstats.py, copied to lib/ when the
site is published), reading the lead finder's database read-only. Only the
live site's own relay calls it (it sends RELAY_SECRET)."""
import hmac
import json
import os
import sys
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lib'))
import leadstats  # noqa: E402


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        secret = os.environ.get('RELAY_SECRET', '')
        if not secret or not hmac.compare_digest(self.headers.get('x-jarvis-relay', ''), secret):
            self.send_response(403)
            self.end_headers()
            return
        try:
            body = json.dumps(leadstats.collect(os.environ['LEAD_DB_URL']), default=str)
        except Exception as err:  # the relay keeps the last saved figures for this part
            body = json.dumps({'ok': False, 'error': str(err).splitlines()[0][:200]})
        data = body.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)
