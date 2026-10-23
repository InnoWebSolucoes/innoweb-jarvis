"""Jarvis's WhatsApp: WhatsApp Web in a hidden browser on this PC, linked once
with a QR code, reading the Innoweb group chat so the TV can show it.

    python -u scripts/whatsapp_bridge.py <profile dir> <group name>

server.mjs starts it and reads one JSON object per line from it:
  {"type": "status", "state": "starting|qr|ready|error", "detail": ...}
  {"type": "qr", "png": <base64>}              while the phone still has to scan
  {"type": "chat", "name": ..., "messages": [{"from", "text", "time", "mine"}]}
                                               the group's latest messages, when they change

It only reads: it opens the group chat and never types anything.
"""
import base64
import hashlib
import json
import re
import sys
import time

from playwright.sync_api import sync_playwright

WEB = 'https://web.whatsapp.com'
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
      'Chrome/130.0.0.0 Safari/537.36')
QR = "div[data-ref] canvas, canvas[aria-label*='Scan']"
CHATS = "#pane-side, div[aria-label='Chat list'], div[aria-label='Chats']"
PROFILE, GROUP = sys.argv[1], sys.argv[2]

# Each message row carries "[10:47, 23/10/2026] Name: " in data-pre-plain-text.
READ = """() => [...document.querySelectorAll('#main [data-pre-plain-text]')].slice(-30).map(el => {
  const pre = el.getAttribute('data-pre-plain-text') || '';
  const m = pre.match(/^\\[([^\\]]+)\\]\\s*([^:]+):/);
  const row = el.closest('.message-out, .message-in');
  const text = (el.querySelector('span.selectable-text') || el).innerText.trim();
  return { time: m ? m[1].split(',')[0] : '', from: m ? m[2].trim() : '', text, mine: !!(row && row.classList.contains('message-out')) };
}).filter(m => m.text)"""


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def open_group(page):
    """Open the group by name (a chat whose name contains it will do)."""
    titles = page.locator('#pane-side span[title]').evaluate_all('els => els.map(e => e.getAttribute("title"))')
    near = [t for t in titles if t and GROUP.lower() in t.lower()]
    if not near:
        return None
    page.locator(f"#pane-side span[title='{near[0]}']").first.click()
    page.wait_for_selector('#main', timeout=15000)
    return near[0]


def main():
    emit({'type': 'status', 'state': 'starting'})
    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(PROFILE, channel='msedge', headless=True, user_agent=UA,
                                                    locale='en-IE', viewport={'width': 1280, 'height': 900})
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(WEB, wait_until='domcontentloaded', timeout=60000)
        state, last_qr, chat, last_msgs = None, None, None, None
        while True:
            try:
                qr = page.locator(QR)
                if qr.count() and qr.first.is_visible():
                    if state != 'qr':
                        state = 'qr'
                        emit({'type': 'status', 'state': 'qr'})
                    box = qr.first.locator('xpath=..')
                    png = (box if box.count() else qr.first).screenshot()
                    h = hashlib.md5(png).hexdigest()
                    if h != last_qr:
                        last_qr = h
                        emit({'type': 'qr', 'png': base64.b64encode(png).decode()})
                    time.sleep(2)
                    continue
                if not page.locator(CHATS).count():
                    time.sleep(2)
                    continue
                if state != 'ready':
                    state, chat = 'ready', None
                    emit({'type': 'status', 'state': 'ready'})
                if not chat:
                    chat = open_group(page)
                    emit({'type': 'status', 'state': 'ready', 'detail': f'reading "{chat}"' if chat else f'no chat called "{GROUP}"'})
                    if not chat:
                        time.sleep(15)
                        continue
                msgs = page.evaluate(READ)
                key = json.dumps(msgs[-12:], ensure_ascii=False)
                if key != last_msgs:
                    last_msgs = key
                    emit({'type': 'chat', 'name': chat, 'messages': msgs[-12:]})
                time.sleep(3)
            except Exception as err:
                emit({'type': 'status', 'state': 'error', 'detail': str(err).splitlines()[0][:200]})
                time.sleep(5)
                try:
                    page.goto(WEB, wait_until='domcontentloaded', timeout=60000)
                    chat = None
                except Exception:
                    pass


if __name__ == '__main__':
    main()
