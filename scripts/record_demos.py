"""Short films of our demo sites, for the TV's "Our work" panel.

The TV's browser is from 2017 and can't run today's websites, so the PC opens
each site in a modern browser (Edge), lets it finish loading and play its
intro, then films a slow scroll down the real page. The TV plays the films.

    python -I scripts/record_demos.py <out_dir>  < demos.json

demos.json is a list of {"slug": ..., "url": ...}. Each film is <slug>.webm
(VP8, which the TV's old browser plays; 1280x720, about 10 seconds, no sound). Sites already filmed in the
last week are skipped, so this can run again and again.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

from playwright.sync_api import sync_playwright

W, H = 1280, 720
SCROLL_SECONDS = 10
FRESH_DAYS = 7
ACCEPT = ['Aceitar tudo', 'Aceitar todos', 'Aceitar cookies', 'Aceitar', 'Accept all', 'Accept all cookies',
          'Accept', 'Allow all', 'Concordo', 'Got it', 'OK', 'Entendi', 'Permitir todos']


def accept_cookies(page):
    for label in ACCEPT:
        try:
            btn = page.get_by_role('button', name=label, exact=True)
            if btn.count() and btn.first.is_visible():
                btn.first.click(timeout=1500)
                time.sleep(0.5)
                return
        except Exception:
            pass


def film(browser, url, out_path):
    tmp = tempfile.mkdtemp(prefix='jarvis-film-')
    try:
        ctx = browser.new_context(viewport={'width': W, 'height': H}, record_video_dir=tmp,
                                  record_video_size={'width': W, 'height': H}, locale='en-IE')
        page = ctx.new_page()
        born = time.time()
        page.goto(url, wait_until='load', timeout=45000)
        try:
            page.wait_for_load_state('networkidle', timeout=12000)
        except Exception:
            pass
        time.sleep(5)   # intros, loaders and hero videos settle
        accept_cookies(page)
        time.sleep(0.8)
        start = time.time() - born
        # A slow, even scroll with the mouse wheel (smooth-scroll libraries follow it).
        end = time.time() + SCROLL_SECONDS
        while time.time() < end:
            page.mouse.wheel(0, 7)
            time.sleep(0.033)
        video = page.video
        ctx.close()   # finishes the recording
        raw = video.path()
        # Keep only the scroll, as a VP8 film the TV's browser can play.
        part = out_path + '.part.webm'
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-ss', f'{start:.2f}', '-i', raw, '-t', str(SCROLL_SECONDS),
                        '-vf', f'scale={W}:{H},fps=30', '-c:v', 'libvpx', '-b:v', '1600k', '-crf', '10', '-deadline', 'good',
                        '-cpu-used', '4', '-auto-alt-ref', '0', '-an', part], check=True)
        os.replace(part, out_path)
        return True
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    demos = json.load(sys.stdin)
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='msedge')
        for d in demos:
            path = os.path.join(out, d['slug'] + '.webm')
            if os.path.exists(path) and time.time() - os.path.getmtime(path) < FRESH_DAYS * 86400:
                continue
            try:
                film(browser, d['url'], path)
                print('ok', d['slug'], flush=True)
            except Exception as err:   # one site that won't load must not stop the rest
                print('fail', d['slug'], str(err).splitlines()[0][:150], flush=True)
        browser.close()


if __name__ == '__main__':
    main()
