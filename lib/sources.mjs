// Reading the online sources: Innolink and FlowDesk. Used by Jarvis on the PC
// (server.mjs) and by the live site when the PC is off (api/relay.js), so both
// show the same numbers. Read-only: nothing here writes anywhere.

// "Today" is the office's calendar day, in UK time, wherever this runs.
export const TIME_ZONE = 'Europe/London';
export function zoned(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(now).map(p => [p.type, p.value]));
  const y = +parts.year, m = +parts.month, d = +parts.day;
  const offset = Date.UTC(y, m - 1, d, +parts.hour, +parts.minute, +parts.second) - Math.floor(now.getTime() / 1000) * 1000;
  const dayStart = (back) => new Date(Date.UTC(y, m - 1, d - back) - offset).toISOString();
  return {
    today: `${parts.year}-${parts.month}-${parts.day}`,
    midnight: dayStart(0), weekAgo: dayStart(6),
    dayOfMonth: d, dayOfWeek: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday), hour: +parts.hour,
  };
}

export async function rest(base, pathAndQuery, headers) {
  const res = await fetch(`${base}/rest/v1/${pathAndQuery}`, { headers, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${pathAndQuery.split('?')[0]} ${res.status}`);
  return res.json();
}

// --- Innolink: each page's opens and clicks.
export async function readInnolink(cfg) {
  const h = { apikey: cfg.service, Authorization: `Bearer ${cfg.service}` };
  const rows = await rest(cfg.url, 'clients?select=slug,name,views,credit_clicks,published,links(clicks,enabled)&order=views.desc', h);
  const clients = rows.map(c => ({
    slug: c.slug, name: c.name, published: c.published,
    views: c.views, credit: c.credit_clicks,
    clicks: (c.links || []).reduce((s, l) => s + (l.clicks || 0), 0),
    links: (c.links || []).filter(l => l.enabled).length,
  }));
  return {
    ok: true, configured: true, clients,
    views: clients.reduce((s, c) => s + c.views, 0),
    clicks: clients.reduce((s, c) => s + c.clicks, 0),
  };
}

// --- FlowDesk: signed in as the admin (or with a service key).
const tokens = new Map();
export async function flowdeskHeaders(cfg) {
  if (cfg.service) return { apikey: cfg.service, Authorization: `Bearer ${cfg.service}` };
  let t = tokens.get(cfg.email);
  if (!t || t.expires < Date.now() + 60_000) {
    const res = await fetch(`${cfg.url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: cfg.anon, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: cfg.email, password: cfg.password }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`FlowDesk login ${res.status}`);
    const j = await res.json();
    t = { value: j.access_token, expires: Date.now() + j.expires_in * 1000 };
    tokens.set(cfg.email, t);
  }
  return { apikey: cfg.anon, Authorization: `Bearer ${t.value}` };
}

