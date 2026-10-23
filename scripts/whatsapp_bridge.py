"""Jarvis's WhatsApp: WhatsApp Web in a hidden browser on this PC, linked once
with a QR code. It keeps the Innoweb group open so new messages can be
announced, and when the TV is showing WhatsApp it sends pictures of the whole
WhatsApp screen and moves around when asked: open a chat, scroll, go back to
the chat list. It only looks: it never writes in a chat.

    python -u scripts/whatsapp_bridge.py <profile dir> <group name>

server.mjs starts it and reads one JSON object per line from it:
  {"type": "status", "state": "starting|qr|ready|error", "detail": ...}
  {"type": "qr", "png": <base64>}              while the phone still has to scan
  {"type": "chat", "name": ..., "messages": [{"from", "text", "time", "mine"}]}
                                               the group's latest messages, when they change
  {"type": "screen", "jpg": <base64>}          the whole WhatsApp screen, while the TV watches
  {"type": "done", "id": ..., "ok": true|false, "detail": ...}
                                               the result of a command

and takes one command per line on stdin:
  {"cmd": "watch", "on": true|false}           the TV started or stopped showing WhatsApp
  {"id": ..., "cmd": "open", "name": ...}      open the chat whose name best matches
  {"id": ..., "cmd": "scroll", "dir": "up|down", "where": "chat|list"}
  {"id": ..., "cmd": "list"}                   close the open chat (back to the chat list)
"""
import base64
import difflib
import hashlib
import json
import queue
import re
import sys
import threading
import time

from playwright.sync_api import sync_playwright

WEB = 'https://web.whatsapp.com'
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
      'Chrome/130.0.0.0 Safari/537.36')
QR = "div[data-ref] canvas, canvas[aria-label*='Scan']"
CHATS = "#pane-side, div[aria-label='Chat list'], div[aria-label='Chats']"
SEARCH = "#side div[contenteditable='true'], div[contenteditable='true'][data-tab='3']"
PROFILE, GROUP = sys.argv[1], sys.argv[2]

# Each message row carries "[10:47, 23/10/2026] Name: " in data-pre-plain-text.
READ = """() => [...document.querySelectorAll('#main [data-pre-plain-text]')].slice(-30).map(el => {
  const pre = el.getAttribute('data-pre-plain-text') || '';
  const m = pre.match(/^\\[([^\\]]+)\\]\\s*([^:]+):/);
  const row = el.closest('.message-out, .message-in');
  const text = (el.querySelector('span.selectable-text') || el).innerText.trim();
  return { time: m ? m[1].split(',')[0] : '', from: m ? m[2].trim() : '', text, mine: !!(row && row.classList.contains('message-out')) };
}).filter(m => m.text)"""
OPEN_CHAT = """() => { const h = document.querySelector('#main header span[title], #main header span[dir="auto"]'); return h ? (h.getAttribute('title') || h.innerText || '').trim() : ''; }"""


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


commands = queue.Queue()


def read_stdin():
    for line in sys.stdin:
        try:
            commands.put(json.loads(line))
        except ValueError:
            pass


# A chat's name is the first titled span in its row (the others are the last message's preview).
NAMES = """() => [...document.querySelectorAll('#pane-side [role="listitem"], #pane-side [role="row"]')]
  .map(r => { const s = r.querySelector('span[title]'); return s ? s.getAttribute('title') : ''; })"""
PICK = """(t) => { for (const r of document.querySelectorAll('#pane-side [role="listitem"], #pane-side [role="row"]')) {
  const s = r.querySelector('span[title]');
  if (s && s.getAttribute('title') === t) { s.setAttribute('data-jarvis-pick', '1'); return true; } } return false; }"""
BIDI = re.compile('[‎‏‪-‮⁦-⁩]')


def clean(title):
    return BIDI.sub('', title or '').strip()


def chat_titles(page):
    return [t for t in page.evaluate(NAMES) if t]


def best_match(name, titles):
    n = name.lower().strip()
    if not n:
        return None
    exact = [t for t in titles if clean(t).lower() == n]
    if exact:
        return exact[0]
    starts = [t for t in titles if clean(t).lower().startswith(n)]
    if starts:
        return starts[0]
    near = [t for t in titles if n in clean(t).lower()]
    if near:
        return near[0]
    close = difflib.get_close_matches(n, [clean(t).lower() for t in titles], n=1, cutoff=0.5)
    return next((t for t in titles if close and clean(t).lower() == close[0]), None)


