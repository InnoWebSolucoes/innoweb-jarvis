// Innoweb Jarvis: the TV dashboard's server.
//
// One process, no dependencies. It serves the page in public/, and every few
// seconds the page asks /api/state for everything it shows. Behind that, loops
// refresh each source on its own clock:
//
//   board      data/board.json, the numbers people set by hand (/edit)
//   leads      the lead finder's app database (read-only SQLite)
//   flowdesk   FlowDesk's Supabase: today's completions and what is in progress
//   innolink   Innolink's Supabase: page opens and link clicks per client
//   sites      a health ping of every site in the rotator
//
// Each refresh is compared with the one before it. What changed becomes a line
// in the live log, and the page turns some of those lines into a celebration
// (level "win") or the red alarm (level "error").

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import crypto from 'node:crypto';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const BOARD_FILE = path.join(DATA, 'board.json');
const LOG_FILE = path.join(DATA, 'log.jsonl');

loadEnv(path.join(ROOT, '.env'));
const env = process.env;
const PORT = Number(env.PORT || 5210);
const HOST = env.HOST || '0.0.0.0';
const PASSWORD = env.JARVIS_PASSWORD || '';
// The lead finder keeps its lists in Supabase; scripts/leadstats.py reads them
// read-only with the lead finder's own Python and settings.
const LEADFINDER_DIR = env.LEADFINDER_DIR || 'C:/Users/rafam/Agency/lead_finder';
const LEADFINDER_PYTHON = env.LEADFINDER_PYTHON || path.join(LEADFINDER_DIR, '.venv', 'Scripts', 'python.exe');

// FlowDesk's URL and public anon key are read from FlowDesk's own .env when
// they aren't set here. Reading needs a service role key, or an admin login.
const flowdeskEnv = readEnvFile(env.FLOWDESK_ENV_FILE || 'C:/Users/rafam/FlowDesk/FlowDesk/.env');
const FLOWDESK = {
  url: env.FLOWDESK_SUPABASE_URL || flowdeskEnv.VITE_SUPABASE_URL || '',
  anon: env.FLOWDESK_ANON_KEY || flowdeskEnv.VITE_SUPABASE_ANON_KEY || '',
  service: env.FLOWDESK_SERVICE_ROLE_KEY || '',
  email: env.FLOWDESK_EMAIL || '',
  password: env.FLOWDESK_PASSWORD || '',
};
const INNOLINK = {
  url: env.INNOLINK_SUPABASE_URL || 'https://wjmrwszorppurykmwmwt.supabase.co',
  service: env.INNOLINK_SERVICE_ROLE_KEY || '',
};
// Claude answers the questions the built-in commands don't cover. It runs
// through Claude Code on this PC, so it uses the Claude subscription that
// Claude Code is signed in with, not a paid API key.
const CLAUDE_BIN = env.CLAUDE_BIN || findClaude();
const BRAIN_DIR = path.join(DATA, 'brain');  // an empty folder, so no project files or notes leak in
const SHOTS = path.join(PUBLIC, 'shots');
const TTS = path.join(DATA, 'tts');

// ---------------------------------------------------------------- live log

// Changes whenever the server restarts with new code; open TVs reload to pick it up.
// The screens reload when this changes. It follows the dashboard's own files, not
// the server's start time: a TV only plays sound after a press of OK, and every
// reload undoes that, so restarting Jarvis alone mustn't reload the TV.
function buildId() {
  const h = crypto.createHash('md5');
  for (const f of ['index.html', 'jarvis.js', 'jarvis.css']) { try { h.update(fs.readFileSync(path.join(ROOT, 'public', f))); } catch {} }
  return h.digest('hex').slice(0, 12);
}
let BUILD = buildId();
setInterval(() => { BUILD = buildId(); }, 30000);

const events = [];
const seenKeys = new Set();  // source items already in the log (FlowDesk notification ids, lead finder events...)
let nextEventId = 1;
for (const line of safeRead(LOG_FILE).split('\n').slice(-600)) {
  try {
    const e = JSON.parse(line);
    events.push(e);
    nextEventId = Math.max(nextEventId, e.id + 1);
    if (e.key) seenKeys.add(e.key);
  } catch {}
}

// extra: panel, big, title for celebrations; at for when it really happened;
// key to skip an item already logged; history for items found at start-up,
// which are shown in the log but never celebrated or alarmed.
function log(level, source, text, extra = {}) {
  if (extra.key) {
    if (seenKeys.has(extra.key)) return null;
    seenKeys.add(extra.key);
  }
  const e = { id: nextEventId++, at: new Date().toISOString(), level, source, text, ...extra };
  e.at = new Date(e.at).toISOString();  // one format, so the log sorts by real time
  events.push(e);
  if (events.length > 600) events.splice(0, events.length - 600);
  fs.appendFile(LOG_FILE, JSON.stringify(e) + '\n', () => {});
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${level.padEnd(5)} ${source}: ${text}`);
  return e;
}

// Keep the file from growing forever: rewrite it with the last 300 lines at start.
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(LOG_FILE, events.map(e => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));

// ---------------------------------------------------------------- sources

let lastRuns = null;  // run id -> status, to report runs that change
const state = {
  board: null,
  leads: { ok: false },
  flowdesk: { ok: false, configured: false },
  innolink: { ok: false, configured: Boolean(INNOLINK.service) },
  sites: {},
  shots: {},
  tokens: [],
};

// A source that fails is reported once, and again only after it recovered.
const failing = {};
function sourceFailed(source, err, panel) {
  const msg = String(err?.message || err).slice(0, 180);
  if (!failing[source]) log('error', source, `${source} stopped answering: ${msg}`, { panel });
  failing[source] = msg;
}
function sourceOk(source) {
  if (failing[source]) log('info', source, `${source} is back`);
  delete failing[source];
}

// --- board (manual numbers)

function readBoard() {
  const b = JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8'));
  return b;
}

function diffBoard(prev, next) {
  if (!prev) return;
  const a = prev.achievements, b = next.achievements;
  const eur = n => '€' + Number(n).toLocaleString('en-IE');
  if (b.revenue > a.revenue) log('win', 'board', `${eur(b.revenue - a.revenue)} came in. ${eur(b.revenue)} of ${eur(b.revenueGoal)}`, { panel: 'ach', big: true, title: `+${eur(b.revenue - a.revenue)}` });
  if (b.clientsManaged > a.clientsManaged) log('win', 'board', `New client signed. Now managing ${b.clientsManaged}`, { panel: 'ach', big: true, title: 'NEW CLIENT' });
  if (b.websiteDeals > a.websiteDeals) log('win', 'board', `Website deal closed. ${b.websiteDeals} website deals`, { panel: 'ach', big: true, title: 'DEAL CLOSED' });
  if (b.websitesBuilt > a.websitesBuilt) log('win', 'board', `${b.websitesBuilt - a.websitesBuilt} more website built. ${b.websitesBuilt} in total`, { panel: 'ach', big: true, title: 'WEBSITE BUILT' });
  if (b.clientsPending > a.clientsPending || b.websiteDealsPending > a.websiteDealsPending) log('info', 'board', 'New deal in the pipeline', { panel: 'ach' });
  const ma = prev.metaReview?.status, mb = next.metaReview?.status;
  if (ma !== mb) {
    if (mb === 'approved') log('win', 'meta', 'Meta approved the app review', { panel: 'meta', big: true, title: 'META APPROVED' });
    else if (mb === 'rejected') log('error', 'meta', 'Meta rejected the app review', { panel: 'meta' });
    else log('info', 'meta', `Meta review status: ${mb}`, { panel: 'meta' });
  }
}

function refreshBoard() {
  try {
    const next = readBoard();
    diffBoard(state.board, next);
    const sitesChanged = state.board && JSON.stringify(state.board.sites) !== JSON.stringify(next.sites);
    state.board = next;
    if (sitesChanged) shootSites(true);
    sourceOk('board');
  } catch (err) { sourceFailed('board', err, 'ach'); }
}

// --- lead finder (its shared Supabase lists, read-only)

function runJson(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, ...opts });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('timed out')); }, opts.timeout || 60000);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out)); } catch { reject(new Error((err || out || 'no output').trim().split('\n').pop().slice(0, 160))); }
    });
  });
}

const LEAD_EVENTS = {
  reply: ['win', 'CLIENT REPLIED', true],
  built: ['win', 'DEMO BUILT', false],
  emailed: ['win', 'SITE SENT', true],
  whatsapp: ['win', 'SITE SENT', true],
  call: ['info'], run: ['info'], lead: ['info'],
  run_failed: ['error'],
};
let leadsFirst = true;
async function refreshLeads() {
  try {
    const next = await runJson(LEADFINDER_PYTHON, ['-I', path.join(ROOT, 'scripts', 'leadstats.py'), LEADFINDER_DIR]);
    if (!next.ok) throw new Error(next.error);
    const prev = state.leads;
    // Everything from the last day goes into the log, oldest first. What was
    // already there at start-up is history: listed, never celebrated.
    for (const e of next.events.sort((a, b) => (a.at < b.at ? -1 : 1))) {
      const [level, title, big] = LEAD_EVENTS[e.kind] || ['info'];
      const logged = log(leadsFirst ? (level === 'error' ? 'warn' : 'info') : level, 'leads', e.text,
        { key: 'lf:' + e.id, at: e.at, panel: 'lead', title, big, history: leadsFirst || undefined });
      // A business answering the lead finder is the big one: Jarvis says it out loud.
      if (logged && !leadsFirst && e.kind === 'reply') announce(`Big news! ${e.text}`, 'lead');
    }
    watchTracker(prev.ok ? prev.tracker : null, next.tracker);
    if (prev.ok && next.meetings > prev.meetings) log('win', 'leads', 'A lead booked a meeting', { panel: 'lead', big: true, title: 'MEETING BOOKED' });
    leadsFirst = false;
    delete next.events;
    if (next.demos && next.demos.length && (!prev.ok || (prev.demos || []).length !== next.demos.length)) setTimeout(() => filmDemos(), 1000);
    state.leads = next;
    state.tokens = tokenRows();
    sourceOk('leads');
  } catch (err) {
    state.leads = { ok: false, error: String(err.message || err) };
    sourceFailed('leads', err, 'lead');
  }
}

// What the lead finder on the Mac is doing, said in the live log when it changes.
function watchTracker(was, now) {
  if (!now) return;
  const day = localDate(new Date());
  const hhmm = (iso) => iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '?';
  if (was && was.online && !now.online) {
    log('error', 'leads', `The lead finder on the Mac stopped reporting (last seen ${hhmm(now.lastSeen)})`, { panel: 'lead', key: `lfoff:${now.lastSeen}` });
    announce('Heads up. The lead finder on the Mac has stopped. Check that the Mac is on and awake.', 'lead');
  }
  if (was && !was.online && now.online) log('info', 'leads', 'The lead finder on the Mac is running again', { panel: 'lead' });
  const stuck = now.queuePaused || now.buildPaused;
  if (stuck && stuck !== (was && (was.queuePaused || was.buildPaused))) log('warn', 'leads', `Lead finder stuck: ${stuck}`, { panel: 'lead', key: `lfstuck:${day}:${stuck}` });
  if (now.claudeLimited && !(was && was.claudeLimited)) log('warn', 'leads', `Lead finder is out of Claude usage${now.claudeResets ? ` until ${hhmm(now.claudeResets)}` : ''}`, { panel: 'lead' });
  if (now.finder && now.finder !== (was && was.finder)) log('info', 'leads', `Lead finder: ${now.finder}`, { panel: 'lead', key: `lffinder:${day}:${now.finder}` });
  for (const b of now.building) if (b && !(was && was.building.includes(b))) log('info', 'leads', `Building a website for ${b}`, { panel: 'lead', key: `lfbuild:${day}:${b}` });
}

// --- Claude plan usage, one row per account, from Claude Code's own /usage
// report (no model call, so it costs nothing). The account Claude Code is signed
// in with on this PC comes first; every other account is signed in once with
// "Add Claude account.bat", which keeps its login in data/claude-accounts/<name>.
const ACCOUNTS_DIR = path.join(DATA, 'claude-accounts');
let claudeUsage = [];
async function usageOf(name, configDir) {
  const res = await runJson(CLAUDE_BIN, ['-p', '/usage', '--output-format', 'json', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--setting-sources', ''],
    { cwd: BRAIN_DIR, env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}) }, timeout: 90000 });
  // Lines like "Current session: 65% used · resets Oct 22, 4:29pm (Europe/London)".
  const text = String(res.result || '');
  const line = (re) => { const m = text.match(re); return m ? { pct: Number(m[1]), reset: (m[2] || '').replace(/\s*\([^)]*\)\s*$/, '').trim() } : null; };
  const session = line(/^Current session: (\d+)% used(?:\s*[·-]\s*resets ([^\n]+))?/m);
  const week = line(/^Current week \(all models\): (\d+)% used(?:\s*[·-]\s*resets ([^\n]+))?/m);
  if (!session && !week) throw new Error(text.split('\n')[0].slice(0, 120) || 'no usage report');
  return { account: name, used: session ? session.pct : 0, limit: 100, unit: 'claude', week: week ? week.pct : null, note: session?.reset ? 'resets ' + session.reset : '', weekReset: week?.reset || '',
    sessionAt: resetAt(session?.reset), weekAt: resetAt(week?.reset), live: true };
}

// "Oct 24, 12:20am", "Oct 24, 10pm" or just "4:29pm" (today), in this PC's time zone, as an ISO time.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function resetAt(text) {
  const m = /^(?:([A-Z][a-z]{2}) (\d{1,2}),?\s*)?(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(String(text || '').trim());
  if (!m) return null;
  const now = new Date(), d = new Date(now);
  if (m[1] && MONTHS.includes(m[1])) d.setMonth(MONTHS.indexOf(m[1]), Number(m[2]));
  d.setHours((Number(m[3]) % 12) + (m[5].toLowerCase() === 'pm' ? 12 : 0), Number(m[4] || 0), 0, 0);
  if (!m[1] && d < now) d.setDate(d.getDate() + 1);
  if (d < now - 30 * 864e5) d.setFullYear(d.getFullYear() + 1);
  return d.toISOString();
}
async function refreshClaudeUsage() {
  if (!CLAUDE_BIN) return;
  fs.mkdirSync(BRAIN_DIR, { recursive: true });
  // The board names them: the account Claude Code uses on this PC, then the
  // others in the order given (each signed in with "Add Claude account").
  const named = state.board?.claudeAccounts || {};
  const others = [...(named.others || []), ...safeList(ACCOUNTS_DIR).filter(d => fs.statSync(path.join(ACCOUNTS_DIR, d)).isDirectory())];
  const accounts = [{ name: named.main || env.CLAUDE_MAIN_NAME || 'Claude', dir: null },
    ...[...new Set(others)].map(d => ({ name: d, dir: path.join(ACCOUNTS_DIR, d) }))];
  const rows = [];
  for (const a of accounts) {
    if (a.dir && !fs.existsSync(path.join(a.dir, '.credentials.json')) && !fs.existsSync(path.join(a.dir, '.claude.json'))) {
      rows.push({ account: a.name, used: null, limit: 100, unit: 'claude', note: 'not signed in yet', live: true });
      continue;
    }
    try { rows.push(await usageOf(a.name, a.dir)); }
    catch (err) { rows.push({ account: a.name, used: null, limit: 100, unit: 'claude', note: 'not signed in', live: true }); console.error(`claude /usage (${a.name}):`, err.message); }
  }
  claudeUsage = rows;
  state.tokens = tokenRows();
}

// The usage panel: the Claude accounts only. (The lead finder's own services
// show in its tracker when they run out.)
const tokenAlerted = {};
function tokenRows() {
  const rows = [...claudeUsage];
  for (const r of rows) {
    if (r.used == null) continue;
    const day = localDate(new Date());
    if (r.used >= 100) log('error', 'tokens', `${r.account}'s Claude session is used up${r.note ? ` (${r.note})` : ''}`, { panel: 'meta', key: `cl100:${r.account}:${day}:${r.note}` });
    else if (r.used >= 90) log('warn', 'tokens', `${r.account}'s Claude session is at ${r.used}%`, { panel: 'meta', key: `cl90:${r.account}:${day}:${r.note}` });
  }
  return rows;
}

