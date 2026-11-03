"""New client replies the moment the lead finder records them, for Jarvis to say
out loud. Runs for as long as Jarvis does:

    python -u scripts/replywatch.py <lead_finder dir>

Every 3 seconds it reads the replies of the last day (leadstats.replies_since,
read-only) and prints each new one as a line of JSON. What is already there when
it starts is history and isn't printed; nor is a reply written more than 15
minutes ago (one the finder rewrote, or found late).
"""
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone

import psycopg

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import leadstats  # noqa: E402

EVERY_S = 3
FRESH = timedelta(minutes=15)


def database_url():
    url = os.environ.get('LEAD_DB_URL')
    if not url and len(sys.argv) > 1:
        sys.path.insert(0, sys.argv[1])
        from webapp import appdb
        url = appdb.database_url()
    return url


def main():
    url = database_url()
    if not url:
        print(json.dumps({'error': 'the lead finder has no shared database set'}), flush=True)
        return
    seen, first = set(), True
    while True:
        try:
            with psycopg.connect(url, autocommit=True, connect_timeout=15, prepare_threshold=None) as c:
                c.execute('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY')
                rows = lambda sql, *a: c.execute(sql, a or None).fetchall()
                while True:
                    now = datetime.now(timezone.utc)
                    for r in leadstats.replies_since(rows, (now - timedelta(days=1)).isoformat()):
                        if r['key'] in seen:
                            continue
                        seen.add(r['key'])
                        if not first and now - datetime.fromisoformat(r['at']) < FRESH:
                            print(json.dumps({'reply': r}, default=str), flush=True)
                    first = False
                    time.sleep(EVERY_S)
        except Exception as err:   # the database or the network had a moment: connect again
            print(json.dumps({'error': str(err).splitlines()[0][:200] if str(err) else type(err).__name__}), flush=True)
            time.sleep(10)


if __name__ == '__main__':
    main()
