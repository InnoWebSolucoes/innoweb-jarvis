"""Pictures of the sites in the rotator.

The TV gives each site three seconds, far too short to load a real website,
so the "Our work" panel shows pictures taken here instead. server.mjs runs
this at start and every six hours:

    python -I scripts/shoot.py <out_dir>  < sites.json

sites.json is a list of {"slug": ..., "url": ...}.

Each site is visited the way a person on a computer would see it: a desktop
window, a wait until it has finished loading and its intro has played, the
cookie banner accepted, one scroll through the whole page so lazy images and
reveal animations have run, then back to the top. The picture is the first
screen and a half of the page, taken in two parts while each part is on
screen (many sites only show a section once it is scrolled to), so the TV can
scroll down it.

A picture that still looks like a loading screen is retaken; if it never comes
out right, the last good picture is kept.
"""
import json
import os
import sys
import time

from PIL import Image, ImageChops, ImageFilter, ImageStat
from playwright.sync_api import sync_playwright

W, H = 1440, 760          # a laptop browser window (1440x900 screen less the browser's bars)
TALL = 1400               # about a screen and a half of the page
ACCEPT = ['Aceitar tudo', 'Aceitar todos', 'Aceitar cookies', 'Aceitar', 'Accept all', 'Accept all cookies',
          'Accept', 'Allow all', 'Concordo', 'Got it', 'OK', 'Entendi', 'Permitir todos']


def looks_unfinished(path):
    """A loading screen: one flat colour with a little text or a counter."""
    im = Image.open(path).convert('L').crop((0, 0, W, H)).resize((288, 168))
    hist = im.point(lambda v: v // 8).histogram()[:32]
    detail = ImageStat.Stat(im.filter(ImageFilter.FIND_EDGES)).mean[0]
    # Almost all one shade and almost no edges: a logo or counter on a plain screen.
    return max(hist) > 0.95 * sum(hist) and detail < 4


def still_moving(page):
    """Two frames a second apart that differ a lot: an intro is still playing."""
    a = page.screenshot(type='png')
    time.sleep(1.0)
    b = page.screenshot(type='png')
    from io import BytesIO
    ia = Image.open(BytesIO(a)).convert('L').resize((180, 105))
    ib = Image.open(BytesIO(b)).convert('L').resize((180, 105))
    return ImageStat.Stat(ImageChops.difference(ia, ib)).mean[0] > 18


def accept_cookies(page):
    for label in ACCEPT:
        try:
            btn = page.get_by_role('button', name=label, exact=True)
            if btn.count() and btn.first.is_visible():
                btn.first.click(timeout=1500)
                time.sleep(0.6)
                return
        except Exception:
            pass


def visit(page, url, patience):
    page.goto(url, wait_until='load', timeout=45000)
    try:
        page.wait_for_load_state('networkidle', timeout=15000)
    except Exception:
        pass
    time.sleep(patience)
    # Let an intro or loader finish (a hero video keeps moving, so give up after a while).
    for _ in range(6):
        if not still_moving(page):
            break
        time.sleep(1.5)
    accept_cookies(page)
    # One pass down the page with the mouse wheel (smooth-scroll libraries listen
    # to the wheel), so every lazy image and reveal animation runs.
    height = page.evaluate('document.documentElement.scrollHeight') or H
    y = 0
    while y < min(height, 6000):
        page.mouse.wheel(0, 500)
        y += 500
        time.sleep(0.3)
    time.sleep(1)
    # Back to the top the same way. Smooth-scroll libraries ignore a plain
    # scrollTo, so wheel up first, then make sure.
    for _ in range(40):
        if page.evaluate('window.scrollY || document.documentElement.scrollTop || 0') < 5:
            break
        page.mouse.wheel(0, -1500)
        time.sleep(0.25)
    page.evaluate('window.scrollTo(0, 0)')
    time.sleep(2.5)
    accept_cookies(page)


def capture(page, path):
    """The top screen, then the next part scrolled into view, joined into one."""
    from io import BytesIO
    parts = [(0, Image.open(BytesIO(page.screenshot(type='png'))))]
    page.mouse.wheel(0, TALL - H)
    time.sleep(2)
    y = page.evaluate('Math.round(window.scrollY || document.documentElement.scrollTop || 0)')
    # A page that moved much further than asked has a pinned, scroll-driven
    # section; its second part would not join the first, so keep only the top.
    if 60 < y < (TALL - H) + 150:
        # Fixed headers and floating buttons would show twice; hide them for part two.
        page.evaluate("""() => { for (const el of document.querySelectorAll('body *')) {
          const cs = getComputedStyle(el);
          if ((cs.position === 'fixed' || cs.position === 'sticky') && el.getBoundingClientRect().height < 220) el.style.visibility = 'hidden';
        } }""")
        time.sleep(0.4)
        parts.append((y, Image.open(BytesIO(page.screenshot(type='png')))))
    out = Image.new('RGB', (W, parts[-1][0] + H))
    for top, im in parts:
        out.paste(im.convert('RGB'), (0, top))
    out.save(path, 'JPEG', quality=80)


def save_small(path, width=960):
    """A smaller copy, resized here with a high-quality filter, for screens that
    show the picture small (a TV browser shrinks big images poorly)."""
    im = Image.open(path).convert('RGB')
    small = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    small.save(path[:-4] + '.960.jpg', 'JPEG', quality=86)


def shoot(ctx, s, out):
    final = os.path.join(out, s['slug'] + '.jpg')
    tmp = os.path.join(out, s['slug'] + '.tmp.jpg')
    for attempt, patience in enumerate((6, 12, 20)):
        page = ctx.new_page()
        try:
            visit(page, s['url'], patience)
            capture(page, tmp)
            if not looks_unfinished(tmp):
                os.replace(tmp, final)
                save_small(final)
                return 'ok'
        except Exception as err:
            print('retry', s['slug'], str(err).splitlines()[0][:120], flush=True)
        finally:
            page.close()
    if os.path.exists(tmp):
        os.remove(tmp)
    return 'kept' if os.path.exists(final) else 'fail'


def main():
    out = sys.argv[1]
    sites = json.load(sys.stdin)
    # Innolink pages are never opened: every visit counts as an open on the client's stats.
    sites = [d for d in sites if 'innolink.info' not in str(d.get('url', '')).lower()]
    os.makedirs(out, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='msedge')
        ctx = browser.new_context(viewport={'width': W, 'height': H}, device_scale_factor=1, locale='pt-PT')
        for s in sites:
            print(shoot(ctx, s, out), s['slug'], flush=True)
        browser.close()


if __name__ == '__main__':
    main()
