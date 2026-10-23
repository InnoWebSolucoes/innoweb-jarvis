# Jarvis's voice, kept warm: one long-running process instead of starting Python
# for every answer. Reads one JSON request per line on stdin:
#   {"id": "12", "text": "...", "voice": "en-US-AvaMultilingualNeural"}
# and writes JSON lines back:
#   {"id": "12", "chunk": "<base64 mp3>"} ... then {"id": "12", "done": true}
#   or {"id": "12", "error": "..."}
# Each sentence is voiced at the same time as the others (Edge's voice service
# takes a few seconds per request, whatever the length), and the sound is sent
# in order as soon as it arrives, so the TV can start playing the first
# sentence while the rest are still coming.
import asyncio, base64, json, re, sys

import edge_tts

out_lock = asyncio.Lock()


async def emit(obj):
    async with out_lock:
        sys.stdout.write(json.dumps(obj) + '\n')
        sys.stdout.flush()


def sentences(text):
    parts = [p.strip() for p in re.split(r'(?<=[.!?])\s+', text.strip()) if p.strip()]
    # Very short bits ride along with the next sentence, so the voice doesn't sound chopped.
    merged = []
    for p in parts:
        if merged and len(merged[-1]) < 25:
            merged[-1] += ' ' + p
        else:
            merged.append(p)
    return merged or [text]


async def voice_one(text, voice, queue):
    try:
        for attempt in range(2):
            got = False
            try:
                async for chunk in edge_tts.Communicate(text, voice).stream():
                    if chunk['type'] == 'audio':
                        got = True
                        await queue.put(chunk['data'])
                break
            except edge_tts.exceptions.NoAudioReceived:
                if got or attempt:
                    raise
    except Exception as err:
        await queue.put(err)
    await queue.put(None)


async def handle(req):
    rid, voice = str(req['id']), req.get('voice') or 'en-US-AvaMultilingualNeural'
    queues = []
    for s in sentences(req.get('text', '')):
        q = asyncio.Queue()
        queues.append(q)
        asyncio.ensure_future(voice_one(s, voice, q))
    sent = False
    for q in queues:
        while True:
            item = await q.get()
            if item is None:
                break
            if isinstance(item, Exception):
                # Nothing sent yet: let the server fall back to another voice.
                if not sent:
                    await emit({'id': rid, 'error': str(item)[:200]})
                    return
                continue
            sent = True
            await emit({'id': rid, 'chunk': base64.b64encode(item).decode()})
    await emit({'id': rid, 'done': True} if sent else {'id': rid, 'error': 'no audio'})


async def main():
    # Windows' event loop can't read a pipe directly, so stdin is read on a thread.
    loop = asyncio.get_running_loop()
    await emit({'ready': True})
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            break
        try:
            req = json.loads(line)
        except ValueError:
            continue
        asyncio.ensure_future(handle(req))


if __name__ == '__main__':
    asyncio.run(main())