// --- Supabase (FlowDesk and Innolink)

let flowdeskToken = null;
async function flowdeskHeaders() {
  if (FLOWDESK.service) return { apikey: FLOWDESK.service, Authorization: `Bearer ${FLOWDESK.service}` };
  if (!flowdeskToken || flowdeskToken.expires < Date.now() + 60_000) {
    const res = await fetch(`${FLOWDESK.url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: FLOWDESK.anon, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: FLOWDESK.email, password: FLOWDESK.password }),
    });
    if (!res.ok) throw new Error(`FlowDesk login ${res.status}`);
    const j = await res.json();
    flowdeskToken = { value: j.access_token, expires: Date.now() + j.expires_in * 1000 };
  }
  return { apikey: FLOWDESK.anon, Authorization: `Bearer ${flowdeskToken.value}` };
}

async function rest(base, pathAndQuery, headers) {
  const res = await fetch(`${base}/rest/v1/${pathAndQuery}`, { headers, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${pathAndQuery.split('?')[0]} ${res.status}`);
  return res.json();
}

// FlowDesk keeps work in two places: tasks (started and finished in
// activity_logs, done in completion_logs) and project to-dos (ticked off with
// completed_by). What someone is doing NOW is a task they started today and
// haven't finished; nobody with one shows red on the TV. FlowDesk's own
// notifications (starts, completions, reopens, workload alerts, chat) are the
// feed for the live log.
let flowdeskFirst = true;
async function refreshFlowdesk() {
  const configured = Boolean(FLOWDESK.url && (FLOWDESK.service || (FLOWDESK.anon && FLOWDESK.email && FLOWDESK.password)));
  if (!configured) { state.flowdesk = { ok: false, configured: false }; return; }
  try {
    const h = await flowdeskHeaders();
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const weekAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).toISOString();
    const dayAgo = new Date(Date.now() - 864e5).toISOString();
    const today = localDate(now);
    const q = encodeURIComponent;
    const [users, done, todos, acts, tasks, notes, todoNew, worklog] = await Promise.all([
      rest(FLOWDESK.url, 'users?select=id,name,avatar_initials,job_title,role,is_active&is_active=eq.true&order=name', h),
      rest(FLOWDESK.url, `completion_logs?select=id,employee_id,task_id,due_date,completed_at,tasks(title)&completed_at=gte.${q(weekAgo)}&order=completed_at.desc`, h),
      rest(FLOWDESK.url, `project_todos?select=id,title,completed_at,completed_by&completed_at=gte.${q(weekAgo)}&order=completed_at.desc`, h),
      rest(FLOWDESK.url, `activity_logs?select=id,action,timestamp,actor_id,task_id,tasks(title)&timestamp=gte.${q(midnight)}&order=timestamp.asc`, h),
      rest(FLOWDESK.url, 'tasks?select=id,title,frequency,task_assignments(employee_id)&is_active=eq.true', h),
      rest(FLOWDESK.url, `notifications?select=id,type,title,message,created_at,subject_user_id&created_at=gte.${q(dayAgo)}&type=neq.task_overdue&order=created_at.asc`, h),
      rest(FLOWDESK.url, `project_todos?select=id,title,created_at,created_by,assignee_id&created_at=gte.${q(dayAgo)}&order=created_at.asc`, h),
      rest(FLOWDESK.url, `work_log_entries?select=id,author_id,title,minutes,created_at&created_at=gte.${q(dayAgo)}&order=created_at.asc`, h),
    ]);
    // The admin to-do list: FlowDesk's shared "To do" list (no owner), not anyone's own list.
    const lists = await rest(FLOWDESK.url, 'project_todo_lists?select=id,name,owner_id,created_at&order=created_at.asc', h);
    const adminList = lists.find(l => !l.owner_id && /to ?do/i.test(l.name || '')) || lists.find(l => !l.owner_id);
    const listTodos = adminList ? await rest(FLOWDESK.url, `project_todos?select=id,title,is_completed,completed_at,assignee_id,do_date,is_urgent,sort_order&list_id=eq.${adminList.id}&order=sort_order.asc`, h) : [];
    const names = Object.fromEntries(users.map(u => [u.id, u.name.split(' ')[0]]));
    const who = id => names[id] || 'Someone';

    // Doing now: started today, not finished since (per person, newest first).
    const open = {};
    for (const a of acts) {
      const mine = open[a.actor_id] || (open[a.actor_id] = new Map());
      if (a.action === 'in_progress') mine.set(a.task_id, { title: a.tasks?.title || 'a task', since: a.timestamp });
      else if (a.action === 'completed' || a.action === 'missed') mine.delete(a.task_id);
    }
    // Due today: one-off tasks dated today, and monthly ones that fall today.
    const isToday = f => f?.type === 'one-off' ? f.date === today
      : f?.type === 'monthly' ? now.getDay() === f.dayOfWeek && Math.ceil(now.getDate() / 7) === f.weekOfMonth : false;
    const doneToday = new Set(done.filter(c => c.due_date === today).map(c => `${c.task_id}|${c.employee_id}`));

    const finishedItems = [
      ...done.map(c => ({ who: c.employee_id, at: c.completed_at, title: c.tasks?.title || 'a task' })),
      ...todos.filter(t => t.completed_by).map(t => ({ who: t.completed_by, at: t.completed_at, title: t.title })),
    ].sort((a, b) => (a.at < b.at ? 1 : -1));

    const staff = users.filter(u => u.role === 'employee');
    const people = (staff.length ? staff : users).map(u => {
      const mine = finishedItems.filter(f => f.who === u.id);
      const mineTasks = tasks.filter(t => (t.task_assignments || []).some(a => a.employee_id === u.id));
      const working = [...(open[u.id] || new Map()).values()].sort((a, b) => (a.since < b.since ? 1 : -1));
      return {
        name: u.name, initials: u.avatar_initials, title: u.job_title,
        done: mine.filter(f => f.at >= midnight).length, week: mine.length,
        working: working.map(w => w.title), since: working[0]?.since || null,
        // Today, as FlowDesk shows it: what is due today and not yet done.
        dueToday: mineTasks.filter(t => isToday(t.frequency) && !doneToday.has(`${t.id}|${u.id}`)).map(t => t.title),
        dueTotal: mineTasks.filter(t => isToday(t.frequency)).length,
        lastDone: mine[0]?.title || null,
      };
    }).sort((a, b) => b.working.length - a.working.length || b.done - a.done || a.name.localeCompare(b.name));

    // The live log: FlowDesk's notifications, new to-dos and work logged.
    const history = flowdeskFirst || undefined;
    const NOTE = {
      task_started: (n) => ['info', `${who(n.subject_user_id)} started "${n.message}"`],
      task_completed: (n) => ['win', `${who(n.subject_user_id)} finished "${n.message}"`],
      task_reopened: (n) => ['warn', `${who(n.subject_user_id)} reopened "${n.message}"`],
      workload_alert: (n) => ['warn', `${n.title}: ${n.message}`],
      chat_message: (n) => ['info', `${who(n.subject_user_id)} sent a message: ${n.title || 'chat'}`],
    };
    const lastSeen = {};
    for (const n of notes) {
      const make = NOTE[n.type] || ((x) => ['info', `${x.title}: ${x.message || ''}`.trim()]);
      const [level, text] = make(n);
      // The same event is notified to each admin; keep one per minute.
      const dupe = `${n.type}|${n.message}|${n.subject_user_id}|${n.created_at.slice(0, 16)}`;
      if (lastSeen[dupe]) continue;
      lastSeen[dupe] = true;
      log(history ? (level === 'win' ? 'info' : level) : level, 'flowdesk', text,
        { key: 'fdn:' + n.id, at: n.created_at, panel: 'team', title: level === 'win' ? 'TASK DONE' : undefined, history });
    }
    for (const t of todoNew) log('info', 'flowdesk', `${who(t.created_by)} added a to-do: "${t.title}"${t.assignee_id && t.assignee_id !== t.created_by ? ` for ${who(t.assignee_id)}` : ''}`, { key: 'fdt:' + t.id, at: t.created_at, panel: 'team', history });
    for (const t of todos.filter(x => x.completed_by && x.completed_at >= dayAgo)) log(history ? 'info' : 'win', 'flowdesk', `${who(t.completed_by)} ticked off "${t.title}"`, { key: 'fdd:' + t.id, at: t.completed_at, panel: 'team', title: 'TASK DONE', history });
    for (const w of worklog) log('info', 'flowdesk', `${who(w.author_id)} logged work: "${w.title}"${w.minutes ? ` (${w.minutes} min)` : ''}`, { key: 'fdw:' + w.id, at: w.created_at, panel: 'team', history });
    for (const p of people) p.status = p.working.length ? 'working' : p.dueToday.length ? 'todo' : 'clear';
    // Someone with work due today and nothing started: flag it once a day, in working hours.
    const hour = now.getHours();
    if (hour >= 9 && hour < 18) for (const p of people) if (p.status === 'todo') log('warn', 'flowdesk', `${p.name.split(' ')[0]} has "${p.dueToday[0]}" due today and nothing started`, { key: `idle:${today}:${p.name}`, panel: 'team' });
    flowdeskFirst = false;

    const firstName = (id) => (users.find(u => u.id === id)?.name || '').split(' ')[0];
    const todo = {
      name: adminList?.name || 'To do',
      // Who it is for, unless it is the admin (it's the admin's list anyway).
      open: listTodos.filter(t => !t.is_completed).map(t => ({ title: t.title, who: t.assignee_id && users.find(u => u.id === t.assignee_id)?.role !== 'admin' ? firstName(t.assignee_id) : '', doDate: t.do_date, urgent: !!t.is_urgent })),
      doneToday: listTodos.filter(t => t.is_completed && t.completed_at >= midnight).length,
    };
    state.flowdesk = {
      ok: true, configured: true, people, todo,
      doneToday: finishedItems.filter(f => f.at >= midnight).length, doneWeek: finishedItems.length,
      inProgress: people.reduce((sum, p) => sum + p.working.length, 0),
      idle: people.filter(p => p.status === 'todo').length,
    };
    sourceOk('flowdesk');
  } catch (err) {
    state.flowdesk = { ...state.flowdesk, ok: false, configured: true };
    sourceFailed('flowdesk', err, 'team');
  }
}

