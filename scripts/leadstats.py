"""The lead finder's numbers and latest events, for Jarvis.

The lead finder keeps its lists in Supabase (Postgres), shared by the PC app,
the online copy and the Codespace runs. This reads them read-only, using the
lead finder's own connection settings, and prints one JSON object:

    <lead_finder>/.venv/Scripts/python.exe -I scripts/leadstats.py <lead_finder dir>

The live site runs the same code (api/leads.py) with the database address from
its own settings, through collect(url), when the Jarvis PC is off.

Numbers: leads collected, demo sites built, websites sent (by email or
WhatsApp), emails sent, meetings, and the latest service usage readings.
Events: what happened in the last 24 hours (sites built, emails and WhatsApps
sent, call results, runs, new leads), each with a stable id so Jarvis can tell
new ones from ones it has already shown.
"""
import json
import sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import psycopg

# "Today" is the office's calendar day, in UK time, wherever this runs.
OFFICE = ZoneInfo('Europe/London')
# Only leads in projects that aren't archived count (the Porto pilots are archived).
ACTIVE = "(SELECT l.id FROM leads l JOIN projects p ON p.id = l.project_id WHERE p.archived_at IS NULL)"
ACTIVE_PROJECTS = "(SELECT id FROM projects WHERE archived_at IS NULL)"


def setting(rows, key):
    r = rows('SELECT value FROM app_settings WHERE key = %s', key)
    try:
        return json.loads(r[0][0]) if r and r[0][0] else None
    except ValueError:
        return None


def tracker(rows):
    """What the lead finder (on the Mac) is doing right now, from the status it
    keeps in the shared lists: is the Mac alive, what is it building, is the
    finder looking or waiting, is anything out of credits, the WhatsApp plan."""
    now = datetime.now(timezone.utc)
    burst = setting(rows, 'build_burst') or {}
    queue = setting(rows, 'build_queue') or {}
    alive = setting(rows, 'wa_alive') or {}
    claude = setting(rows, 'claude_status') or {}
    plan = setting(rows, 'wa_plan') or {}
    seen = [x.get('at') for x in (burst, queue, alive) if x.get('at')]
    last = max(seen) if seen else None
    age = (now - datetime.fromisoformat(last)).total_seconds() / 60 if last else None
    slots = plan.get('slots') or [] if plan.get('date') == datetime.now().astimezone().date().isoformat() else []
    upcoming = sorted([x for x in slots if x.get('status') in (None, '', 'planned', 'waiting', 'written') and x.get('at', '') > now.isoformat()], key=lambda x: x['at'])
    usage = burst.get('usage') or {}
    # When something last happened in the active projects: a new lead, a WhatsApp out.
    last_lead = rows(f'SELECT max(created_at) FROM leads WHERE project_id IN {ACTIVE_PROJECTS}')[0][0]
    last_send = rows(f"SELECT max(updated_at) FROM lead_values WHERE key = 'whatsapp_status' AND value LIKE 'sent %%' AND lead_id IN {ACTIVE}")[0][0]
    stamps = [datetime.fromisoformat(str(t).replace('Z', '+00:00')) for t in (last_lead, last_send) if t]
    moved = max(stamps, default=None)
    quiet = moved is None or (now - moved).total_seconds() > 2 * 3600
    # Stuck, only when it's real: the UK finder says it's paused, or a finder
    # paused on a list in a project that isn't archived and nothing has moved
    # for two hours. (A paused cafés finder while the UK run keeps finding and
    # sending isn't "stuck".)
    uk_paused = setting(rows, 'uk_find_paused')
    queue_active = False
    if queue.get('paused') and queue.get('list_id'):
        try:
            r = rows('SELECT p.archived_at FROM lists li JOIN projects p ON p.id = li.project_id WHERE li.id = %s', queue['list_id'])
            queue_active = bool(r) and r[0][0] is None
        except Exception:
            queue_active = False
    stuck = (uk_paused if isinstance(uk_paused, str) and uk_paused else None) \
        or (queue.get('paused') if queue_active and quiet else None) \
        or (burst.get('paused') if burst.get('paused') and quiet else None)
    return {
        'stuck': stuck, 'lastLeadAt': last_lead, 'lastSendAt': last_send,
        'online': age is not None and age < 15, 'lastSeen': last, 'host': burst.get('host') or alive.get('host'),
        'building': [b if isinstance(b, str) else (b.get('name') or b.get('slug') or '') for b in (burst.get('building') or [])],
        'workers': burst.get('workers'),
        'finder': burst.get('finder'),
        'buildPaused': burst.get('paused'),
        'queuePaused': queue.get('paused'),
        'claudeLimited': bool(claude.get('limited')), 'claudeResets': claude.get('resets'),
        'buildAccountUsage': usage,
        'waOn': bool(setting(rows, 'wa_on')),
        'waSentToday': sum(1 for x in slots if x.get('status') == 'sent'),
        'waFailedToday': sum(1 for x in slots if str(x.get('status', '')).startswith('failed')),
        'waNext': {'at': upcoming[0]['at'], 'name': upcoming[0].get('name'), 'sender': upcoming[0].get('sender')} if upcoming else None,
        'waLeftToday': len(upcoming),
    }