def open_chat(page, name):
    """Open the chat whose name best matches: from the list if it's there, else by searching for it."""
    title = best_match(name, chat_titles(page))
    searched = False
    if not title:
        page.locator(SEARCH).first.click()
        page.keyboard.press('Control+A')
        page.keyboard.type(name, delay=20)
        time.sleep(1.8)
        searched = True
        title = best_match(name, chat_titles(page))
    if title and page.evaluate(PICK, title):
        page.locator('[data-jarvis-pick]').first.click()
        page.evaluate("() => document.querySelectorAll('[data-jarvis-pick]').forEach(e => e.removeAttribute('data-jarvis-pick'))")
        page.wait_for_selector('#main', timeout=15000)
    else:
        title = None
    if searched:
        # Clear the search box so the full chat list comes back.
        page.locator(SEARCH).first.click()
        page.keyboard.press('Control+A')
        page.keyboard.press('Backspace')
    return clean(title) if title else None


def scroll(page, direction, where):
    use_chat = where != 'list' and page.locator('#main').count()
    box = page.locator('#main' if use_chat else '#pane-side').first.bounding_box()
    if not box:
        return False
    page.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
    page.mouse.wheel(0, -700 if direction == 'up' else 700)
    return True


def run_command(page, c, watch):
    kind = c.get('cmd')
    if kind == 'watch':
        watch['on'] = bool(c.get('on'))
        return None
    if kind == 'open':
        title = open_chat(page, c.get('name', ''))
        return (True, title) if title else (False, f'no chat called "{c.get("name", "")}"')
    if kind == 'scroll':
        return scroll(page, c.get('dir', 'down'), c.get('where', 'chat')), ''
    if kind == 'list':
        page.keyboard.press('Escape')
        return True, ''
    return False, f'unknown command {kind}'


def main():
    threading.Thread(target=read_stdin, daemon=True).start()
    emit({'type': 'status', 'state': 'starting'})
    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(PROFILE, channel='msedge', headless=True, user_agent=UA,
                                                    locale='en-IE', viewport={'width': 1440, 'height': 810})
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(WEB, wait_until='domcontentloaded', timeout=60000)
        state, last_qr, group, last_msgs = None, None, None, None
        watch = {'on': False, 'shot': 0, 'last': None, 'until': 0}
        last_read = 0
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
                    state, group = 'ready', None
                    emit({'type': 'status', 'state': 'ready'})

                # Moves asked for from the TV.
                while not commands.empty():
                    c = commands.get()
                    try:
                        res = run_command(page, c, watch)
                    except Exception as err:
                        res = (False, str(err).splitlines()[0][:160])
                    if res is not None and c.get('id') is not None:
                        emit({'type': 'done', 'id': c['id'], 'ok': bool(res[0]), 'detail': res[1]})
                    watch['until'] = time.time() + 120   # stay where they left it for a while
                    watch['shot'] = 0

                current = clean(page.evaluate(OPEN_CHAT)) if page.locator('#main').count() else ''
                # When nobody is looking, go back to the group so its messages are followed.
                if not watch['on'] and time.time() > watch['until'] and (not group or current != group):
                    group = open_chat(page, GROUP)
                    emit({'type': 'status', 'state': 'ready', 'detail': f'reading "{group}"' if group else f'no chat called "{GROUP}"'})
                    current = group or ''
                    if not group:
                        time.sleep(15)
                        continue

                # The group's messages, when it is the chat that's open.
                if group and current == group and time.time() - last_read > 3:
                    last_read = time.time()
                    msgs = page.evaluate(READ)
                    key = json.dumps(msgs[-12:], ensure_ascii=False)
                    if key != last_msgs:
                        last_msgs = key
                        emit({'type': 'chat', 'name': group, 'messages': msgs[-12:]})

                # Pictures of the whole screen while the TV shows WhatsApp.
                if watch['on'] and time.time() - watch['shot'] > 0.8:
                    watch['shot'] = time.time()
                    jpg = page.screenshot(type='jpeg', quality=70)
                    h = hashlib.md5(jpg).hexdigest()
                    if h != watch['last']:
                        watch['last'] = h
                        emit({'type': 'screen', 'jpg': base64.b64encode(jpg).decode()})
                time.sleep(0.2 if watch['on'] else 1)
            except Exception as err:
                emit({'type': 'status', 'state': 'error', 'detail': str(err).splitlines()[0][:200]})
                time.sleep(5)
                try:
                    page.goto(WEB, wait_until='domcontentloaded', timeout=60000)
                    group = None
                except Exception:
                    pass


if __name__ == '__main__':
    main()