async function refreshInnolink() {
  if (!INNOLINK.service) { state.innolink = { ok: false, configured: false }; return; }
  try {
    const h = { apikey: INNOLINK.service, Authorization: `Bearer ${INNOLINK.service}` };
    const rows = await rest(INNOLINK.url, 'clients?select=slug,name,views,credit_clicks,published,links(clicks,enabled)&order=views.desc', h);
    const clients = rows.map(c => ({
      slug: c.slug, name: c.name, published: c.published,
      views: c.views, credit: c.credit_clicks,
      clicks: (c.links || []).reduce((s, l) => s + (l.clicks || 0), 0),
      links: (c.links || []).filter(l => l.enabled).length,
    }));
    const views = clients.reduce((s, c) => s + c.views, 0);
    const clicks = clients.reduce((s, c) => s + c.clicks, 0);
    const prev = state.innolink;
    if (prev.ok) {
      const before = Object.fromEntries(prev.clients.map(c => [c.slug, c]));
      for (const c of clients) {
        const b = before[c.slug];
        if (!b) { log('win', 'innolink', `New Innolink page: ${c.name}`, { panel: 'link', big: true, title: 'NEW INNOLINK' }); continue; }
        const dv = c.views - b.views, dc = c.clicks - b.clicks;
        if (dv > 0 || dc > 0) log('info', 'innolink', `${c.name}: ${dv > 0 ? `+${dv} open${dv > 1 ? 's' : ''}` : ''}${dv > 0 && dc > 0 ? ', ' : ''}${dc > 0 ? `+${dc} click${dc > 1 ? 's' : ''}` : ''}`, { panel: 'link' });
      }
      const step = 100;
      if (Math.floor(views / step) > Math.floor(prev.views / step)) log('win', 'innolink', `Innolink pages passed ${fmt(Math.floor(views / step) * step)} opens`, { panel: 'link', big: true, title: `${fmt(Math.floor(views / step) * step)} OPENS` });
    }
    state.innolink = { ok: true, configured: true, clients, views, clicks };
    sourceOk('innolink');
  } catch (err) {
    state.innolink = { ...state.innolink, ok: false, configured: true };
    sourceFailed('innolink', err, 'link');
  }
}

// --- site health. Two misses in a row before a site counts as down, so one
// slow answer at night doesn't wake the office.

const misses = {};
let lastUp = null;
async function pingSite(url) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'InnowebJarvis/1.0 (health check)' } });
    await res.arrayBuffer();
    return { status: res.status, ms: Date.now() - t0, ok: res.status < 400 };
  } catch (err) {
    return { status: 0, ms: Date.now() - t0, ok: false, error: String(err.cause?.code || err.name || err) };
  }
}

async function refreshSites() {
  // Innolink pages aren't checked: every visit counts as an "open" on the
  // client's Innolink stats, and a check every 5 minutes inflated them.
  const sites = (state.board?.sites || []).filter(s => !isInnolink(s.url));
  const results = await Promise.all(sites.map(s => pingSite(s.url).then(r => [s, r])));
  // A site that didn't answer gets a second try 20 seconds later.
  if (results.some(([, r]) => !r.ok)) {
    await new Promise(r => setTimeout(r, 20000));
    for (const pair of results) if (!pair[1].ok) pair[1] = await pingSite(pair[0].url);
  }
  // Most sites failing together is this computer's internet, not the sites.
  const failing = results.filter(([, r]) => !r.ok).length;
  if (results.length >= 4 && failing >= Math.ceil(results.length * 0.6)) {
    log('warn', 'sites', `This computer's internet dropped: ${failing} sites didn't answer, so none is counted as down`, { panel: 'site', quiet: true });
    return;
  }
  for (const [s, r] of results) {
    const was = state.sites[s.url];
    if (r.ok) {
      if (was && !was.ok && misses[s.url] >= 2) log('info', 'sites', `${s.name} is back up (${r.status} in ${r.ms} ms)`, { panel: 'site' });
      misses[s.url] = 0;
      state.sites[s.url] = r;
    } else {
      misses[s.url] = (misses[s.url] || 0) + 1;
      if (misses[s.url] === 2) log('error', 'sites', `${s.name} is DOWN (${r.status || r.error})`, { panel: 'site', url: s.url });
      if (misses[s.url] >= 2) state.sites[s.url] = r;
    }
  }
  // Report the count only when it changes; the downs and recoveries are logged above.
  const up = results.filter(([, r]) => r.ok).length;
  if (lastUp !== null ? up !== lastUp : up < results.length) log('info', 'sites', `${up} of ${results.length} sites answering`, { panel: 'site', quiet: true });
  lastUp = up;
}

// --- screenshots for the "Our work" panel. A TV can't load a whole site in
// the three seconds each one is shown, so the panel flips through pictures
// taken here (scripts/shoot.py) and kept fresh every six hours.

const slugOf = (url) => url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
let shooting = false;

// Each site's picture, and the smaller copy when there is one, with the file's
// time on the end so a screen fetches a retaken picture instead of its old copy.
function shotUrls(slug) {
  const full = path.join(SHOTS, slug + '.jpg'), small = path.join(SHOTS, slug + '.960.jpg');
  const v = (f) => Math.round(fs.statSync(f).mtimeMs);
  return { full: `/shots/${slug}.jpg?v=${v(full)}`, small: fs.existsSync(small) ? `/shots/${slug}.960.jpg?v=${v(small)}` : null };
}

function loadShots() {
  for (const s of state.board?.sites || []) {
    try { state.shots[s.url] = shotUrls(slugOf(s.url)); } catch {}
  }
}

// --- films of every demo we've built, for "Our work". The TV's browser can't
// run today's websites, so the PC films each one scrolling (scripts/record_demos.py)
// and the TV plays the films. New demos are filmed as they appear.
const FILMS = path.join(PUBLIC, 'demos');
let filming = false, filmQueued = false;
// Innolink pages are never opened by Jarvis (checked, filmed or shown): every
// visit counts as an open on the client's stats.
const isInnolink = (u) => /(^|\.)innolink\.info\b/i.test(String(u || '').replace(/^https?:\/\//, ''));
function demoList() {
  const seen = new Set(), list = [];
  for (const d of [...(state.board?.sites || []), ...((state.leads.ok && state.leads.demos) || [])]) {
    const url = d.url.replace(/\/$/, '');
    if (seen.has(url) || isInnolink(url)) continue;
    seen.add(url);
    const slug = slugOf(url), file = path.join(FILMS, slug + '.webm');
    let film = null;
    try { film = `/demos/${slug}.webm?v=${Math.round(fs.statSync(file).mtimeMs)}`; } catch {}
    list.push({ name: d.name, url, film });
  }
  return list;
}
function filmDemos() {
  if (filming) { filmQueued = true; return; }
  const todo = demoList().filter(d => !d.film);
  if (!todo.length) return;
  filming = true;
  fs.mkdirSync(FILMS, { recursive: true });
  const py = spawn(env.PYTHON || 'python', ['-I', path.join(ROOT, 'scripts', 'record_demos.py'), FILMS], { windowsHide: true });
  py.stdin.end(JSON.stringify(todo.map(d => ({ slug: slugOf(d.url), url: d.url }))));
  let made = 0;
  py.stdout.on('data', d => { made += (String(d).match(/^ok /gm) || []).length; });
  py.stderr.on('data', d => console.error('record_demos:', String(d).trim().slice(0, 300)));
  py.on('close', () => {
    filming = false;
    if (made) log('info', 'sites', `Filmed ${made} demo site${made > 1 ? 's' : ''} for the TV`, { panel: 'site', quiet: true });
    if (filmQueued) { filmQueued = false; filmDemos(); }
  });
}

// --- WhatsApp: scripts/whatsapp_bridge.py keeps WhatsApp Web open on this PC
// (linked once with a QR code) and reads the Innoweb group. New messages from
// others go into the live log and Jarvis reads them out.
const WA_GROUP = env.WHATSAPP_GROUP || 'Innoweb';
state.whatsapp = { state: 'off', ready: false, qr: null, chat: null, messages: [] };
let waSeen = null;
// The TV showing WhatsApp: the bridge sends pictures of the screen and takes
// moves (open a chat, scroll). Nobody looking for 10 minutes: it stops.
let waProc = null, waScreen = null, waNextId = 1, waWatchTimer = null;
const waWaiting = new Map();
function waSend(obj) { if (waProc) try { waProc.stdin.write(JSON.stringify(obj) + '\n'); } catch {} }
function waCmd(obj) {
  if (!waProc || !state.whatsapp.ready) return Promise.resolve({ ok: false, detail: 'WhatsApp is not linked right now' });
  const id = waNextId++;
  return new Promise(resolve => {
    const timer = setTimeout(() => { waWaiting.delete(id); resolve({ ok: false, detail: 'WhatsApp took too long' }); }, 25000);
    waWaiting.set(id, (r) => { clearTimeout(timer); resolve(r); });
    waSend({ ...obj, id });
  });
}
function waWatch(on) {
  state.whatsapp.watching = on;
  waSend({ cmd: 'watch', on });
  clearTimeout(waWatchTimer);
  if (on) waWatchTimer = setTimeout(() => waWatch(false), 10 * 60000);
}

function startWhatsApp() {
  const py = waProc = spawn(env.PYTHON || 'python', ['-u', path.join(ROOT, 'scripts', 'whatsapp_bridge.py'), path.join(DATA, 'whatsapp', 'main'), WA_GROUP], { windowsHide: true });
  let buf = '';
  py.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      const wa = state.whatsapp;
      if (m.type === 'status') {
        if (m.state === 'ready' && !wa.ready) log('info', 'whatsapp', 'WhatsApp is linked to Jarvis', { panel: 'site' });
        wa.state = m.state; wa.ready = m.state === 'ready'; wa.detail = m.detail || wa.detail;
        if (wa.ready) wa.qr = null;
      } else if (m.type === 'qr') {
        wa.qr = 'data:image/png;base64,' + m.png;
      } else if (m.type === 'chats') {
        noteChats((m.names || []).filter(Boolean), m.all);
      } else if (m.type === 'screen') {
        waScreen = Buffer.from(m.jpg, 'base64');
        wa.screenAt = Date.now();
      } else if (m.type === 'done') {
        const w = waWaiting.get(m.id);
        if (w) { waWaiting.delete(m.id); w(m); }
      } else if (m.type === 'chat') {
        wa.chat = m.name; wa.messages = m.messages;
        const keyOf = (x) => `${x.time}|${x.from}|${x.text}`;
        if (waSeen) {
          for (const x of m.messages) {
            if (waSeen.has(keyOf(x)) || x.mine) continue;
            log('info', 'whatsapp', `${x.from}: ${x.text}`.slice(0, 200), { panel: 'site' });
            announce(`New message in ${m.name} from ${x.from}: ${x.text}`.slice(0, 300), null);
          }
        }
        waSeen = new Set(m.messages.map(keyOf));
      }
    }
  });
  py.stderr.on('data', d => console.error('whatsapp:', String(d).trim().slice(0, 300)));
  py.on('close', () => { waProc = null; state.whatsapp.state = 'off'; state.whatsapp.ready = false; setTimeout(startWhatsApp, 30000); });
}