# A lead counts as contacted when the outreach reached it: emailed, messaged,
# a WhatsApp went out (from any of the numbers), the UK run sent it, or an
# Instagram message went. (A status set from an old phone call, like the Porto
# pilot's "not interested", is not part of the outreach and doesn't count.)
CONTACTED = "(status IN ('Emailed', 'Messaged') OR wa_sent = 1 OR uk_sent = 1 OR ig_sent = 1)"
AUTO_REPLY = ('thanks for your message', 'thank you for your message', 'please answer if first time', 'we will get back',
              "we'll get back", 'out of office', 'automatic reply', 'auto-reply', 'currently unavailable', 'away message')
# Where the finder writes replies: the newer fields (replied_at, uk_last_reply,
# uk_autoreply, interested_at, uk_told_tomorrow) and the older whatsapp_reply.
LEAD_VIEW = """
  SELECT lead_id,
    max(CASE WHEN key = 'call_result' THEN value END) AS status,
    max(CASE WHEN key = 'call_result' THEN updated_at END) AS status_at,
    max(CASE WHEN key = 'whatsapp_status' AND value LIKE 'sent %%' THEN 1 END) AS wa_sent,
    max(CASE WHEN key = 'uk_status' AND value = 'sent' THEN 1 END) AS uk_sent,
    max(CASE WHEN key = 'instagram_status' AND value LIKE 'sent %%' THEN 1 END) AS ig_sent,
    max(CASE WHEN key IN ('whatsapp_reply', 'uk_last_reply', 'replied_at') AND coalesce(value, '') <> '' THEN updated_at END) AS reply_at,
    max(CASE WHEN key IN ('uk_autoreply', 'whatsapp_autoreply') AND coalesce(value, '') <> '' THEN updated_at END) AS auto_at,
    max(CASE WHEN key = 'interested_at' AND coalesce(value, '') <> '' THEN 1 END) AS interested,
    max(CASE WHEN key = 'uk_told_tomorrow' AND coalesce(value, '') <> '' THEN 1 END) AS told,
    max(CASE WHEN key = 'callback_date' AND coalesce(value, '') <> '' THEN 1 END) AS follow_date
  FROM lead_values WHERE lead_id IN """ + ACTIVE + """ GROUP BY lead_id"""


def said_of(value):
    """The words of a reply, without the finder's stamps:
    "24 Oct 17:33 (interested): the words 17:13" or "[15:55, 10/24/2026] +44 7380 866999: the words 15:55"."""
    t = str(value or '').strip()
    if t.startswith('['):
        t = t.split('] ', 1)[-1]
        t = t.split(': ', 1)[-1]
    elif '): ' in t[:40]:
        t = t.split('): ', 1)[-1]
    elif 'replied (seen' in t[:20]:
        t = t.split(': ', 1)[-1].split('] ', 1)[-1].split(': ', 1)[-1]
    parts = t.rsplit(' ', 1)
    if len(parts) == 2 and len(parts[1]) == 5 and parts[1][2] == ':' and parts[1].replace(':', '').isdigit():
        t = parts[0]
    return t.strip()


