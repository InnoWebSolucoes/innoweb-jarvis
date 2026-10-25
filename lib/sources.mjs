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
    rest(cfg.url, 'tasks?select=id,title,frequency,task_assignments(employee_id)&is_active=eq.true', h),
    rest(cfg.url, `notifications?select=id,type,title,message,created_at,subject_user_id&created_at=gte.${q(dayAgo)}&type=neq.task_overdue&order=created_at.asc`, h),
    rest(cfg.url, `project_todos?select=id,title,created_at,created_by,assignee_id&created_at=gte.${q(dayAgo)}&order=created_at.asc`, h),
    rest(cfg.url, `work_log_entries?select=id,author_id,title,minutes,created_at&created_at=gte.${q(dayAgo)}&order=created_at.asc`, h),
    rest(cfg.url, 'project_todo_lists?select=id,name,owner_id,created_at&order=created_at.asc', h),
  ]);
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
    return {
      id: u.id, name: u.name, initials: u.avatar_initials, title: u.job_title,
      done: mine.filter(f => f.at >= midnight).length, week: mine.length,
      working: working.map(w => w.title), since: working[0]?.since || null,
      // Today, as FlowDesk shows it: what is due today and not yet done.
      dueToday: mineTasks.filter(t => isToday(t.frequency) && !doneToday.has(`${t.id}|${u.id}`)).map(t => t.title),
      dueTotal: mineTasks.filter(t => isToday(t.frequency)).length,
      lastDone: mine[0]?.title || null,
      // Their tasks still to do (for "mark it done", "move it to Friday"): today's
      // and later one-offs not yet ticked, and today's monthly ones.
      openTasks: mineTasks.filter(t => (t.frequency?.type === 'one-off' && (t.frequency.date || '') >= today && !done.some(c => c.task_id === t.id && c.employee_id === u.id))
        || (isToday(t.frequency) && !doneToday.has(`${t.id}|${u.id}`))).map(t => ({ id: t.id, title: t.title, date: t.frequency?.type === 'one-off' ? t.frequency.date : today })).slice(0, 40),
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
