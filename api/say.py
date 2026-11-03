"""Jarvis's voice while the Jarvis PC is off: one sentence /api/replies signed,
voiced with the same voice the PC uses (edge-tts), as an mp3 with its length
(a TV can't tell when a sound without one has ended). No login cookie needed (a
TV's media player doesn't send it); the signature is the permission."""
import asyncio
import hmac
import os
from hashlib import sha256
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

import edge_tts

VOICE = os.environ.get('JARVIS_VOICE', 'en-US-AvaMultilingualNeural')


async def voiced(text):
    out = bytearray()
    async for chunk in edge_tts.Communicate(text, VOICE).stream():
        if chunk['type'] == 'audio':
            out += chunk['data']
    return bytes(out)


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        q = parse_qs(urlparse(self.path).query)
        text, sig = (q.get('text') or [''])[0][:400], (q.get('sig') or [''])[0]
        want = hmac.new(os.environ.get('RELAY_SECRET', '').encode(), ('say:' + text).encode('utf-8'), sha256).hexdigest()[:32]
        if not text or not hmac.compare_digest(sig, want):
            self.send_response(403)
            self.end_headers()
            return
        try:
            data = asyncio.run(voiced(text))
        except Exception:
            data = b''
        if not data:   # the TV falls back to its own voice
            self.send_response(502)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header('Content-Type', 'audio/mpeg')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Accept-Ranges', 'none')
        self.send_header('Cache-Control', 'public, max-age=86400')
        self.end_headers()
        self.wfile.write(data)