def pipeline(rows):
    """Where every contacted lead has got to: they replied (or only an automatic
    reply came back), we answered, follow-up (interested, a callback, a meeting),
    won. With the latest replies themselves, by name."""
    stage_sql = f"""
      WITH v AS ({LEAD_VIEW}),
      c AS (SELECT * FROM v WHERE {CONTACTED} OR reply_at IS NOT NULL OR auto_at IS NOT NULL OR status IN ('Interested', 'Meeting set', 'Proposal sent', 'Won')
                                  OR (status = 'Not interested' AND status_at > '2026-10-20'))
      SELECT count(*),
        count(*) FILTER (WHERE reply_at IS NOT NULL OR interested = 1 OR status IN ('Interested', 'Meeting set', 'Proposal sent', 'Won', 'Not interested')),
        count(*) FILTER (WHERE auto_at IS NOT NULL AND reply_at IS NULL AND interested IS NULL AND coalesce(status, '') NOT IN ('Interested', 'Meeting set', 'Proposal sent', 'Won', 'Not interested')),
        count(*) FILTER (WHERE told = 1 OR status IN ('Interested', 'Meeting set', 'Proposal sent', 'Won') OR (reply_at IS NOT NULL AND status_at > reply_at)),
        count(*) FILTER (WHERE interested = 1 OR follow_date = 1 OR status IN ('Interested', 'Meeting set', 'Proposal sent', 'Won')),
        count(*) FILTER (WHERE status = 'Won'),
        count(*) FILTER (WHERE status = 'Not interested')
      FROM c"""
    sent, replied, auto, answered, follow, won, said_no = rows(stage_sql)[0]
    latest = rows("""SELECT l.name, v.key, v.value, v.updated_at FROM lead_values v JOIN leads l ON l.id = v.lead_id
                     WHERE v.key IN ('whatsapp_reply', 'uk_last_reply', 'uk_autoreply', 'whatsapp_autoreply') AND coalesce(v.value, '') <> ''
                       AND v.lead_id IN """ + ACTIVE + """
                     ORDER BY (v.key IN ('uk_autoreply', 'whatsapp_autoreply')), v.updated_at DESC LIMIT 6""")
    replies = []
    for name, key, value, at in latest:
        said = said_of(value)
        is_auto = 'autoreply' in key or any(k in said.lower() for k in AUTO_REPLY)
        replies.append({'name': name, 'said': said[:600], 'at': at, 'auto': is_auto, 'interested': '(interested)' in str(value)[:40]})
    return {'sent': sent, 'replied': replied, 'autoReplied': auto, 'answered': answered, 'followUp': follow, 'won': won, 'saidNo': said_no, 'replies': replies}


def week(rows):
    """The last seven days, day by day: WhatsApps, emails, new leads (active projects)."""
    days = [(datetime.now(OFFICE) - timedelta(days=d)).date().isoformat() for d in range(6, -1, -1)]
    day = "to_char((%s::timestamptz AT TIME ZONE 'Europe/London'), 'YYYY-MM-DD')"
    emails = dict(rows(f"""SELECT {day % 'updated_at'}, count(*) FROM lead_values
                         WHERE updated_at >= %s AND key = 'call_result' AND value = 'Emailed' AND lead_id IN {ACTIVE} GROUP BY 1""", days[0]))
    wa = dict(rows(f"""SELECT {day % 'updated_at'}, count(*) FROM lead_values
                       WHERE updated_at >= %s AND key = 'whatsapp_status' AND value LIKE 'sent %%' AND lead_id IN {ACTIVE} GROUP BY 1""", days[0]))
    new = dict(rows(f"SELECT {day % 'created_at'}, count(*) FROM leads WHERE created_at >= %s AND project_id IN {ACTIVE_PROJECTS} GROUP BY 1", days[0]))
    return [{'date': d, 'emails': emails.get(d, 0), 'whatsapps': wa.get(d, 0), 'leads': new.get(d, 0)} for d in days]


