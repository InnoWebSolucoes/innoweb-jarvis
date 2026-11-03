"""Client replies of the last half hour, for the TV to say out loud while the
Jarvis PC is off (with it on, the PC says them). The same code Jarvis runs
(scripts/leadstats.py, copied to lib/ when the site is published), reading the
lead finder's database read-only. Each reply comes with its sentence signed, so
/api/say voices it and nothing else. Only a logged-in screen (the jarvis
cookie, as api/_auth.js) can read it."""
import hmac
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from http.server import BaseHTTPRequestHandler

import psycopg

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lib'))
import leadstats  # noqa: E402


def authed(headers):
    secret, password = os.environ.get('RELAY_SECRET', ''), os.environ.get('JARVIS_PASSWORD', '')
    m = re.search(r'(?:^|;\s*)jarvis=([a-f0-9]{64})', headers.get('cookie', ''))
    return bool(m and password and hmac.compare_digest(m.group(1), hmac.new(secret.encode(), password.encode(), sha256).hexdigest()))


def say_sig(text):
    return hmac.new(os.environ.get('RELAY_SECRET', '').encode(), ('say:' + text).encode('utf-8'), sha256).hexdigest()[:32]


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if not authed(self.headers):
            self.send_response(401)
            self.end_headers()
            return
        try:
            since = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()
            with psycopg.connect(os.environ['LEAD_DB_URL'], autocommit=True, connect_timeout=10, prepare_threshold=None) as c:
                c.execute('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY')
                replies = leadstats.replies_since(lambda sql, *a: c.execute(sql, a or None).fetchall(), since)
            body = {'ok': True, 'replies': [{**r, 'sig': say_sig(r['sentence'])} for r in replies]}
        except Exception as err:
            body = {'ok': False, 'error': str(err).splitlines()[0][:200] if str(err) else type(err).__name__}
        data = json.dumps(body, default=str).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)