// --- What's on someone's list today, exactly as FlowDesk works it out
// (src/utils/taskScheduler.ts: isTaskDueOnDate and taskOccurrences):
//   - a task lands on the days its schedule gives (daily; weekly on chosen
//     days; every other week from its start; monthly on a week and weekday;
//     one-off on its date), never before it was created, not on a day that
//     was skipped for that person;
//   - a day moved by its owner starts from the day it was moved to;
//   - unfinished work moves forward a day at a time until it's done (daily
//     tasks never move: each day is its own); finished, it stays on the day it
//     was finished; marked missed, on the day it was marked;
//   - a one-off counts as done whatever day its tick was recorded under.
// Days are calendar days in the office (UK time), as 'YYYY-MM-DD'.
const dayKey = (iso) => zoned(new Date(iso)).today;
const keyToUTC = (k) => Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10));
const shiftKey = (k, n) => new Date(keyToUTC(k) + n * 864e5).toISOString().slice(0, 10);
const weekdayOf = (k) => new Date(keyToUTC(k)).getUTCDay();   // 0 = Sunday
const mondayIndex = (k) => Math.floor((keyToUTC(k) / 864e5 + 3) / 7);   // weeks start on Monday
function isDueOn(task, empId, key, skips) {
  if (!task.is_active) return false;
  if (!(task.task_assignments || []).some(a => a.employee_id === empId)) return false;
  if (skips.has(`${task.id}|${empId}|${key}`)) return false;
  if (task.created_at && key < dayKey(task.created_at)) return false;
  const f = task.frequency || {}, dow = weekdayOf(key);
  switch (f.type) {
    case 'daily': return true;
    case 'weekly': return (f.days || []).includes(dow);
    case 'bi-weekly': {
      if (!(f.days || []).includes(dow)) return false;
      const anchor = f.date || task.created_at;
      if (!anchor) return false;
      const weeks = mondayIndex(key) - mondayIndex(String(anchor).length > 10 ? dayKey(anchor) : String(anchor).slice(0, 10));
      return weeks >= 0 && weeks % 2 === 0;
    }
    case 'monthly': return Math.ceil(+key.slice(8, 10) / 7) === (f.weekOfMonth ?? 1) && dow === (f.dayOfWeek ?? 1);
    case 'one-off': return !!f.date && String(f.date).slice(0, 10) === key;
    default: return false;
  }
}
// Every occurrence of this person's tasks that shows on `today`.
function occurrencesToday(tasks, empId, logs, statuses, moves, skips, today) {
  const moveBy = new Map(), logBy = new Map(), latestLog = new Map(), statusBy = new Map(), latestStatus = new Map();
  for (const m of moves) if (m.employee_id === empId) moveBy.set(`${m.task_id}|${m.due_date}`, m.moved_to);
  for (const l of logs) {
    if (l.employee_id !== empId) continue;
    logBy.set(`${l.task_id}|${l.due_date}`, l);
    const prev = latestLog.get(l.task_id);
    if (!prev || l.completed_at > prev.completed_at) latestLog.set(l.task_id, l);
  }
  for (const r of statuses) {
    if (r.employee_id !== empId) continue;
    statusBy.set(`${r.task_id}|${r.due_date}`, r);
    const prev = latestStatus.get(r.task_id);
    if (!prev || (r.started_at || '') > (prev.started_at || '')) latestStatus.set(r.task_id, r);
  }
  const out = [];
  const place = (task, date, log, status) => {
    const movedTo = moveBy.get(`${task.id}|${date}`) || null;
    const home = movedTo || date;
    let showOn, carried = false;
    if (task.frequency?.type === 'daily') showOn = home;
    else if (log) { const doneOn = dayKey(log.completed_at); showOn = doneOn > home ? doneOn : home; }
    else if (status?.status === 'missed') { const markedOn = status.started_at ? dayKey(status.started_at) : home; showOn = markedOn > home ? markedOn : home; }
    else if (home >= today) showOn = home;
    else { showOn = today; carried = true; }
    if (showOn === today) out.push({ task, date, carried, completed: !!log, status: status?.status || null });
  };
  const from = shiftKey(today, -365);
  for (const task of tasks) {
    if (!task.is_active || !(task.task_assignments || []).some(a => a.employee_id === empId)) continue;
    if (task.frequency?.type === 'one-off') {
      const date = task.frequency.date ? String(task.frequency.date).slice(0, 10) : null;
      if (!date || !isDueOn(task, empId, date, skips)) continue;
      place(task, date, logBy.get(`${task.id}|${date}`) || latestLog.get(task.id) || null, statusBy.get(`${task.id}|${date}`) || latestStatus.get(task.id) || null);
      continue;
    }
    for (let d = from; d <= today; d = shiftKey(d, 1)) {
      if (!isDueOn(task, empId, d, skips)) continue;
      place(task, d, logBy.get(`${task.id}|${d}`) || null, statusBy.get(`${task.id}|${d}`) || null);
    }
  }
  return out;
}