def senders(rows, setting_value, midnight):
    """Each WhatsApp number the finder sends from: whether it's linked, and how
    many it has sent today and in all. A sent WhatsApp is recorded as
    "sent 25 Oct 11:35 from Personal 2" (sometimes with a note in brackets)."""
    counts = {}
    for label, today, total in rows("""SELECT trim(regexp_replace(substring(value from ' from (.*)$'), '\\s*\\(.*$', '')) AS label,
                                         count(*) FILTER (WHERE updated_at >= %s), count(*)
                                  FROM lead_values WHERE key = 'whatsapp_status' AND value LIKE 'sent %%' GROUP BY 1""", midnight):
        if label:
            counts[label.lower()] = (today, total)
    out = []
    for s in setting_value or []:
        label = s.get('label') or s.get('id')
        today, total = counts.pop(str(label).lower(), (0, 0))
        out.append({'id': s.get('id'), 'label': label, 'linked': s.get('status') == 'linked', 'status': s.get('status'), 'today': today, 'total': total})
    for label, (today, total) in counts.items():   # a number no longer in the list but still sent from
        out.append({'id': label, 'label': label.title(), 'linked': None, 'status': 'not in the list', 'today': today, 'total': total})
    return out


def collect(url):
    """Everything Jarvis shows from the lead finder, as one dict."""
    since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
    # "Today" is the calendar day in the office, not the last 24 hours.
    local = datetime.now(OFFICE)
    midnight = local.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc).isoformat()
    # prepare_threshold=None: Supabase's pooler shares connections, so no prepared statements.
    with psycopg.connect(url, autocommit=True, connect_timeout=15, prepare_threshold=None) as c:
        c.execute('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY')
        one = lambda sql, *a: c.execute(sql, a or None).fetchone()[0]
        rows = lambda sql, *a: c.execute(sql, a or None).fetchall()

        A = ACTIVE
        out = {
            'ok': True,
            'leads': one(f'SELECT count(*) FROM leads WHERE project_id IN {ACTIVE_PROJECTS}'),
            'built': one(f"SELECT count(*) FROM builds WHERE status = 'built' AND lead_id IN {A}"),
            'emailsSent': one(f"SELECT count(*) FROM lead_values WHERE key = 'call_result' AND value = 'Emailed' AND lead_id IN {A}"),
            'whatsappSent': one(f"SELECT count(*) FROM lead_values WHERE key = 'whatsapp_status' AND value LIKE 'sent %%' AND lead_id IN {A}"),
            'meetings': one(f"SELECT count(*) FROM lead_values WHERE key = 'call_result' AND lower(value) LIKE 'meeting%%' AND lead_id IN {A}"),
            'notInterested': one(f"SELECT count(*) FROM lead_values WHERE key = 'call_result' AND lower(value) = 'not interested' AND lead_id IN {A}"),
            'leadsToday': one(f'SELECT count(*) FROM leads WHERE created_at >= %s AND project_id IN {ACTIVE_PROJECTS}', midnight),
            'builtToday': one(f"SELECT count(*) FROM builds WHERE status = 'built' AND finished_at >= %s AND lead_id IN {A}", midnight),
            'whatsappToday': one(f"SELECT count(*) FROM lead_values WHERE key = 'whatsapp_status' AND value LIKE 'sent %%' AND updated_at >= %s AND lead_id IN {A}", midnight),
            'emailsToday': one(f"SELECT count(*) FROM lead_values WHERE key = 'call_result' AND value = 'Emailed' AND updated_at >= %s AND lead_id IN {A}", midnight),
            'replies': one(f"SELECT count(DISTINCT lead_id) FROM lead_values WHERE key IN ('whatsapp_reply', 'uk_last_reply', 'replied_at') AND coalesce(value, '') <> '' AND lead_id IN {A}"),
            'repliesToday': one(f"SELECT count(DISTINCT lead_id) FROM lead_values WHERE key IN ('whatsapp_reply', 'uk_last_reply', 'replied_at') AND coalesce(value, '') <> '' AND updated_at >= %s AND lead_id IN {A}", midnight),
            'tracker': None,
            'run': None,
            'usage': {},
            'spend': {},
            'caps': {},
            'events': [],
        }
        r = rows("""SELECT r.id, r.kind, r.status, r.found, r.target, r.stage, r.error, p.name, r.created_at
                    FROM runs r JOIN projects p ON p.id = r.project_id ORDER BY r.id DESC LIMIT 1""")
        if r:
            i, kind, status, found, target, stage, error, project, at = r[0]
            out['run'] = {'id': i, 'kind': kind, 'status': status, 'found': found, 'target': target, 'stage': stage, 'error': error, 'project': project, 'at': at}
        for service, data, at in rows('SELECT DISTINCT ON (service) service, data, at FROM usage_readings ORDER BY service, at DESC'):
            try:
                out['usage'][service] = {**json.loads(data), 'at': at}
            except ValueError:
                pass
        for service, usd, units in rows('SELECT service, sum(usd), sum(units) FROM spend GROUP BY service'):
            out['spend'][service] = {'usd': float(usd or 0), 'units': float(units or 0)}
        for service, cap in rows('SELECT service, sum(cap) FROM caps GROUP BY service'):
            out['caps'][service] = float(cap or 0)

        ev = out['events']
        for bid, name, live, at in rows("""SELECT b.id, l.name, b.live_url, b.finished_at FROM builds b JOIN leads l ON l.id = b.lead_id
                                           WHERE b.status = 'built' AND b.finished_at >= %s""", since):
            ev.append({'id': f'build:{bid}', 'at': at, 'kind': 'built', 'text': f'Demo site built for {name}', 'url': live})
        for lead, name, key, value, at in rows("""SELECT v.lead_id, l.name, v.key, v.value, v.updated_at FROM lead_values v JOIN leads l ON l.id = v.lead_id
                                                  WHERE v.key IN ('call_result', 'whatsapp_status') AND v.updated_at >= %s""", since):
            value = (value or '').strip()
            if key == 'call_result' and value == 'Emailed':
                ev.append({'id': f'email:{lead}', 'at': at, 'kind': 'emailed', 'text': f'Emailed {name} their demo site'})
            elif key == 'call_result' and value and value != 'Built':
                ev.append({'id': f'call:{lead}:{value}', 'at': at, 'kind': 'call', 'text': f'{name}: {value.lower()}'})
            elif key == 'whatsapp_status' and value.startswith('sent '):
                ev.append({'id': f'wa:{lead}', 'at': at, 'kind': 'whatsapp', 'text': f'WhatsApp sent to {name}'})
        for i, kind, status, found, target, project, at, finished in rows(
                """SELECT r.id, r.kind, r.status, r.found, r.target, p.name, r.created_at, r.finished_at FROM runs r
                   JOIN projects p ON p.id = r.project_id WHERE r.created_at >= %s OR r.finished_at >= %s""", since, since):
            label = 'new list' if kind == 'new_list' else 'adding leads'
            if status == 'done':
                ev.append({'id': f'run:{i}:done', 'at': finished or at, 'kind': 'run', 'text': f'Lead finder {label} in {project}: {found} of {target} found'})
            elif status in ('failed', 'error'):
                ev.append({'id': f'run:{i}:fail', 'at': finished or at, 'kind': 'run_failed', 'text': f'Lead finder run in {project} failed'})
            elif status == 'running':
                ev.append({'id': f'run:{i}:start', 'at': at, 'kind': 'run', 'text': f'Lead finder started {label} in {project}'})
        for lead, name, value, at in rows("""SELECT v.lead_id, l.name, v.value, v.updated_at FROM lead_values v JOIN leads l ON l.id = v.lead_id
                                             WHERE v.key IN ('whatsapp_reply', 'uk_last_reply') AND coalesce(v.value, '') <> '' AND v.updated_at >= %s""", since):
            ev.append({'id': f'reply:{lead}', 'at': at, 'kind': 'reply', 'text': f'{name} replied on WhatsApp: "{said_of(value)[:160]}"', 'name': name})
        out['tracker'] = tracker(rows)
        out['pipeline'] = pipeline(rows)
        out['week'] = week(rows)
        out['senders'] = senders(rows, setting(rows, 'wa_senders'), midnight)
        # The last WhatsApp that went out, word for word, and who it went to.
        last = rows("""SELECT l.name, p.name, s.value, s.updated_at, m.value
                        FROM lead_values s JOIN leads l ON l.id = s.lead_id JOIN projects p ON p.id = l.project_id
                        LEFT JOIN lead_values m ON m.lead_id = s.lead_id AND m.key = 'whatsapp_message'
                        WHERE s.key = 'whatsapp_status' AND s.value LIKE 'sent %%' AND p.archived_at IS NULL
                        ORDER BY s.updated_at DESC LIMIT 1""")
        if last:
            name, project, status, at, text = last[0]
            sender = (status.split(' from ', 1)[1] if ' from ' in status else '').split(' (')[0]
            out['lastMessage'] = {'to': name, 'project': project, 'from': sender, 'at': at, 'text': text or ''}
        # Each active project: leads, contacted, new today.
        out['projects'] = [{'name': n, 'leads': total, 'contacted': contacted, 'today': today} for n, total, contacted, today in rows(f"""
            SELECT p.name, count(l.id),
              count(l.id) FILTER (WHERE EXISTS (SELECT 1 FROM lead_values v WHERE v.lead_id = l.id AND
                ((v.key = 'whatsapp_status' AND v.value LIKE 'sent %%') OR (v.key = 'call_result' AND v.value IN ('Emailed', 'Messaged'))
                 OR (v.key = 'uk_status' AND v.value = 'sent') OR (v.key = 'instagram_status' AND v.value LIKE 'sent %%')))),
              count(l.id) FILTER (WHERE l.created_at >= %s)
            FROM projects p LEFT JOIN leads l ON l.project_id = p.id
            WHERE p.archived_at IS NULL GROUP BY p.id, p.name, p.sort ORDER BY p.sort""", midnight)]
        # Every demo site the finder has built and put live, newest first.
        out['demos'] = [{'name': n, 'url': u} for u, n in rows("""SELECT b.live_url, l.name FROM builds b JOIN leads l ON l.id = b.lead_id
                         WHERE b.status = 'built' AND coalesce(b.live_url, '') <> '' ORDER BY b.finished_at DESC""")]
        for lead, name, project, at in rows("""SELECT l.id, l.name, p.name, l.created_at FROM leads l JOIN projects p ON p.id = l.project_id
                                               WHERE l.created_at >= %s""", since):
            ev.append({'id': f'lead:{lead}', 'at': at, 'kind': 'lead', 'text': f'New lead in {project}: {name}'})
    return out


def main():
    # The shared database's address: LEAD_DB_URL (Jarvis's .env), or else the
    # lead finder folder's own settings.
    import os
    url = os.environ.get('LEAD_DB_URL')
    if not url and len(sys.argv) > 1:
        sys.path.insert(0, sys.argv[1])
        from webapp import appdb
        url = appdb.database_url()
    if not url:
        print(json.dumps({'ok': False, 'error': 'the lead finder has no shared database set (SUPABASE_PASSWORD in its .env)'}))
        return
    print(json.dumps(collect(url), default=str))


if __name__ == '__main__':
    try:
        main()
    except Exception as err:  # Jarvis shows this as the source failing
        print(json.dumps({'ok': False, 'error': str(err).splitlines()[0][:200]}))