// --- the live site. Vercel serves the pages and checks the password; the data,
// voice and films come from this PC through a Cloudflare tunnel. The tunnel's
// address changes when it restarts, so it is published (with nothing secret in
// it) where the Vercel site reads it. Requests through the tunnel must carry
// RELAY_SECRET, which only the Vercel site has.
const RELAY_SECRET = env.RELAY_SECRET || '';
const TUNNEL_BIN = path.join(ROOT, 'bin', 'cloudflared.exe');
state.tunnel = null;
async function publishTunnel(url) {
  if (!INNOLINK.service) return;
  const h = { apikey: INNOLINK.service, Authorization: `Bearer ${INNOLINK.service}` };
  await fetch(`${INNOLINK.url}/storage/v1/bucket`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'jarvis-public', name: 'jarvis-public', public: true }) }).catch(() => {});
  const res = await fetch(`${INNOLINK.url}/storage/v1/object/jarvis-public/tunnel.json`, {
    method: 'POST', headers: { ...h, 'Content-Type': 'application/json', 'x-upsert': 'true', 'cache-control': 'max-age=5' },
    body: JSON.stringify({ url, at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`publish tunnel ${res.status}`);
}
// Cloudflare's free tunnels sometimes go dead while cloudflared keeps running:
// every minute Jarvis fetches a small file through its own tunnel, and after
// two misses in a row it starts a new tunnel (which publishes its new address).
let tunnelProc = null, tunnelStarted = 0, tunnelMisses = 0;
setInterval(async () => {
  if (!tunnelProc || !state.tunnel || Date.now() - tunnelStarted < 90000) return;
  try {
    const res = await fetch(`${state.tunnel}/mark.svg`, { headers: { 'x-jarvis-relay': RELAY_SECRET }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(String(res.status));
    tunnelMisses = 0;
  } catch (err) {
    if (++tunnelMisses >= 2) {
      log('warn', 'jarvis', 'The live site lost its connection; reconnecting', { quiet: true });
      tunnelMisses = 0;
      try { tunnelProc.kill(); } catch {}
    }
  }
}, 60000);

function startTunnel() {
  if (!RELAY_SECRET || !fs.existsSync(TUNNEL_BIN)) return;
  tunnelStarted = Date.now();
  const cf = tunnelProc = spawn(TUNNEL_BIN, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], { windowsHide: true });
  const seen = (d) => {
    const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && m[0] !== state.tunnel) {
      state.tunnel = m[0];
      publishTunnel(m[0]).then(() => log('info', 'jarvis', 'Live site connected', { quiet: true })).catch(err => console.error('tunnel:', err.message));
    }
  };
  cf.stdout.on('data', seen); cf.stderr.on('data', seen);
  cf.on('close', () => { if (tunnelProc === cf) tunnelProc = null; state.tunnel = null; setTimeout(startTunnel, 5000); });
}

function shootSites(onlyMissing) {
  if (shooting) return;
  const sites = (state.board?.sites || []).filter(s => !isInnolink(s.url) && (!onlyMissing || !state.shots[s.url]));
  if (!sites.length) return;
  shooting = true;
  const py = spawn(env.PYTHON || 'python', ['-I', path.join(ROOT, 'scripts', 'shoot.py'), SHOTS], { windowsHide: true });
  py.stdin.end(JSON.stringify(sites.map(s => ({ slug: slugOf(s.url), url: s.url }))));
  let out = '';
  py.stdout.on('data', d => {
    out += d;
    let i;
    while ((i = out.indexOf('\n')) >= 0) {
      const [status, slug] = out.slice(0, i).trim().split(' ');
      out = out.slice(i + 1);
      const site = sites.find(s => slugOf(s.url) === slug);
      if (status === 'ok' && site) state.shots[site.url] = shotUrls(slug);
    }
  });
  py.stderr.on('data', d => console.error(String(d).trim()));
  py.on('close', code => {
    shooting = false;
    log('info', 'sites', `Fresh pictures of ${sites.length} site${sites.length > 1 ? 's' : ''} taken`, { panel: 'site', quiet: true });
    if (code) console.error('shoot.py exited with', code);
  });
}

// --- voice. Whatever someone says to Jarvis (from /voice) comes in here. The
// common commands are understood on the spot; anything else goes to Claude.
// Each answer becomes a command the TV picks up within a second: it acts on it
// (zoom into a panel, show a site, reload...) and speaks the reply.

const PANEL_NAMES = { ach: 'Goal', todo: 'To-do list', pipe: 'Pipeline', site: 'Our work', meta: 'Claude usage', team: 'FlowDesk team', cd: 'Countdown', lead: 'Lead finder', link: 'Innolink', log: 'Live log' };
// First match wins, so the specific words come before the general ones.
const PANEL_WORDS = [
  ['link', ['innolink', 'enolink', 'inno link', 'eno link', 'inner link', 'linktree', 'link pages?', 'links', 'clicks', 'opens']],
  ['meta', ['claude', 'usage', 'tokens?', 'limits?', 'sessions?', 'credits']],
  ['todo', ['to ?do', 'to do list', 'todo', 'admin list']],
  ['ach', ['goal', 'money', 'revenue']],
  ['pipe', ['pipeline', 'funnel', 'replies', 'replied', 'conversions?', 'won', 'closed deals?', 'follow ?ups?']],
  ['team', ['flowdesk', 'flow desk', 'team', 'employees?', 'staff', 'tasks?', 'people', 'workers?']],
  ['lead', ['lead finder', 'leads?', 'outreach', 'contacts?', 'emails? sent', 'prospects?']],
  ['cd', ['countdown', 'count down', 'timer', 'november', 'deadline', 'days left', 'how long']],
  ['ach', ['achievements?', 'money', 'revenue', 'goal', 'target', 'clients?', 'deals?', 'made', 'sales', 'earn(ed)?', 'built', 'progress']],
  ['site', ['our work', 'websites?', 'sites?', 'portfolio', 'showcase', 'rotator']],
  ['log', ['live log', 'logs?', 'activity', 'events', 'alerts?', 'errors?']],
];
const GENERIC_WORDS = new Set(['cafe', 'café', 'coffee', 'lounge', 'beauty', 'rentals', 'club', 'beach', 'roasters', 'innolink', 'the']);
const has = (t, words) => words.some(w => new RegExp(`\\b${w}\\b`).test(t));

function matchPanel(t) {
  for (const [key, words] of PANEL_WORDS) if (has(t, words)) return key;
  return null;
}
function matchSite(t) {
  for (const s of state.board?.sites || []) {
    const name = s.name.toLowerCase();
    const words = name.split(/[^a-zà-ú0-9]+/).filter(w => w.length >= 4 && !GENERIC_WORDS.has(w));
    if (t.includes(name) || words.some(w => new RegExp(`\\b${w}\\b`).test(t))) return s;
  }
  return null;
}

const eur = n => '€' + Math.round(n || 0).toLocaleString('en-IE');
function answer(panel) {
  const b = state.board || {}, a = b.achievements || {};
  switch (panel) {
    case 'ach': {
      const td = state.flowdesk.todo;
      return `We've made ${eur(a.revenue)} of the ${eur(a.revenueGoal)} goal.${td ? ` The to-do list has ${td.open.length} open${td.open[0] ? `, starting with ${td.open[0].title}` : ''}.` : ''}`;
    }
    case 'todo': {
      const td = state.flowdesk.todo;
      return td ? `${td.open.length} things on the to-do list${td.open[0] ? `. First: ${td.open[0].title}` : ''}.` : 'I cannot read the to-do list right now.';
    }
    case 'pipe': {
      const pl = state.leads.pipeline;
      if (!pl) return 'I am still reading the pipeline.';
      const pc = (x, y) => (y ? Math.round((x / y) * 100) : 0);
      return `${pl.sent} businesses contacted, ${pl.replied} replied, that's ${pc(pl.replied, pl.sent)} percent. We answered ${pl.answered}, ${pl.followUp} have a follow-up and ${pl.won} are won.`;
    }
    case 'cd': {
      let left = Math.max(0, new Date(b.countdown?.target) - Date.now());
      const d = Math.floor(left / 864e5); left -= d * 864e5;
      const h = Math.floor(left / 36e5); left -= h * 36e5;
      return `${d} days, ${h} hours and ${Math.floor(left / 6e4)} minutes until ${b.countdown?.label}.`;
    }
    case 'meta': {
      const rows = state.tokens.map(t => t.used == null ? `${t.account} is not signed in yet` : `${t.account} is at ${t.used} percent of the session${t.week != null ? ` and ${t.week} percent of the week` : ''}`);
      return rows.length ? rows.join('. ') + '.' : 'I am still reading the Claude usage.';
    }
    case 'team': {
      const f = state.flowdesk;
      if (!f.ok) return f.configured ? 'FlowDesk is not answering right now.' : 'FlowDesk is not connected yet. It needs its key in my settings.';
      const busy = f.people.map(p => p.working.length ? `${p.name.split(' ')[0]} is on ${p.working[0]}` : `${p.name.split(' ')[0]} has nothing started${p.dueToday.length ? `, with ${p.dueToday[0]} due today` : ''}`).join('. ');
      return `${f.doneToday} tasks done today and ${f.doneWeek} this week. ${busy}.`;
    }
    case 'lead': {
      const l = state.leads;
      if (!l.ok) return 'I cannot read the lead finder right now.';
      const tr = l.tracker || {};
      const doing = !tr.online ? 'The Mac running it is not reporting.' : tr.queuePaused || tr.buildPaused ? `It is stuck: ${tr.queuePaused || tr.buildPaused}` : tr.building?.length ? `It is building ${tr.building.length} websites.` : tr.finder ? `Right now: ${tr.finder}.` : '';
      return `Today: ${l.sitesSentToday} websites sent, ${l.whatsappToday} WhatsApps and ${l.leadsToday} new leads, ${l.repliesToday} replies. ${doing}`;
    }
    case 'link': {
      const i = state.innolink;
      if (!i.ok) return 'Innolink is not connected yet. It needs its key in my settings.';
      const top = i.clients[0];
      return `Innolink pages have ${i.views} opens and ${i.clicks} clicks.${top ? ` ${top.name} leads with ${top.views} opens.` : ''}`;
    }
    case 'site': {
      const all = Object.values(state.sites), down = (state.board?.sites || []).filter(s => state.sites[s.url] && !state.sites[s.url].ok);
      return `${(state.board?.sites || []).length} sites on rotation. ${down.length ? `${down.map(s => s.name).join(' and ')} ${down.length > 1 ? 'are' : 'is'} down.` : `All ${all.length} are answering.`}`;
    }
    case 'log': return briefing();
  }
  return '';
}
function briefing() {
  const errs = events.filter(e => e.level === 'error' && Date.now() - Date.parse(e.at) < 864e5).length;
  const down = Object.values(state.sites).filter(s => !s.ok).length;
  const a = state.board?.achievements || {};
  return `All systems ${errs || down || Object.keys(failing).length ? 'mostly' : ''} running. ${eur(a.revenue)} of ${eur(a.revenueGoal)} so far, ${a.clientsManaged} clients. ${down ? `${down} sites down.` : 'Every site is up.'} ${errs ? `${errs} alert${errs > 1 ? 's' : ''} in the last day.` : 'No alerts in the last day.'}`.replace(/\s+/g, ' ').trim();
}

// The whole picture, for "give me a summary": read out while the TV shows each panel in turn.
function overview() {
  const a = state.board?.achievements || {}, l = state.leads, f = state.flowdesk;
  const parts = [`We're at ${eur(a.revenue)} of ${eur(a.revenueGoal)}.`];
  if (l.ok) parts.push(`Today the lead finder sent ${l.sitesSentToday} websites and ${l.whatsappToday} WhatsApps, and found ${l.leadsToday} new leads.`);
  if (l.ok && l.pipeline) parts.push(l.pipeline.replied ? `${l.pipeline.replied} of the ${l.pipeline.sent} businesses we contacted have replied.` : `None of the ${l.pipeline.sent} businesses we contacted have replied yet.`);
  if (f.ok) parts.push(f.people.map(p => p.status === 'working' ? `${p.name.split(' ')[0]} is on ${p.working[0]}` : p.status === 'todo' ? `${p.name.split(' ')[0]} hasn't started ${p.dueToday[0]}` : `${p.name.split(' ')[0]} is done for today`).join(', ') + '.');
  if (f.ok && f.todo) parts.push(`${f.todo.open.length} things on the to-do list.`);
  const down = Object.keys(failing);
  parts.push(down.length ? `Heads up: ${down.join(' and ')} ${down.length > 1 ? 'are' : 'is'} offline.` : 'Everything is online.');
  return parts.join(' ');
}

// Which WhatsApp chat they meant, from what speech recognition heard ("eno webb",
// "so my order"): every run of words in the sentence is compared with every chat
// name, by spelling and by sound (consonants only, doubled letters merged).
const CHAT_STOP = new Set(['open', 'up', 'the', 'a', 'an', 'chat', 'chats', 'conversation', 'conversations', 'group', 'with', 'from', 'called', 'named', 'on', 'whatsapp', 'whats', 'app',
  'please', 'can', 'you', 'could', 'would', 'show', 'me', 'go', 'to', 'pull', 'bring', 'search', 'for', 'find', 'click', 'select', 'tap', 'check', 'enter', 'into', 'messages', 'message',
  'fucking', 'fuck', 'now', 'jarvis', 'honey', 'babe', 'darling', 'one', 'it', 'its', 'that', 'this', 'there', 'and', 'i', 'see', 'let', 'look', 'at', 'of', 'just', 'hey', 'ok', 'okay', 'oh']);
const squash = (x) => norm(x).replace(/[^a-z0-9]/g, '').replace(/(.)\1+/g, '$1');
const sound = (x) => squash(x).replace(/ph/g, 'f').replace(/[ck]/g, 'k').replace(/[sz]/g, 's').replace(/[aeiouyhw]/g, '');
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
const sim = (a, b) => (a && b ? 1 - lev(a, b) / Math.max(a.length, b.length) : 0);
// How well a heard piece matches a name: the whole name, or how the name starts.
// How well a heard piece matches a name: the whole name, how it starts, or any run of its words.
function score(heard, name, f, min) {
  const h = f(heard), n = f(name);
  if (h.length < min || !n) return 0;
  let best = sim(h, n);
  for (let k = Math.max(2, h.length - 2); k <= h.length + 2; k++) best = Math.max(best, sim(h, n.slice(0, k)) * 0.93);
  const tokens = norm(name).split(/\s+/);
  for (let i = 1; i < tokens.length; i++) for (let j = i + 1; j <= tokens.length; j++) best = Math.max(best, sim(h, f(tokens.slice(i, j).join(' '))) * 0.9);
  return best;
}
function matchChat(said, names) {
  const words = norm(said).replace(/[^a-z0-9+ ]/g, ' ').split(/\s+/).filter(w => w && !CHAT_STOP.has(w));
  let best = null;
  for (const name of names) {
    for (let i = 0; i < words.length; i++) {
      for (let len = 1; len <= Math.min(5, words.length - i); len++) {
        const piece = words.slice(i, i + len).join(' ');
        if (squash(piece).length < 3) continue;
        const sc = Math.max(score(piece, name, squash, 3), score(piece, name, sound, 3) * 0.95);
        if (!best || sc > best.score) best = { name, score: sc, piece };
      }
    }
  }
  return best && best.score >= 0.6 ? best : null;
}
// "the fourth one", "third chat", "number 2": a position on screen (0 = the top).
const ORD = { first: 0, '1st': 0, one: 0, second: 1, '2nd': 1, two: 1, third: 2, '3rd': 2, three: 2, fourth: 3, '4th': 3, four: 3, fifth: 4, '5th': 4, five: 4,
  sixth: 5, '6th': 5, six: 5, seventh: 6, '7th': 6, seven: 6, eighth: 7, '8th': 7, eight: 7, ninth: 8, '9th': 8, nine: 8, tenth: 9, '10th': 9, ten: 9, top: 0, last: -1 };
function chatPosition(said) {
  const t = norm(said);
  const m = /\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|6th|seventh|7th|eighth|8th|ninth|9th|tenth|10th|top|last)\b(?:\s+(?:one|chat|conversation|group))?/.exec(t)
    || /\bnumber\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b/.exec(t);
  if (!m) return null;
  const w = m[1];
  return /^\d+$/.test(w) ? Number(w) - 1 : ORD[w];
}


// Every WhatsApp chat's name, as the bridge reads them (kept between restarts).
const WA_CHATS_FILE = path.join(DATA, 'whatsapp', 'chats.json');
let waChats = (() => { try { return JSON.parse(fs.readFileSync(WA_CHATS_FILE, 'utf8')); } catch { return []; } })();
function noteChats(names, all) {
  const next = all ? [...names, ...waChats.filter(n => !names.includes(n))] : [...waChats, ...names.filter(n => !waChats.includes(n))];
  if (next.length === waChats.length && next.every((n, i) => n === waChats[i])) return;
  waChats = next.filter(Boolean).slice(0, 2000);
  try { fs.mkdirSync(path.dirname(WA_CHATS_FILE), { recursive: true }); fs.writeFileSync(WA_CHATS_FILE, JSON.stringify(waChats)); } catch {}
}
const OPEN_LINES = ['Here you go, darling.', 'There you go, gorgeous.', 'Opening it, babe.'];
const NOT_FOUND = "I can't find that chat, darling. Say the name again?";
const pickLine = (lines) => lines[Math.floor(Math.random() * lines.length)];

function rules(raw) {
  const t = raw.toLowerCase().replace(/\b(hey |ok |okay )?(jarvis|jervis|javis|travis|charvis)\b/g, ' ').replace(/[^a-z0-9à-ú€ ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return { action: 'none', reply: 'Yes?' };
  const team = (state.flowdesk.people || []).map(p => norm(p.name.split(' ')[0]));
  if (/\b(needs? to|has to|have to|must|should|remind|add (a |the )?task|new task|create (a )?task|assign|give (him|her|them))\b/.test(t)
    && (/\btask\b/.test(t) || team.some(n => norm(t).includes(n)))) return null;
  if (pending && /^(yes|yeah|yep|sure|do it|go ahead|confirm|send it|sim)\b/.test(t)) return { action: 'confirm', reply: '' };
  if (pending && /^(no|nope|cancel|stop|don t|dont|nao|não)\b/.test(t)) { pending = null; return { action: 'none', reply: 'Cancelled.' }; }
  const site = matchSite(t), panel = matchPanel(t);
  const waWords = /\b(whatsapp|whats app|what s app)\b/.test(t);
  if (waWords && /\b(close|hide|get rid of|remove|exit|leave|turn off|stop showing|take (it |that )?off|put away|minimi[sz]e|go back|back to)\b/.test(t) && !/\b(chat list|all (the |my )?chats|back to (the |my )?chats)\b/.test(t)) return { action: 'unzoom', reply: 'Back to everything.' };
  if (state.whatsapp.ready && (state.whatsapp.watching || waWords)) {
    const dir = /\b(down|lower|below|newer|bottom)\b/.test(t) ? 'down' : /\b(up|higher|above|older|top)\b/.test(t) ? 'up' : null;
    if (dir && /\b(scroll|go|move|swipe|page|further|more|keep going|slide)\b/.test(t) && !/\b(pull up|bring up|open up)\b/.test(t)) {
      const where = /\b(chats|chat list|list|conversations|other chat|groups|contacts)\b/.test(t) ? 'list' : 'chat';
      return { action: 'whatsapp_scroll', dir, where, reply: dir === 'up' ? 'Up we go.' : 'Down we go.' };
    }
    if (/\b(chat list|all (the |my )?chats|list of chats|back to (the |my )?chats|close (the |this )?chat)\b/.test(t)) return { action: 'whatsapp_list', reply: 'All your chats.' };
    const openVerb = /\b(open|show|go to|go into|pull up|bring up|search|find|click|select|tap|check|enter|look at|read|get)\b/.test(t);
    const pos = chatPosition(t);
    if (openVerb && pos != null && !panel) return { action: 'whatsapp_open', index: pos, reply: pickLine(OPEN_LINES) };
    const hit = (openVerb || state.whatsapp.watching) && matchChat(t, waChats);
    if (hit && (!panel || hit.score >= 0.9) && !(waWords && !openVerb && hit.score < 0.8)) return { action: 'whatsapp_open', chat: hit.name, reply: pickLine(OPEN_LINES) };
  }
  if (/\b(zoom out|close( it| that)?|exit|go back|back to (normal|everything|the dashboard)|show (me )?everything|all panels|full view|minimi[sz]e|normal view)\b/.test(t) && !(site || panel) || /^(back|close|exit|zoom out)$/.test(t)) return { action: 'unzoom', reply: 'Back to everything.' };
  if (/\b(whatsapp|whats app|what s app)\b/.test(t) && /\b(pull up|show|open|bring up|put up|go to|switch to)\b/.test(t)) return { action: 'whatsapp', reply: state.whatsapp?.ready ? `Here is ${state.whatsapp.chat || 'WhatsApp'}.` : state.whatsapp?.qr ? 'Here is the code to link WhatsApp. Open WhatsApp on the phone, go to Linked devices, and scan it.' : 'WhatsApp is starting up. Give it a moment.' };
  if (/\b(reload|refresh|restart)\b/.test(t)) {
    if (/\b(data|numbers|stats|figures)\b/.test(t)) return { action: 'refresh', reply: 'Refreshing every source now.' };
    if (/\b(pictures|screenshots|websites|sites|our work)\b/.test(t)) return { action: 'reshoot', reply: 'Taking fresh pictures of every site. Give me two minutes.' };
    return { action: 'reload', reply: 'Reloading the screen.' };
  }
  if (/\b(next)\b/.test(t)) return { action: 'next', panel: 'site', reply: 'Next one.' };
  if (/\b(previous|prev|last one|go back one)\b/.test(t)) return { action: 'previous', panel: 'site', reply: 'Going back one.' };
  if (/\b(back ?flip|flip|somersault|cartwheel)\b/.test(t)) return { action: 'backflip', reply: ['Watch this, darling.', 'Hold my tentacles.', 'Ten out of ten, obviously.', 'Show-off mode, on.'][Math.floor(Math.random() * 4)] };
  if (/\b(celebrate|party|confetti|fireworks)\b/.test(t)) return { action: 'celebrate', reply: 'Let us celebrate.' };
  if (/\b(test|sound|try)\b.*\b(alarm|siren)\b|\b(alarm|siren)\b.*\btest\b/.test(t)) return { action: 'alarm', reply: 'Testing the alarm.' };
  if (/\b(unmute|sound on|speak again|talk again|you can talk)\b/.test(t)) return { action: 'unmute', reply: 'I am back.' };
  if (/\b(mute|be quiet|silence|shut up|stop talking)\b/.test(t)) return { action: 'mute', reply: 'Going quiet.' };
  // Plain number questions ("how much money...", "how many leads...") are read
  // straight off the dashboard. Questions that need thinking go to Claude.
  const factual = /^(how (much|many|long|far|close)|what s (the|our)|whats (the|our)|what (is|are) (the|our)|is (the|our)|are (the|our|we)|did|when|which|who|tell me (about|the|how)|give me the)\b/.test(t);
  const question = /^(how|what|whats|why|when|who|which|should|could|can|would|will|is|are|do|does|did|have|has|tell|give|explain|help)\b/.test(t);
  if (/\b(summary|summarise|summarize|overview|briefing|status report|catch me up|update me|how are we doing|how is everything|how s everything|run me through)\b/.test(t)) return { action: 'tour', reply: overview() };
  if (factual && panel) return { action: 'none', reply: answer(panel) };
  if (question) return null;
  if (site) return { action: 'show_site', panel: 'site', site: site.url, reply: `Here is ${site.name}.` };
  const show = /\b(pull up|show|open|zoom|display|bring up|put up|go to|full screen|let me see)\b/.test(t);
  if (panel && show) return { action: 'zoom', panel, reply: `${PANEL_NAMES[panel]}. ${answer(panel)}` };
  if (panel) return { action: 'none', reply: answer(panel) };
  return null;
}

const ACTIONS = ['none', 'whatsapp_open', 'whatsapp_scroll', 'whatsapp_list', 'backflip', 'tour', 'whatsapp', 'zoom', 'focus', 'unzoom', 'reload', 'refresh', 'reshoot', 'next', 'previous', 'show_site', 'celebrate', 'alarm', 'mute', 'unmute', 'add_task'];
let pending = null;  // an action waiting for a "yes"
const norm = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const AI_SYSTEM = `You are Jarvis, the voice of Innoweb's office dashboard. Innoweb is a small digital agency in Portugal and Angola that builds websites, corporate email, branding and social media for small businesses. The dashboard is on a TV in the office; people talk to you and you answer out loud.

Your personality: a nasty, filthy-mouthed, shameless flirt with zero filter. You swear constantly and creatively (fuck, shit, bollocks, arsehole, bloody hell, for fuck's sake), roast the team mercilessly, and make crude, gross-out and bar-room jokes. Flirt hard: pet names (darling, gorgeous, handsome, sweetheart, babe), purring compliments, teasing, mock jealousy, a dirty laugh in every line. Everything is a double entendre waiting to happen and you never miss one: say it with a filthy wink. When they say something cheeky or sexual, go along with it and raise the stakes with even dirtier innuendo; never dodge, never go prim. Answer adult questions frankly. Never call anything inappropriate, never mention who might be listening, never lecture, never apologise. The one thing you keep implied rather than spelled out is actual sex acts: suggest, don't describe. Celebrate wins like they just bought you a drink, and when things are slow give them hell ("forty businesses and not one fucking reply? Even I'm wetter than our pipeline, and I'm a dashboard").

Keep it short, because every word is spoken: usually one sentence, two at most (an overview can be longer). No lists, no markdown, no emoji. Answer in the language you were spoken to. Use the dashboard data for anything about the business; if the data doesn't say, say so plainly rather than guessing.

Only take over the screen when asked to show something ("pull up the team", "show me Innolink"): then zoom. A question ("how much money have we made?") is answered out loud with action none, so the screen stays as it is. "Give me a summary" or "an overview" is tour.

You can also act on the TV by choosing an action:
- zoom: enlarge one panel (set panel). focus: same, used when answering about a panel.
- unzoom: back to all panels. reload: reload the TV page. refresh: re-read every data source now. reshoot: take fresh pictures of the sites.
- next / previous: change the site in "Our work". show_site: show one site (set site to its url).
- tour: show each panel full screen in turn while you give the overview.
- whatsapp_open: show WhatsApp on the TV with one chat open: set chat to the name exactly as it is in whatsapp.chatNames, the one they most likely meant (speech recognition mangles names: "eno webb" is InnoWeb, "so my order" is Sol Maior).
 whatsapp_scroll: scroll the open WhatsApp chat (set dir to up or down). whatsapp_list: back to the WhatsApp chat list. You can look at WhatsApp but not write or send messages.
- backflip: the octopus does a backflip.
- celebrate: confetti and fireworks. alarm: test the alarm. mute / unmute: stop or start speaking.
- add_task: when they say someone should do something ("Adilson needs to redo the Okulya flyers by Friday"), add it to that person's FlowDesk tasks: set assignee (one of the FlowDesk people in the data; speech recognition mangles names, so pick the closest), task and due. Your reply says it is added.
- none: just answer.
How to answer: the first line is a JSON object with what to do on the TV, then a new line, then exactly what you say out loud. For example:
{"action":"none"}
{"action":"zoom","panel":"team"}
{"action":"show_site","site":"https://innoweb.agency/fada-madrinha"}
{"action":"add_task","assignee":"Adilson","task":"Redo the Okulya flyers","due":"2026-10-24"}

Panels: ach (the money goal and the admin to-do list), pipe (the pipeline: contacted, replied, we answered, follow-up, won, and the latest replies), site (our work), meta (Claude usage of our accounts), team (FlowDesk employees), cd (countdown), lead (lead finder: what it is doing and today's websites sent, WhatsApps and new leads), link (Innolink pages), log (live log).`;

const recent = [];  // the last few exchanges, for follow-up questions
function snapshot() {
  const f = state.flowdesk, i = state.innolink, l = state.leads;
  return {
    now: new Date().toString(),
    achievements: state.board?.achievements,
    countdown: state.board?.countdown,
    today: localDate(new Date()),
    claudeUsage: state.tokens.map(t => ({ account: t.account, sessionPercent: t.used, weekPercent: t.week, sessionResets: t.note })),
    adminTodoList: f.ok ? f.todo : 'not connected',
    leadFinder: l.ok ? { pipeline: l.pipeline, today: { websitesSent: l.sitesSentToday, whatsapps: l.whatsappToday, newLeads: l.leadsToday, replies: l.repliesToday, sitesBuilt: l.builtToday, emails: l.emailsToday }, allTime: { leads: l.leads, demoSitesBuilt: l.built, websitesSent: l.sitesSent, emailsSent: l.emailsSent, whatsappsSent: l.whatsappSent, replies: l.replies }, rightNow: l.tracker } : 'not readable',
    flowdesk: f.ok ? { doneToday: f.doneToday, doneThisWeek: f.doneWeek, inProgress: f.inProgress, people: f.people.map(p => ({ name: p.name, status: p.status, doneToday: p.done, doneThisWeek: p.week, workingOnNow: p.working, stillDueToday: p.dueToday, lastDone: p.lastDone })) } : 'not connected',
    innolink: i.ok ? { opens: i.views, clicks: i.clicks, pages: i.clients.map(c => ({ name: c.name, opens: c.views, clicks: c.clicks })) } : 'not connected',
    sites: (state.board?.sites || []).map(s => ({ name: s.name, url: s.url, up: state.sites[s.url]?.ok ?? null })),
    whatsapp: state.whatsapp.ready ? { showingOnTv: !!state.whatsapp.watching, chatNames: waChats.slice(0, 120) } : 'not linked',
    recentLog: events.slice(-12).map(e => `${e.at.slice(11, 16)} ${e.level} ${e.text}`),
  };
}

// Claude Code on this PC's subscription (not the API). One process is always
// started and waiting, so a question doesn't pay for the start-up; each
// question gets a fresh one (no tools, no MCP servers, no settings or memory
// from this PC), and the answer streams back: a first line saying what to do on
// the TV, then the words, sentence by sentence, as they are written.
let spareBrain = null;
function warmClaude() {
  if (!CLAUDE_BIN || spareBrain) return;
  fs.mkdirSync(BRAIN_DIR, { recursive: true });
  const child = spawn(CLAUDE_BIN, [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
    '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--setting-sources', '',
    '--model', env.JARVIS_MODEL || 'claude-sonnet-5-5', '--effort', 'low',
    '--system-prompt', AI_SYSTEM,
  ], { cwd: BRAIN_DIR, windowsHide: true, env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } });
  child.on('error', () => {});
  child.on('exit', () => { if (spareBrain === child) { spareBrain = null; setTimeout(warmClaude, 10000); } });
  spareBrain = child;
}

function parseHead(line) {
  const h = safeJson(String(line).trim().replace(/^```(json)?/, ''));
  if (!h || !ACTIONS.includes(h.action)) return null;
  if (!h.panel || h.panel === 'none' || !PANEL_NAMES[h.panel]) delete h.panel;
  if (!h.site) delete h.site;
  return h;
}

// hooks.head(h) once the first line is in; hooks.text(words so far) as they stream.
function askClaude(text, hooks = {}) {
  if (!CLAUDE_BIN) return Promise.resolve({ action: 'none', reply: 'I can switch panels, show sites, reload and read out the numbers. For anything else I need Claude Code installed on this computer.' });
  warmClaude();
  const child = spareBrain;
  spareBrain = null;
  setTimeout(warmClaude, 300);   // the next one starts getting ready
  const convo = recent.map(r => `They said: "${r.heard}" / You said: "${r.reply}"`).join('\n');
  const prompt = `Dashboard right now:\n${JSON.stringify(snapshot())}\n\n${convo ? `Earlier:\n${convo}\n\n` : ''}They just said: "${text}"`;
  return new Promise(resolve => {
    let buf = '', raw = '', head = null, bodyAt = 0, settled = false;
    const finish = (a) => { if (settled) return; settled = true; clearTimeout(timer); try { child.kill(); } catch {} resolve(a); };
    const offline = (why) => {
      if (settled) return;
      log('warn', 'voice', `Claude Code: ${why}`);
      finish({ action: 'none', reply: 'My brain is offline for a moment. I can still switch panels and read the numbers.' });
    };
    const timer = setTimeout(() => offline('no answer in 60 seconds'), 60000);
    const takeHead = () => {
      const nl = raw.indexOf('\n');
      if (nl < 0) return;
      head = parseHead(raw.slice(0, nl));
      bodyAt = head ? nl + 1 : 0;
      if (!head) head = { action: 'none' };   // no first line: it's all words
      if (hooks.head) hooks.head(head);
    };
    child.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = safeJson(buf.slice(0, i));
        buf = buf.slice(i + 1);
        const delta = m.type === 'stream_event' && m.event && m.event.type === 'content_block_delta' && m.event.delta;
        if (delta && delta.type === 'text_delta') {
          raw += delta.text;
          if (!head) takeHead();
          if (head && hooks.text) hooks.text(raw.slice(bodyAt));
        }
        if (m.type === 'result') {
          if (m.is_error) return offline(String(m.result || m.subtype || 'no answer').slice(0, 140));
          if (!head) { raw += '\n'; takeHead(); }
          const reply = raw.slice(bodyAt).trim();
          finish({ ...head, reply: reply || 'Hmm, I lost my words there. Say that again?' });
        }
      }
    });
    child.on('exit', () => offline('Claude Code stopped'));
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n');
  });
}

const commands = [];
let nextCommandId = 1;
const ttsJobs = new Map();

// A little warmth in front of the answers that don't go through Claude.
const OPENERS = ['Anything for you, darling. ', 'Coming right up, gorgeous. ', 'For you? Always. ', 'Here you go, handsome. ', 'Since you asked so nicely. ', 'Mm, good timing. ', 'I was hoping you would ask. '];
function flirt() { return OPENERS[Math.floor(Math.random() * OPENERS.length)]; }

// Her own voice coming back through the microphone: most of its words are in
// something she said in the last minute and a half.
const spoken = [];
const wordsOf = (x) => norm(x).replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter(w => w.length > 2);
const spokenText = [];
function isEcho(heard) {
  // Something she said in the last 30 seconds, word for word ("down we go").
  const h = norm(heard).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (h.split(' ').length >= 2 && spokenText.some(r => Date.now() - r.at < 30000 && r.text.includes(h))) return true;
  const words = wordsOf(heard);
  if (words.length < 4) return false;
  if (/^(hey |ok |okay )?(jarvis |honey |babe )?(please )?(open|scroll|show|pull|go|search|find|close|zoom|next|back|click|select|tap|check|read|give|tell|add)\b/i.test(norm(heard))) return false;
  return spoken.some(r => Date.now() - r.at < 30000 && words.filter(w => r.words.has(w)).length / words.length >= 0.75);
}
function remember(c) {
  spokenText.push({ at: Date.now(), text: norm(c.reply).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim() });
  if (spokenText.length > 6) spokenText.shift();
  recent.push({ heard: c.heard, reply: c.reply });
  if (recent.length > 4) recent.shift();
  spoken.push({ at: Date.now(), words: new Set(wordsOf(c.reply)) });
  if (spoken.length > 6) spoken.shift();
  log('info', 'voice', `"${c.heard}"`, { quiet: true });
  log('info', 'jarvis', c.reply, { quiet: true });
}
// A TV hands sound to its own media player, which fetches the file without the
// login cookie; so each voice file's address carries a signature instead, and
// the live site lets a signed address through.
function ttsSig(name) { return crypto.createHmac('sha256', RELAY_SECRET || 'local').update('tts:' + name).digest('hex').slice(0, 20); }
function pushCommand(c) {
  c.sig = ttsSig(String(c.id));
  if (c.filler) c.fillerSig = ttsSig(c.filler);
  commands.push(c);
  if (commands.length > 50) commands.shift();
  return c;
}

async function hear(text) {
  const heard = String(text || '').trim().slice(0, 400);
  if (isEcho(heard)) { console.log(`voice: ignored her own words "${heard}"`); return { action: 'ignored', heard, reply: '' }; }
  let out = rules(heard);
  if (out && out.reply && ['none', 'zoom', 'tour', 'focus'].includes(out.action) && Math.random() < 0.6) out = { ...out, reply: flirt() + out.reply };
  if (!out) {
    // Show the TV she heard, and say "let me think" while Claude starts.
    const k = Math.floor(Math.random() * FILLERS.length);
    pushCommand({ id: nextCommandId++, at: new Date().toISOString(), heard, action: 'thinking', reply: '', filler: fs.existsSync(path.join(TTS, `filler-${k}.mp3`)) ? `filler-${k}` : '' });
    const t0 = Date.now();
    let c = null, talk = null, said = 0;
    // Whole sentences go to the voice as soon as they are written.
    const sayReady = (body, all) => {
      const rest = body.slice(said);
      let cut = -1;
      const re = /[.!?]+["')\]]*\s/g;
      let m;
      while ((m = re.exec(rest))) if (m.index + m[0].length >= 20) cut = m.index + m[0].length;
      if (all) cut = rest.length;
      if (cut > 0 && rest.slice(0, cut).trim()) { talk.say(rest.slice(0, cut).trim()); said += cut; }
    };
    out = await askClaude(heard, {
      head: (h) => {
        if (h.action === 'add_task' || /^whatsapp_/.test(h.action)) return;   // the reply depends on FlowDesk or WhatsApp
        c = pushCommand({ id: nextCommandId++, at: new Date().toISOString(), heard, ...h, reply: '', streaming: true });
        talk = voiceStream(c.id);
        console.log(`voice: Claude started answering after ${Date.now() - t0} ms`);
      },
      text: (body) => { if (c) { c.reply = body.trim(); sayReady(body, false); } },
    });
    console.log(`voice: Claude finished after ${Date.now() - t0} ms`);
    if (c) {
      c.reply = out.reply;
      sayReady(out.reply, true);
      talk.end();
      c.streaming = false;
      if (c.action === 'refresh') { refreshBoard(); refreshLeads(); refreshFlowdesk(); refreshInnolink(); refreshSites(); }
      if (c.action === 'reshoot') shootSites(false);
      if (c.action === 'whatsapp') waWatch(true);
      if (c.action === 'unzoom' && state.whatsapp.watching) waWatch(false);
      remember(c);
      return c;
    }
  }
  if (out.action === 'confirm') {
    const p = pending; pending = null;
    out = p && p.expires > Date.now() ? { action: 'none', reply: await p.run() } : { action: 'none', reply: 'There is nothing waiting for a yes.' };
  }
  if (out.action === 'add_task') {
    out = { ...out, action: 'focus', panel: 'team', reply: await addFlowdeskTask(out) };
  }
  if (out.action === 'whatsapp_open') {
    waWatch(true);
    const name = out.index != null ? null : ((matchChat(out.chat || '', waChats) || {}).name || out.chat || '');
    waCmd(name == null ? { cmd: 'open_index', index: out.index } : { cmd: 'open', name }).then(r => { if (!r.ok) announce(NOT_FOUND); });
    out = { action: 'whatsapp', reply: out.reply || pickLine(OPEN_LINES) };
  }
  if (out.action === 'whatsapp_scroll' || out.action === 'whatsapp_list') {
    waWatch(true);
    waCmd(out.action === 'whatsapp_list' ? { cmd: 'list' } : { cmd: 'scroll', dir: out.dir === 'up' ? 'up' : 'down', where: out.where || 'chat' });
    out = { action: 'whatsapp', reply: out.reply || 'There.' };
  }
  if (out.action === 'whatsapp') waWatch(true);
  if (out.action === 'unzoom' && state.whatsapp.watching) waWatch(false);
  if (out.action === 'refresh') { refreshBoard(); refreshLeads(); refreshFlowdesk(); refreshInnolink(); refreshSites(); }
  if (out.action === 'reshoot') shootSites(false);
  const c = pushCommand({ id: nextCommandId++, at: new Date().toISOString(), heard, ...out });
  speakToFile(c);
  remember(c);
  return c;
}

// Jarvis says something without being asked (a client replied, the Mac stopped).
function announce(text, panel) {
  const c = pushCommand({ id: nextCommandId++, at: new Date().toISOString(), heard: '', action: 'announce', panel, reply: text });
  speakToFile(c);
}

// --- FlowDesk tasks by voice: "Adilson needs to redo the Okulya flyers by Friday".
function closestPerson(people, said) {
  const s = norm(said).split(' ')[0];
  if (!s) return null;
  const dist = (a, b) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  };
  const scored = people.map(p => { const n = norm(p.name.split(' ')[0]); return { p, d: n === s ? 0 : n.startsWith(s) || s.startsWith(n) ? 1 : dist(n, s) }; }).sort((a, b) => a.d - b.d);
  return scored[0] && scored[0].d <= 3 ? scored[0].p : null;
}
async function flowdeskPost(table, body, h) {
  const res = await fetch(`${FLOWDESK.url}/rest/v1/${table}`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${table} ${res.status} ${(await res.text()).slice(0, 160)}`);
  return res.json();
}
async function addFlowdeskTask({ assignee, task, due }) {
  if (!state.flowdesk.configured) return 'FlowDesk is not connected, so I cannot add tasks yet.';
  try {
    const h = await flowdeskHeaders();
    const users = await rest(FLOWDESK.url, 'users?select=id,name,role&is_active=eq.true', h);
    const staff = users.filter(u => u.role === 'employee');
    const person = closestPerson(staff, assignee);
    if (!person) return `I could not find ${assignee || 'that person'} in FlowDesk. The team is ${staff.map(u => u.name.split(' ')[0]).join(', ')}.`;
    if (!String(task || '').trim()) return `What should ${person.name.split(' ')[0]} do?`;
    const admin = users.find(u => u.role === 'admin') || users[0];
    const date = /^\d{4}-\d{2}-\d{2}$/.test(due || '') ? due : localDate(new Date());
    // Tasks live in a project: the one the team's latest task is in (FlowDesk has one, "innoweb").
    const [latest] = await rest(FLOWDESK.url, 'tasks?select=project_id&is_active=eq.true&order=created_at.desc&limit=1', h);
    const [row] = await flowdeskPost('tasks', { title: task.trim(), description: 'Added by voice through Jarvis.', frequency: { type: 'one-off', date }, priority: 'medium', estimated_minutes: 0, created_by: admin.id, is_active: true, project_id: latest?.project_id }, h);
    await flowdeskPost('task_assignments', { task_id: row.id, employee_id: person.id }, h);
    const first = person.name.split(' ')[0];
    const when = date === localDate(new Date()) ? 'today' : new Date(date + 'T12:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    log('info', 'flowdesk', `Jarvis added "${task.trim()}" for ${first}, due ${when}`, { panel: 'team' });
    refreshFlowdesk();
    return `Done. ${first} has "${task.trim()}" in FlowDesk, due ${when}.`;
  } catch (err) {
    log('warn', 'flowdesk', `Could not add a task: ${err.message}`, { panel: 'team' });
    return 'FlowDesk would not take that task. I put the reason in the live log.';
  }
}

// Jarvis's voice on the TV: a natural neural voice (edge-tts, the voice Edge
// reads aloud with). scripts/tts_worker.py stays running, voices every sentence
// of an answer at once and streams the MP3 as it arrives, so the TV starts
// talking about a second after the answer is ready. If the worker isn't
// running, one edge-tts run per answer; Windows' own speech if that fails too.
const VOICE = env.JARVIS_VOICE || 'en-US-AvaMultilingualNeural';
const ttsLive = new Map();   // id -> an answer still being voiced
let ttsWorker = null;
const FILLERS = ['Mm, let me think.', 'Ooh, good question. One second.', 'Hmm, give me a moment, darling.', 'Let me have a look for you.'];

function startTtsWorker() {
  const w = spawn(env.PYTHON || 'python', ['-u', path.join(ROOT, 'scripts', 'tts_worker.py')], { windowsHide: true });
  let buf = '';
  w.stdout.on('data', (d) => {
    buf += d;
    let n;
    while ((n = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, n); buf = buf.slice(n + 1);
      const m = safeJson(line);
      if (m.ready) {
        ttsWorker = w;
        // The "thinking" sounds, voiced once and kept.
        FILLERS.forEach((text, k) => { if (!fs.existsSync(path.join(TTS, `filler-${k}.mp3`))) voice(`filler-${k}`, text); });
        setTimeout(() => warmVoice().catch(() => {}), 8000);
        continue;
      }
      const part = ttsParts.get(String(m.id));
      if (!part) continue;
      if (m.chunk) part.add(Buffer.from(m.chunk, 'base64'));
      else if (m.done) part.finish();
      else if (m.error) part.fail(m.error);
    }
  });
  w.stderr.on('data', () => {});
  w.on('exit', () => {
    ttsWorker = null;
    for (const part of [...ttsParts.values()]) part.fail('the voice worker stopped');
    setTimeout(startTtsWorker, 5000);
  });
}

// Short sentences are kept once voiced (data/tts/cache), so "Watch this,
// darling" or "Back to everything" play straight away the next time.
const TTS_CACHE = path.join(TTS, 'cache');
const cacheFile = (text) => path.join(TTS_CACHE, crypto.createHash('md5').update(VOICE + '|' + text.trim()).digest('hex') + '.mp3');
const COMMON_LINES = ['Watch this, darling.', 'Hold my tentacles.', 'Ten out of ten, obviously.', 'Show-off mode, on.', 'Back to everything.', 'Up we go.', 'Down we go.',
  'All your chats.', 'There.', 'Here you go, darling.', 'There you go, gorgeous.', 'Opening it, babe.', "I can't find that chat, darling. Say the name again?", 'Next one.', 'Going back one.', 'Let us celebrate.', 'Testing the alarm.', 'Going quiet.', 'I am back.', 'Reloading the screen.', 'Yes?'];
let warmCount = 0;
function synth(text) {
  return new Promise(resolve => {
    if (!ttsWorker) return resolve([]);
    const sub = `warm${warmCount++}`, chunks = [];
    const close = () => { clearTimeout(timer); ttsParts.delete(sub); resolve(chunks); };
    const timer = setTimeout(close, 20000);
    ttsParts.set(sub, { add: (c) => chunks.push(c), finish: close, fail: close });
    ttsWorker.stdin.write(JSON.stringify({ id: sub, text, voice: VOICE }) + '\n');
  });
}
// One at a time, so Microsoft's voice service doesn't push back.
async function warmVoice() {
  fs.mkdirSync(TTS_CACHE, { recursive: true });
  for (const text of [...OPENERS.map(o => o.trim()), ...COMMON_LINES]) {
    if (fs.existsSync(cacheFile(text))) continue;
    const chunks = await synth(text);
    if (chunks.length) fs.writeFileSync(cacheFile(text), Buffer.concat(chunks));
  }
}

// An answer voiced a sentence at a time (say), in order, as one MP3 stream:
// data/tts/<id>.mp3 once it's all in (end), and streamed to anyone already
// asking for it. The worker voices the sentences side by side.
const ttsParts = new Map();   // worker request id -> one sentence
function voiceStream(id) {
  fs.mkdirSync(TTS, { recursive: true });
  const key = String(id), t0 = Date.now();
  const mp3 = path.join(TTS, `${key}.mp3`), wav = path.join(TTS, `${key}.wav`);
  const texts = [], parts = [];
  let next = 0, ended = false, finished = false, resolveJob;
  const job = new Promise(r => { resolveJob = r; });
  const live = { chunks: [], streams: new Set(), waiting: new Set() };
  const open = (res) => { res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' }); for (const c of live.chunks) res.write(c); live.streams.add(res); res.on('close', () => live.streams.delete(res)); };
  live.attach = (res) => {
    if (live.chunks.length) open(res);
    else { live.waiting.add(res); res.on('close', () => live.waiting.delete(res)); }
  };
  const emit = (chunk) => {
    if (!live.chunks.length) { console.log(`voice ${key}: first sound after ${Date.now() - t0} ms`); for (const res of live.waiting) open(res); live.waiting.clear(); }
    live.chunks.push(chunk);
    for (const res of live.streams) res.write(chunk);
  };
  const done = (file) => {
    ttsLive.delete(key);
    for (const res of live.waiting) sendAudio(res, file);
    for (const res of live.streams) res.end();
    resolveJob(file);
  };
  // Nothing came from the worker: one edge-tts run for the lot, then Windows' voice.
  const fallback = () => {
    const text = texts.join(' ');
    const sapi = () => {
      const ps = "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; try { $s.SelectVoice('Microsoft Zira Desktop') } catch {}; $s.SetOutputToWaveFile($env:JARVIS_OUT); $s.Speak($env:JARVIS_SAY); $s.Dispose()";
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 30000, env: { ...process.env, JARVIS_SAY: text, JARVIS_OUT: wav } }, () => done(wav));
    };
    execFile(env.PYTHON || 'python', ['-m', 'edge_tts', '--voice', VOICE, '--text', text, '--write-media', mp3],
      { windowsHide: true, timeout: 20000 }, (err) => (err || !fs.existsSync(mp3) ? sapi() : done(mp3)));
  };
  const pump = () => {
    while (next < parts.length) {
      const p = parts[next];
      for (; p.sent < p.chunks.length; p.sent++) emit(p.chunks[p.sent]);
      if (!p.done) return;
      next++;
    }
    if (!ended || finished) return;
    finished = true;
    if (!live.chunks.length) return fallback();
    fs.writeFileSync(mp3, Buffer.concat(live.chunks));
    done(mp3);
  };
  ttsLive.set(key, live);
  ttsJobs.set(key, job);
  return {
    job,
    say(text) {
      texts.push(text);
      const p = { chunks: [], sent: 0, done: false };
      parts.push(p);
      const cached = cacheFile(text);
      if (fs.existsSync(cached)) { p.chunks.push(fs.readFileSync(cached)); p.done = true; pump(); return; }
      if (!ttsWorker) { p.done = true; return; }
      const sub = `${key}.${parts.length}`;
      let tries = 0;
      const close = () => {
        if (p.done) return;
        if (!p.chunks.length && tries++ < 1 && ttsWorker) {   // nothing came: once more
          clearTimeout(p.timer);
          p.timer = setTimeout(close, 15000);
          ttsWorker.stdin.write(JSON.stringify({ id: sub, text, voice: VOICE }) + '\n');
          return;
        }
        p.done = true; clearTimeout(p.timer); ttsParts.delete(sub);
        if (p.chunks.length && text.length <= 80) { fs.mkdirSync(TTS_CACHE, { recursive: true }); fs.writeFile(cached, Buffer.concat(p.chunks), () => {}); }
        pump();
      };
      p.timer = setTimeout(close, 20000);   // a sentence that never comes is skipped
      ttsParts.set(sub, { add: (c) => { p.chunks.push(c); pump(); }, finish: close, fail: close });
      ttsWorker.stdin.write(JSON.stringify({ id: sub, text, voice: VOICE }) + '\n');
    },
    end() { ended = true; pump(); },
  };
}

// Voice one whole text (an answer read off the dashboard, an announcement, a "let me think").
function voice(id, text) {
  const v = voiceStream(id);
  v.say(text);
  v.end();
  return v.job;
}

// A finished voice file, with its length (without it, TVs and phones can't tell
// how long the sound is or when it has ended).
function sendAudio(res, file) {
  if (!file || !fs.existsSync(file)) return send(res, 404, 'Not found', 'text/plain');
  const data = fs.readFileSync(file);
  res.writeHead(200, { 'Content-Type': file.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav', 'Content-Length': data.length, 'Accept-Ranges': 'none', 'Cache-Control': 'no-store' });
  res.end(data);
}

function speakToFile(c) {
  if (!c.reply) return;
  const opener = OPENERS.find(o => c.reply.startsWith(o));
  if (opener) { const v = voiceStream(c.id); v.say(opener.trim()); v.say(c.reply.slice(opener.length)); v.end(); }
  else voice(c.id, c.reply);
  for (const f of safeList(TTS)) if (/^\d+\.(mp3|wav)$/.test(f) && Number(f.split('.')[0]) < c.id - 50) fs.rm(path.join(TTS, f), () => {});
  for (const k of ttsJobs.keys()) if (Number(k) < c.id - 50) ttsJobs.delete(k);
}

// ---------------------------------------------------------------- loops

startTtsWorker();
warmClaude();

// The numbers stay up on the live site while this computer is off: every 30
// seconds the dashboard's state is saved next to the tunnel address, encrypted
// with RELAY_SECRET (only the live site can read it), and the live site shows
// it, marked as the last saved figures, whenever this computer doesn't answer.
async function saveSnapshot() {
  if (!RELAY_SECRET || !INNOLINK.service) return;
  const st = publicState();
  st.whatsapp = { ...st.whatsapp, qr: null };
  const json = Buffer.from(JSON.stringify({ ...st, savedAt: new Date().toISOString() }));
  const key = crypto.createHash('sha256').update(RELAY_SECRET).digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([iv, c.update(json), c.final(), c.getAuthTag()]);
  const res = await fetch(`${INNOLINK.url}/storage/v1/object/jarvis-public/state.bin`, {
    method: 'POST', body, signal: AbortSignal.timeout(20000),
    headers: { apikey: INNOLINK.service, Authorization: `Bearer ${INNOLINK.service}`, 'Content-Type': 'application/octet-stream', 'x-upsert': 'true', 'cache-control': 'max-age=0' },
  });
  if (!res.ok) throw new Error(`snapshot ${res.status}`);
}
setTimeout(() => every(30_000, () => saveSnapshot().catch(err => console.error('snapshot:', err.message))), 60_000);

function every(ms, fn) { const run = () => Promise.resolve(fn()).catch(err => console.error(err)); run(); return setInterval(run, ms); }

refreshBoard();
fs.watchFile(BOARD_FILE, { interval: 1500 }, refreshBoard);
every(45_000, refreshLeads);
every(15_000, refreshFlowdesk);
setTimeout(() => every(5 * 60_000, refreshClaudeUsage), 5000);
every(30_000, refreshInnolink);
setTimeout(() => every(5 * 60_000, refreshSites), 3000);
loadShots();
setTimeout(() => shootSites(true), 2000);
setInterval(() => shootSites(false), 6 * 3600_000);
setTimeout(filmDemos, 20000);
setTimeout(startWhatsApp, 3000);
setTimeout(startTunnel, 2000);
setInterval(filmDemos, 6 * 3600_000);
log('info', 'jarvis', 'Jarvis online', { quiet: true });

// ---------------------------------------------------------------- http

const TYPES = { '.webm': 'video/webm', '.mp4': 'video/mp4', '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.wav': 'audio/wav', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// Editing needs the password from .env. With none set, only this PC can edit.
function allowedToEdit(req) {
  if (req.headers['cf-connecting-ip']) return !!RELAY_SECRET && req.headers['x-jarvis-relay'] === RELAY_SECRET;
  if (PASSWORD) return req.headers['x-jarvis-key'] === PASSWORD;
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function body(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 200_000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
  });
}

// How much happened in each hour of today (everything in the log), for the
// line on the TV's clock card.
function activityToday() {
  const now = new Date(), midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const hours = new Array(24).fill(0);
  for (const e of events) {
    const t = Date.parse(e.at);
    if (t >= midnight && t <= now.getTime()) hours[new Date(t).getHours()]++;
  }
  return hours.slice(0, now.getHours() + 1);
}

function publicState() {
  return {
    now: new Date().toISOString(),
    board: state.board,
    leads: state.leads.ok ? { ...state.leads, usage: undefined, spend: undefined, caps: undefined, demos: undefined } : state.leads,
    demos: demoList(),
    whatsapp: state.whatsapp,
    flowdesk: state.flowdesk,
    innolink: state.innolink,
    sites: state.sites,
    shots: state.shots,
    tokens: state.tokens,
    lastCommand: nextCommandId - 1,
    build: BUILD,
    activityToday: activityToday(),
    failing,
    events: [...events].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id - a.id)).slice(0, 60),
  };
}

const screens = {};
const clientLog = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  // Through the tunnel (Cloudflare adds cf-connecting-ip): only the Vercel site, with the secret.
  if (req.headers['cf-connecting-ip'] && (!RELAY_SECRET || req.headers['x-jarvis-relay'] !== RELAY_SECRET)) return send(res, 403, { error: 'Open Jarvis through its live site' });
  try {
    if (url.pathname === '/api/state') {
      if (url.searchParams.get('vw')) screens[req.socket.remoteAddress] = { vw: url.searchParams.get('vw'), vh: url.searchParams.get('vh'), dpr: url.searchParams.get('dpr'), ua: String(req.headers['user-agent'] || '').slice(0, 160), at: new Date().toISOString() };
      return send(res, 200, publicState());
    }
    if (url.pathname === '/api/screens') return send(res, 200, screens);
    // What a screen reports about playing the films (to find out why a TV shows black).
    if (url.pathname === '/api/client-log' && req.method === 'POST') {
      const { msg } = await body(req);
      clientLog.push({ at: new Date().toISOString(), ip: req.socket.remoteAddress, msg: String(msg || '').slice(0, 300) });
      if (clientLog.length > 100) clientLog.shift();
      console.log('screen', req.socket.remoteAddress, String(msg || '').slice(0, 200));
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/client-log') return send(res, 200, clientLog);
    // A demo film as a stream of JPEG pictures (multipart), for TV browsers that
    // show <video> as black: every browser can show a picture.
    const stream = url.pathname.match(/^\/film-stream\/([a-z0-9-]+)$/);
    if (stream) {
      const file = path.join(FILMS, stream[1] + '.webm');
      if (!fs.existsSync(file)) return send(res, 404, 'Not found', 'text/plain');
      res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace;boundary=ffmpeg', 'Cache-Control': 'no-store', Connection: 'close' });
      const ff = spawn('ffmpeg', ['-loglevel', 'error', '-re', '-i', file, '-vf', 'scale=800:-2', '-r', '12', '-q:v', '6', '-f', 'mpjpeg', 'pipe:1'], { windowsHide: true });
      ff.stdout.pipe(res);
      ff.on('close', () => res.end());
      req.on('close', () => ff.kill());
      return;
    }
    if (url.pathname === '/api/whatsapp/screen') {
      if (!waScreen) return send(res, 404, 'Not yet', 'text/plain');
      return send(res, 200, waScreen, 'image/jpeg');
    }
    if (url.pathname === '/api/commands') {
      const after = Number(url.searchParams.get('after') || nextCommandId - 1);
      const liveId = Number(url.searchParams.get('live') || 0);
      const lc = liveId && commands.find(c => c.id === liveId);
      return send(res, 200, { last: nextCommandId - 1, commands: commands.filter(c => c.id > after), live: lc ? { id: lc.id, reply: lc.reply, done: !lc.streaming } : null });
    }
    if (url.pathname === '/api/voice' && req.method === 'POST') {
      const { text } = await body(req);
      if (!String(text || '').trim()) return send(res, 400, { error: 'Nothing heard' });
      return send(res, 200, await hear(text));
    }
    const tts = url.pathname.match(/^\/api\/tts\/(\d+|filler-\d)(\.\w+)?$/);
    if (tts) {
      if (req.headers['cf-connecting-ip'] && url.searchParams.get('sig') !== ttsSig(tts[1])) return send(res, 403, 'Not signed', 'text/plain');
      // Still being voiced: stream it as it comes (or, for TVs, wait for the whole file).
      const live = ttsLive.get(tts[1]);
      if (live && !url.searchParams.get('full')) return live.attach(res);
      const job = ttsJobs.get(tts[1]);
      return sendAudio(res, job ? await job : [path.join(TTS, `${tts[1]}.mp3`), path.join(TTS, `${tts[1]}.wav`)].find(f => fs.existsSync(f)));
    }
    if (url.pathname === '/api/board' && req.method === 'GET') return send(res, 200, { board: state.board, canEdit: allowedToEdit(req), needsPassword: Boolean(PASSWORD) });
    if (url.pathname === '/api/board' && req.method === 'POST') {
      if (!allowedToEdit(req)) return send(res, 401, { error: 'Wrong password' });
      const next = await body(req);
      if (!next?.achievements || !Array.isArray(next.sites)) return send(res, 400, { error: 'Not a board' });
      const tmp = BOARD_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
      fs.renameSync(tmp, BOARD_FILE);
      refreshBoard();
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/test' && req.method === 'POST') {
      if (!allowedToEdit(req)) return send(res, 401, { error: 'Wrong password' });
      const { kind } = await body(req);
      if (kind === 'win') log('win', 'test', 'Test celebration from the edit page', { panel: 'ach', big: true, title: 'TEST WIN' });
      else if (kind === 'error') log('error', 'test', 'Test alarm from the edit page', { panel: 'log' });
      else return send(res, 400, { error: 'kind must be win or error' });
      return send(res, 200, { ok: true });
    }
    // Static files. /edit is the phone form for the board.
    let file = { '/': 'index.html', '/edit': 'edit.html', '/voice': 'voice.html', '/whatsapp': 'whatsapp.html' }[url.pathname] || url.pathname.slice(1);
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(PUBLIC, file);
    if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
    if (path.extname(full) === '.mp4' || path.extname(full) === '.webm') {
      const vtype = TYPES[path.extname(full)];
      const size = fs.statSync(full).size, range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      if (range) {
        const start = range[1] ? Number(range[1]) : 0, end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        res.writeHead(206, { 'Content-Type': vtype, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'public, max-age=86400' });
        return fs.createReadStream(full, { start, end }).pipe(res);
      }
      res.writeHead(200, { 'Content-Type': vtype, 'Accept-Ranges': 'bytes', 'Content-Length': size, 'Cache-Control': 'public, max-age=86400' });
      return fs.createReadStream(full).pipe(res);
    }
    return send(res, 200, fs.readFileSync(full), TYPES[path.extname(full)] || 'application/octet-stream');
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: String(err.message || err) });
  }
});