// FlowDesk keeps work in two places: tasks (started and finished in
// activity_logs, done in completion_logs) and project to-dos (ticked off with
// completed_by). What someone is doing NOW is a task they started today and
// haven't finished. Returns the dashboard's FlowDesk numbers, and the raw
// rows the PC turns into live-log lines.
export async function readFlowdesk(cfg) {
  const h = await flowdeskHeaders(cfg);
  const z = zoned();
  const { midnight, weekAgo, today } = z;
  const dayAgo = new Date(Date.now() - 864e5).toISOString();
  const q = encodeURIComponent;
  const [users, done, todos, acts, tasks, notes, todoNew, worklog, lists] = await Promise.all([
    rest(cfg.url, 'users?select=id,name,avatar_initials,job_title,role,is_active&is_active=eq.true&order=name', h),
    rest(cfg.url, `completion_logs?select=id,employee_id,task_id,due_date,completed_at,tasks(title)&completed_at=gte.${q(weekAgo)}&order=completed_at.desc`, h),
    rest(cfg.url, `project_todos?select=id,title,completed_at,completed_by&completed_at=gte.${q(weekAgo)}&order=completed_at.desc`, h),
    rest(cfg.url, `activity_logs?select=id,action,timestamp,actor_id,task_id,tasks(title)&timestamp=gte.${q(midnight)}&order=timestamp.asc`, h),
    rest(cfg.url, 'tasks?select=id,title,frequency,is_active,created_at,task_assignments(employee_id)&is_active=eq.true', h),
    rest(cfg.url, `notifications?select=id,type,title,message,created_at,subject_user_id&created_at=gte.${q(dayAgo)}&type=neq.task_overdue&order=created_at.asc`, h),
    rest(cfg.url, `project_todos?select=id,title,created_at,created_by,assignee_id&created_at=gte.${q(dayAgo)}&order=created_at.asc`, h),
    rest(cfg.url, `work_log_entries?select=id,author_id,title,minutes,created_at&created_at=gte.${q(dayAgo)}&order=created_at.asc`, h),
    rest(cfg.url, 'project_todo_lists?select=id,name,owner_id,created_at&order=created_at.asc', h),
  ]);
  // What's behind "today": every completion, status, moved day and skipped day.
  const [allLogs, statuses, moves, skipRows] = await Promise.all([
    rest(cfg.url, 'completion_logs?select=task_id,employee_id,due_date,completed_at&limit=10000', h),
    rest(cfg.url, 'task_statuses?select=task_id,employee_id,due_date,status,started_at&limit=10000', h).catch(() => []),
    rest(cfg.url, 'task_moves?select=task_id,employee_id,due_date,moved_to&limit=10000', h).catch(() => []),
    rest(cfg.url, 'task_skips?select=task_id,employee_id,due_date&limit=10000', h).catch(() => []),
  ]);
  const skips = new Set(skipRows.map(r => `${r.task_id}|${r.employee_id}|${r.due_date}`));
  // The admin to-do list: FlowDesk's shared "To do" list (no owner), not anyone's own list.
  const adminList = lists.find(l => !l.owner_id && /to ?do/i.test(l.name || '')) || lists.find(l => !l.owner_id);
  const listTodos = adminList ? await rest(cfg.url, `project_todos?select=id,title,is_completed,completed_at,assignee_id,do_date,is_urgent,sort_order&list_id=eq.${adminList.id}&order=sort_order.asc`, h) : [];

  // Doing now: started today, not finished since (per person, newest first).
  const open = {};
  for (const a of acts) {
    const mine = open[a.actor_id] || (open[a.actor_id] = new Map());
    if (a.action === 'in_progress') mine.set(a.task_id, { title: a.tasks?.title || 'a task', since: a.timestamp });
    else if (a.action === 'completed' || a.action === 'missed') mine.delete(a.task_id);
  }
  // Due today: one-off tasks dated today, and monthly ones that fall today.
  const isToday = f => f?.type === 'one-off' ? f.date === today
    : f?.type === 'monthly' ? z.dayOfWeek === f.dayOfWeek && Math.ceil(z.dayOfMonth / 7) === f.weekOfMonth : false;
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
    const todayList = occurrencesToday(tasks, u.id, allLogs, statuses, moves, skips, today);
    const leftToday = todayList.filter(o => !o.completed && o.status !== 'missed');
    return {
      id: u.id, name: u.name, initials: u.avatar_initials, title: u.job_title,
      done: mine.filter(f => f.at >= midnight).length, week: mine.length,
      working: working.map(w => w.title), since: working[0]?.since || null,
      // Today, as FlowDesk shows it: what is due today and not yet done.
      dueToday: leftToday.map(o => o.task.title),
      dueTotal: todayList.length,
      carriedToday: leftToday.filter(o => o.carried).length,
      lastDone: mine[0]?.title || null,
      // Their tasks still to do (for "mark it done", "move it to Friday"): today's
      // and later one-offs not yet ticked, and today's monthly ones.
      // (each with the day its completion is recorded under, as FlowDesk does)
      openTasks: [
        ...leftToday.map(o => ({ id: o.task.id, title: o.task.title, date: o.date })),
        ...mineTasks.filter(t => t.frequency?.type === 'one-off' && String(t.frequency.date || '').slice(0, 10) > today && !allLogs.some(c => c.task_id === t.id && c.employee_id === u.id))
          .map(t => ({ id: t.id, title: t.title, date: String(t.frequency.date).slice(0, 10) })),
      ].slice(0, 60),
    };
  }).sort((a, b) => b.working.length - a.working.length || b.done - a.done || a.name.localeCompare(b.name));
  for (const p of people) p.status = p.working.length ? 'working' : p.dueToday.length ? 'todo' : 'clear';

  const firstName = (id) => (users.find(u => u.id === id)?.name || '').split(' ')[0];
  const todo = {
    name: adminList?.name || 'To do',
    // Who it is for, unless it is the admin (it's the admin's list anyway).
    open: listTodos.filter(t => !t.is_completed).map(t => ({ id: t.id, title: t.title, who: t.assignee_id && users.find(u => u.id === t.assignee_id)?.role !== 'admin' ? firstName(t.assignee_id) : '', doDate: t.do_date, urgent: !!t.is_urgent })),
    doneToday: listTodos.filter(t => t.is_completed && t.completed_at >= midnight).length,
  };
  return {
    flowdesk: {
      ok: true, configured: true, people, todo,
      doneToday: finishedItems.filter(f => f.at >= midnight).length, doneWeek: finishedItems.length,
      inProgress: people.reduce((sum, p) => sum + p.working.length, 0),
      idle: people.filter(p => p.status === 'todo').length,
    },
    raw: { users, notes, todoNew, todos, worklog, dayAgo, today, hour: z.hour },
  };
}