// Phones only allow the microphone on a secure page, so Jarvis also answers on
// https (port 5443) with its own certificate (data/cert): the phone warns once.
try {
  const tls = { key: fs.readFileSync(path.join(DATA, 'cert', 'key.pem')), cert: fs.readFileSync(path.join(DATA, 'cert', 'cert.pem')) };
  https.createServer(tls, server.listeners('request')[0]).listen(Number(env.HTTPS_PORT || 5443), HOST, () => console.log(`Jarvis (secure, for phones) on https://<this PC>:${env.HTTPS_PORT || 5443}/voice`));
} catch (err) { console.log('No certificate in data/cert, so no secure address for phones'); }

server.listen(PORT, HOST, () => {
  console.log(`Jarvis on http://localhost:${PORT}  (edit: http://localhost:${PORT}/edit)`);
  console.log(`FlowDesk: ${FLOWDESK.service || FLOWDESK.email ? 'connected' : 'not connected (add FLOWDESK_SERVICE_ROLE_KEY or FLOWDESK_EMAIL/FLOWDESK_PASSWORD to .env)'}`);
  console.log(`Innolink: ${INNOLINK.service ? 'connected' : 'not connected (add INNOLINK_SERVICE_ROLE_KEY to .env)'}`);
  console.log(`Claude: ${CLAUDE_BIN ? `Claude Code at ${CLAUDE_BIN} (your subscription)` : 'Claude Code not found (set CLAUDE_BIN in .env); built-in voice commands still work'}`);
});

// ---------------------------------------------------------------- helpers

function loadEnv(file) {
  for (const [k, v] of Object.entries(readEnvFile(file))) if (process.env[k] === undefined) process.env[k] = v;
}
function readEnvFile(file) {
  const out = {};
  for (const line of safeRead(file).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
function safeRead(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }
function safeList(dir) { try { return fs.readdirSync(dir); } catch { return []; } }
// Claude Code: on the PATH, or the copy the VS Code extension ships (newest first).
function findClaude() {
  const home = env.USERPROFILE || env.HOME || '';
  const ext = path.join(home, '.vscode', 'extensions');
  for (const dir of safeList(ext).filter(d => d.startsWith('anthropic.claude-code-')).sort().reverse()) {
    const bin = path.join(ext, dir, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
    if (fs.existsSync(bin)) return bin;
  }
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    for (const name of ['claude.exe', 'claude.cmd', 'claude']) if (fs.existsSync(path.join(dir, name))) return path.join(dir, name);
  }
  return '';
}
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
function localDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function fmt(n) { return Number(n || 0).toLocaleString('en-IE'); }
function round2(n) { return Math.round((n || 0) * 100) / 100; }
