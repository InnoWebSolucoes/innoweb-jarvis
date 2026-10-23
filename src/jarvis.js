// Innoweb Jarvis: the TV page.
//
// Polls /api/state every 5 seconds and draws it. New log lines from the server
// drive the show: "win" sends the spider to that panel to celebrate (confetti,
// fireworks, a chime), "error" floods the screen red and sounds the siren.
// Between events the octopus swims between the panels and looks them over.

// Old TV browsers miss a few things; fill them in before anything runs.
if (!Object.fromEntries) Object.fromEntries = (pairs) => { const o = {}; for (const [k, v] of pairs) o[k] = v; return o; };
if (!String.prototype.padStart) String.prototype.padStart = function (n, c) { let s = String(this); while (s.length < n) s = (c || ' ') + s; return s.slice(-Math.max(n, String(this).length)); };
if (window.NodeList && !NodeList.prototype.forEach) NodeList.prototype.forEach = Array.prototype.forEach;

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const W = 1920, H = 1080;
  const POLL_MS = 5000;
  const eur = (n) => '€' + Math.round(n || 0).toLocaleString('en-IE');
  const num = (n) => Math.round(n || 0).toLocaleString('en-IE');
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  const PANEL_NAMES = { ach: 'Goal', todo: 'To do', site: 'Our work', meta: 'Claude usage', team: 'FlowDesk team', pipe: 'Pipeline', lead: 'Lead finder', link: 'Innolink', log: 'Live log' };
  const panels = Object.fromEntries([...document.querySelectorAll('[data-panel]')].map((el) => [el.dataset.panel, el]));

  let S = null;            // latest /api/state
  let lastEventId = null;  // newest server event already handled
  const localLog = [];     // the spider's own notes, shown in the live log

  // ------------------------------------------------------------ layout
  // TV (any landscape screen): the stage is 1080px tall and as wide as the
  // screen's shape (never narrower than 1920), then scaled to fill the screen
  // edge to edge, so every panel is always in view with no bars at the sides.
  // Only a phone held upright gets the panels in a scrolling column.
  let stacked = false;
  let SW = W;  // the stage's current width
  let K = 1;   // how much the stage is scaled on this screen
  function layout() {
    const w = window.innerWidth || document.documentElement.clientWidth;
    const h = window.innerHeight || document.documentElement.clientHeight;
    stacked = w < 700 && h > w;
    if (stacked) document.body.classList.add('stack'); else document.body.classList.remove('stack');
    if (stacked) { stage.style.transform = stage.style.webkitTransform = ''; stage.style.width = ''; SW = stage.offsetWidth; }
    else {
      SW = Math.max(W, Math.round(H * w / h));
      stage.style.width = SW + 'px';
      const k = Math.min(w / SW, h / H);
      K = k;
      const t = `translate(${Math.round((w - SW * k) / 2)}px, ${Math.round((h - H * k) / 2)}px) scale(${k})`;
      stage.style.webkitTransform = t;
      stage.style.transform = t;
    }
    fx.resize();
    fitMonitor();
  }

  // The monitor in "Our work": a 16:9 screen as large as the panel allows,
  // leaving room for its stand and the caption under it.
  function fitMonitor() {
    const desk = $('desk'), cap = $('site-caption');
    if (!desk.clientWidth) return;
    const bezel = 18, under = 20 + 7 + 12 + 26;
    const w = Math.floor(stacked ? desk.clientWidth - bezel : Math.min(desk.clientWidth - bezel, ((desk.clientHeight - bezel - under) * 16) / 9));
    $('screen').style.width = w + 'px';
    $('screen').style.height = Math.round((w * 9) / 16) + 'px';
    cap.style.width = (w + bezel) + 'px';
  }

  // ------------------------------------------------------------ clock + countdown
  function tickClock() {
    const now = new Date();
    $('clock-time').textContent = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
    const hr = now.getHours();
    $('greet').textContent = `${hr < 5 ? 'Working late' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening'}, Innoweb`;
    $('clock-date').textContent = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const cd = S?.board?.countdown;
    if (!cd) return;
    let left = Math.max(0, new Date(cd.target) - now);
    const d = Math.floor(left / 864e5); left -= d * 864e5;
    const h = Math.floor(left / 36e5); left -= h * 36e5;
    const m = Math.floor(left / 6e4); left -= m * 6e4;
    const s = Math.floor(left / 1e3);
    $('cd-d').textContent = String(d).padStart(2, '0');
    $('cd-h').textContent = String(h).padStart(2, '0');
    $('cd-m').textContent = String(m).padStart(2, '0');
    $('cd-s').textContent = String(s).padStart(2, '0');
    $('cd-label').textContent = cd.label || '';
  }

  // ------------------------------------------------------------ numbers
  // A number stays exactly as it is until its value changes; then it counts to
  // the new value and glows for a moment, so a change is noticed. (Plain text,
  // so it shows the same on the TV's older browser.)
  const values = new Map();  // element -> the value it shows
  function roll(el, to, format = num) {
    if (to == null || Number.isNaN(to)) { el.textContent = '—'; values.delete(el); return; }
    const from = values.get(el);
    if (from === to) return;
    values.set(el, to);
    if (from == null) { el.textContent = format(to); return; }
    const t0 = Date.now(), ms = 1400;
    el.classList.add('changed');
    const step = () => {
      if (values.get(el) !== to) return;
      const k = Math.min(1, (Date.now() - t0) / ms);
      el.textContent = format(from + (to - from) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(step);
      else setTimeout(() => el.classList.remove('changed'), 2500);
    };
    requestAnimationFrame(step);
  }

  // ------------------------------------------------------------ render
  function render() {
    const b = S.board || {};
    const a = b.achievements || {};

    // Achievements
    roll($('rev-now'), a.revenue, eur);
    $('rev-goal').textContent = eur(a.revenueGoal);
    $('rev-goal2').textContent = eur(a.revenueGoal);
    const pct = a.revenueGoal ? Math.min(1, (a.revenue || 0) / a.revenueGoal) : 0;
    $('rev-bar').style.width = (pct * 100).toFixed(2) + '%';
    $('rev-pct').textContent = `${(pct * 100).toFixed(pct < 0.1 && pct > 0 ? 1 : 0)}% of the way`;
    // The admin to-do list from FlowDesk
    const td = S.flowdesk && S.flowdesk.todo;
    if (td) {
      $('todo-count').textContent = `${td.open.length} open${td.doneToday ? `, ${td.doneToday} done today` : ''}`;
      $('todo').innerHTML = td.open.map((t) => {
        const meta = [t.urgent ? 'Urgent' : '', t.who, t.doDate ? new Date(t.doDate + 'T12:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : ''].filter(Boolean).join(', ');
        return `<li class="${t.urgent ? 'urgent' : ''}"><span>${esc(t.title)}</span>${meta ? `<small>${esc(meta)}</small>` : ''}</li>`;
      }).join('')
        || '<li><span>Nothing left on the list</span></li>';
    } else {
      $('todo-count').textContent = '';
      $('todo').innerHTML = '<li><span>Reading the FlowDesk to-do list</span></li>';
    }

    // Claude usage: one block per account (session, then the week)
    const pctCls = (v) => (v >= 100 ? 'full' : v >= 85 ? 'warn' : '');
    const todayShort = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const shortReset = (txt) => { const r = String(txt || '').replace(/^resets\s+/, ''); return r.indexOf(todayShort) === 0 ? r.split(',').pop().trim() : r.split(',')[0]; };
    const ring = (p) => {
      const r = 24, c = 2 * Math.PI * r, v = Math.max(0, Math.min(100, p || 0));
      const col = v >= 90 ? '#f87171' : 'url(#gRing)';
      return `<svg viewBox="0 0 58 58"><circle cx="29" cy="29" r="${r}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="6"/>` +
        `<circle cx="29" cy="29" r="${r}" fill="none" stroke="${col}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${(c * v / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 29 29)"/></svg>`;
    };
    $('tokens').innerHTML = (S.tokens || []).map((t) => t.used == null
      ? `<div class="cl off"><div class="cl-ring">${ring(0)}<b>—</b></div><div class="cl-info"><div class="cl-name">${esc(t.account)}</div><div class="cl-sub">${esc(t.note || '')}</div></div></div>`
      : `<div class="cl"><div class="cl-ring">${ring(t.used)}<b>${Math.round(t.used)}%</b></div><div class="cl-info"><div class="cl-name">${esc(t.account)}</div>
          <div class="cl-sub">session${t.note ? ', resets ' + esc(shortReset(t.note)) : ''}</div><div class="cl-sub">week <b>${t.week == null ? '—' : Math.round(t.week) + '%'}</b></div></div></div>`).join('')
      || '<div class="empty">Reading Claude usage</div>';

    // FlowDesk
    const fd = S.flowdesk || {};
    if (fd.ok) {
      $('team-total').textContent = `${fd.doneToday} today, ${fd.doneWeek} this week`;
      const hhmm = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      $('team').innerHTML = fd.people.length ? fd.people.map((p) => `
        <div class="person ${p.status === 'working' ? 'busy' : p.status === 'todo' ? 'idle' : 'clear'}">
          <div class="p-top"><div class="avatar">${esc(p.initials || p.name.slice(0, 2))}</div>
            <div><div class="person-name">${esc(p.name)}</div><div class="p-state">${p.status === 'working' ? `Working${p.since ? ' since ' + hhmm(p.since) : ''}` : p.status === 'todo' ? 'Not started' : 'All done for today'}</div></div></div>
          ${p.working.length ? `<div class="p-now"><small>Working on</small>${esc(p.working[0])}</div>`
            : p.status === 'todo' ? `<div class="p-now late"><small>Not started</small>${esc(p.dueToday[0])}</div>`
            : `<div class="p-now quiet"><small>Last done</small>${p.lastDone ? esc(p.lastDone) : 'Nothing yet today'}</div>`}
          ${(() => {
            const rest = p.dueToday.filter((t) => t !== p.working[0] && !(p.status === 'todo' && t === p.dueToday[0]));
            return rest.length ? `<div class="p-list"><small>Still to do today</small>${rest.slice(0, 3).map((t) => `<div>${esc(t)}</div>`).join('')}${rest.length > 3 ? `<div class="more">and ${rest.length - 3} more</div>` : ''}</div>`
              : `<div class="p-list"><small>Still to do today</small><div class="clear">Nothing else due today</div></div>`;
          })()}
          ${(() => {
            const left = p.dueToday.length, total = p.done + left, pct = total ? Math.round((p.done / total) * 100) : 0;
            return `<div class="p-bar"><div class="p-bar-track"><i style="width:${pct}%"></i></div>` +
              `<div class="p-bar-text"><span><b>${p.done}</b> done</span><span><b>${left}</b> left today</span><span class="wk">${p.week} this week</span></div></div>`;
          })()}
        </div>`).join('') : '<div class="empty">No active employees in FlowDesk.</div>';
    } else {
      $('team-total').textContent = '';
      $('team').innerHTML = fd.configured
        ? '<div class="empty">FlowDesk is not answering. Retrying every 30 seconds.</div>'
        : '<div class="empty">Waiting for FlowDesk access.<br>Add <code>FLOWDESK_SERVICE_ROLE_KEY</code>, or an admin <code>FLOWDESK_EMAIL</code> and <code>FLOWDESK_PASSWORD</code>, to Jarvis\'s .env file.</div>';
    }

    // Lead finder
    const lf = S.leads || {};
    if (lf.ok) {
      roll($('lf-sent'), lf.sitesSentToday);
      roll($('lf-wa'), lf.whatsappToday);
      roll($('lf-new'), lf.leadsToday);
      const tr = lf.tracker || {};
      const hhmm = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '');
      const stuck = tr.queuePaused || tr.buildPaused;
      const now = !tr.online ? `Mac offline since ${hhmm(tr.lastSeen)}`
        : tr.claudeLimited ? `Out of Claude usage${tr.claudeResets ? ` until ${hhmm(tr.claudeResets)}` : ''}`
        : stuck ? `Stuck: ${stuck.replace(/^The finder /, 'the finder ')}`
        : tr.building && tr.building.length ? `Building ${tr.building.length === 1 ? 'a website for ' + tr.building[0] : tr.building.length + ' websites: ' + tr.building.slice(0, 2).join(', ')}`
        : tr.finder ? tr.finder.charAt(0).toUpperCase() + tr.finder.slice(1) : 'Running';
      $('lf-now').textContent = now;
      $('lf-tracker').className = 'tracker' + (!tr.online ? ' down' : stuck || tr.claudeLimited ? ' stuck' : '');
      $('lf-wa-line').textContent = !tr.waOn ? 'WhatsApp sender is off'
        : `WhatsApp: ${tr.waSentToday} sent today${tr.waFailedToday ? `, ${tr.waFailedToday} failed` : ''}${tr.waNext ? `, next at ${hhmm(tr.waNext.at)}${tr.waNext.name ? ' to ' + tr.waNext.name : ''}` : ', done for today'}`;
      roll($('lf-replies'), lf.repliesToday);
      roll($('lf-built'), lf.builtToday);
      roll($('lf-total'), lf.leads);
      // WhatsApps per day, this week
      const week = lf.week || [];
      const most = Math.max(1, ...week.map((d) => d.whatsapps));
      $('lf-week').innerHTML = week.map((d, k) => {
        const today = k === week.length - 1;
        const label = today ? 'Today' : new Date(d.date + 'T12:00').toLocaleDateString('en-GB', { weekday: 'short' });
        return `<div class="wk${today ? ' today' : ''}">${today || d.whatsapps === most ? `<em>${d.whatsapps}</em>` : ''}<i style="height:${Math.max(4, (d.whatsapps / most) * 100)}%"></i><span>${label}</span></div>`;
      }).join('');
      // The pipeline: each stage, and how many of the stage before made it.
      const pl = lf.pipeline;
      if (pl) {
        const stages = [['Contacted', pl.sent], ['They replied', pl.replied], ['We answered', pl.answered], ['Follow-up', pl.followUp], ['Won', pl.won]];
        drawPipeline(pl);
        $('replies').innerHTML = pl.replies.length
          ? pl.replies.slice(0, 2).map((r) => `<div><b>${esc(r.name)}</b> ${esc(r.said)}</div>`).join('')
          : '<div>No WhatsApp replies yet</div>';
      }
    } else {
      $('lf-now').textContent = lf.error ? `Not connected: ${lf.error}` : 'Connecting to the lead finder';
      $('lf-tracker').className = 'tracker down';
    }

    // Innolink
    const il = S.innolink || {};
    if (il.ok) {
      roll($('il-views'), il.views);
      roll($('il-clicks'), il.clicks);
      $('il-rate').textContent = il.views ? Math.round((il.clicks / il.views) * 100) + '%' : '0%';
      const top = Math.max(1, ...il.clients.map((c) => c.views));
      const rows = il.clients.map((c) => `<div class="link-row"><span class="link-name">${esc(c.name)}</span><span>${num(c.views)}</span><span>${num(c.clicks)}</span><i><u style="width:${((c.views / top) * 100).toFixed(1)}%"></u></i></div>`).join('');
      linkList.set(rows);
    } else {
      for (const id of ['il-views', 'il-clicks']) roll($(id), null);
      $('il-rate').textContent = '—';
      const rows = (b.innolinkClients || []).map((n) => `<div class="link-row"><span class="link-name">${esc(n)}</span><span>—</span><span>—</span></div>`).join('');
      linkList.set(rows, il.configured ? 'Innolink is not answering. Retrying.' : 'Add INNOLINK_SERVICE_ROLE_KEY to .env for live opens and clicks.');
    }

    // Something offline: a big notice across the top until it is back.
    const failing = S.failing || {};
    const NAMES = { leads: 'The lead finder', flowdesk: 'FlowDesk', innolink: 'Innolink', board: 'The board' };
    const down = Object.keys(failing).map((k) => `${NAMES[k] || k} is offline`);
    for (const site of S.board && S.board.sites || []) { const h = S.sites && S.sites[site.url]; if (h && !h.ok) down.push(`${site.name} is down`); }
    showOffline(down);

    rotator.sync();
    if ($('wa-view').className.indexOf('show') >= 0) showWhatsApp(true);
    renderLog();
  }

  function showOffline(list) {
    const el = $('offline');
    if (!list.length) { el.className = ''; return; }
    el.innerHTML = `<b>Offline</b>${list.map(esc).join(', ')}`;
    el.className = 'show';
  }

  // ------------------------------------------------------------ pipeline as a flow diagram
  // Every lead the outreach contacted flows left to right: replied or not; of
  // the replies, we answered, they said no, or they're waiting on us; then
  // follow-up; then won. Band widths are numbers of leads. Each stage keeps a
  // label-sized slot so labels never land on each other, and each label sits on
  // a soft backing so a flow passing behind never runs through the text.
  function drawPipeline(pl) {
    const box = $('funnel'), W = box.offsetWidth || 400, H = box.offsetHeight || 210;
    const NODE = 8, GAP = 10, LABEL = 70, SLOT = 40;
    const sent = pl.sent || 0, replied = pl.replied || 0, answered = pl.answered || 0, follow = pl.followUp || 0, won = pl.won || 0;
    const no = Math.min(pl.saidNo || 0, Math.max(0, replied - answered));
    const nodes = {
      sent: { n: sent, label: 'Contacted', color: '#94a3b8' },
      replied: { n: replied, label: 'Replied', color: '#3b82f6' },
      silent: { n: Math.max(0, sent - replied), label: 'No reply yet', color: '#f87171' },
      answered: { n: answered, label: 'We answered', color: '#8b5cf6' },
      waiting: { n: Math.max(0, replied - answered - no), label: 'Waiting on us', color: '#fb923c' },
      no: { n: no, label: 'Said no', color: '#f87171' },
      follow: { n: follow, label: 'Follow-up', color: '#38bdf8' },
      won: { n: won, label: 'Won', color: '#34d399' },
    };
    const links = [['sent', 'replied'], ['sent', 'silent'], ['replied', 'answered'], ['replied', 'waiting'], ['replied', 'no'], ['answered', 'follow'], ['follow', 'won']];
    const cols = [['sent'], ['replied', 'silent'], ['answered', 'waiting', 'no'], ['follow'], ['won']]
      .map((ids) => ids.filter((id) => id === 'sent' || nodes[id].n > 0)).filter((ids) => ids.length);
    const scale = (H - SLOT * 2 - GAP * 2) / Math.max(1, sent);
    // Columns spread over the width; with only one or two stages, they stay a readable distance apart.
    const step = cols.length > 1 ? Math.min((W - NODE - LABEL - 20) / (cols.length - 1), 190) : 0;
    cols.forEach((ids, c) => {
      let y = 0;
      ids.forEach((id) => {
        const nd = nodes[id];
        nd.x = Math.round(c * step); nd.h = Math.max(3, nd.n * scale);
        nd.y = y; nd.out = y; nd.in = y;
        y += Math.max(nd.h, SLOT) + GAP;
      });
    });
    let paths = '';
    for (const [a, b] of links) {
      const A = nodes[a], B = nodes[b], v = B.n * scale;
      if (!B.n) continue;
      const x0 = A.x + NODE, x1 = B.x, ya = A.out, yb = B.in, mx = (x0 + x1) / 2;
      paths += `<path d="M${x0},${ya} C${mx},${ya} ${mx},${yb} ${x1},${yb} L${x1},${yb + v} C${mx},${yb + v} ${mx},${ya + v} ${x0},${ya + v} Z" fill="${B.color}" fill-opacity="0.3"/>`;
      A.out += v; B.in += v;
    }
    let text = '';
    for (const id in nodes) {
      if (nodes[id].x == null) continue;   // an empty stage, not drawn
      const nd = nodes[id], parent = links.filter((l) => l[1] === id)[0];
      paths += `<rect x="${nd.x}" y="${nd.y}" width="${NODE}" height="${nd.h}" rx="2" fill="${nd.color}" fill-opacity="${nd.n ? 1 : 0.35}"/>`;
      const pct = parent && nodes[parent[0]].n ? `<i style="color:${nd.color}">${Math.round((nd.n / nodes[parent[0]].n) * 100)}%</i>` : '';
      const top = Math.round(nd.h < SLOT ? nd.y : Math.min(H - SLOT, nd.y + nd.h / 2 - 16));
      text += `<div class="sk${nd.n ? '' : ' none'}" style="left:${nd.x + NODE + 8}px;top:${top}px"><b>${num(nd.n)}</b>${pct}<span>${nd.label}</span></div>`;
    }
    box.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${paths}</svg><div class="sk-labels">${text}</div>`;
    $('replies').innerHTML = pl.replies.length
      ? pl.replies.slice(0, 1).map((r) => `<div class="rp"><b>${esc(r.name)}</b>${r.auto ? '<i>automatic reply</i>' : ''}<span>${esc(r.said)}</span></div>`).join('')
      : `<div class="rp none">No replies yet from the ${num(pl.sent)} businesses contacted.</div>`;
  }

  function compact(n) {
    if (n == null) return '—';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e4) return Math.round(n / 1e3) + 'k';
    return num(n);
  }

  // Innolink list: scrolls slowly when there are more pages than fit.
  const linkList = (() => {
    const box = $('il-list');
    let html = '';
    const head = '<div class="link-row head"><span class="link-name">Page</span><span>Opens</span><span>Clicks</span></div>';
    box.innerHTML = head + '<div class="link-scroll"><div class="link-track"></div></div>';
    const track = box.querySelector('.link-track');

    return {
      set(rows, note) {
        const next = rows + (note ? `<div class="empty" style="font-size:14px">${esc(note)}</div>` : '');
        if (next !== html) { html = next; track.innerHTML = next; }
      },
    };
  })();

  // ------------------------------------------------------------ live log
  let logKey = '';
  const SOURCE_NAMES = { flowdesk: 'FlowDesk', leads: 'Leads', innolink: 'Innolink', sites: 'Sites', board: 'Board', meta: 'Meta', tokens: 'Usage', voice: 'You', jarvis: 'Jarvis', test: 'Test' };
  function renderLog() {
    const server = (S?.events || []).map((e) => ({ ...e, t: Date.parse(e.at) }));
    const all = [...server, ...localLog].sort((x, y) => y.t - x.t).slice(0, 18);
    const key = all.map((e) => e.id ?? e.t).join(',');
    if (key === logKey) return;
    logKey = key;
    const fresh = Date.now() - 15000;
    $('log').innerHTML = all.map((e) => {
      const cls = e.level === 'jarvis' ? 'jarvis' : e.level;
      const time = new Date(e.t).toLocaleTimeString('en-GB', { hour12: false });
      return `<li class="${cls}${e.level === 'error' && e.t > fresh ? ' fresh' : ''}"><time>${time.slice(0, 5)}</time><b class="src src-${esc(e.source || 'jarvis')}">${esc(SOURCE_NAMES[e.source] || e.source || 'jarvis')}</b><span>${esc(e.text)}</span></li>`;
    }).join('');
  }
  function note(text) {
    localLog.push({ level: 'jarvis', text, t: Date.now() });
    if (localLog.length > 40) localLog.shift();
    renderLog();
  }

  // ------------------------------------------------------------ our work: the demo films
  // Every demo we've built, one after another, as a film of the real site
  // scrolling (made on the PC; the TV's browser can't run modern sites itself).
  // Two players take turns: while one plays, the next film loads in the other,
  // so each switch is instant. A site with no film yet shows its picture.
  const rotator = (() => {
    const view = $('site-view');
    const players = [0, 1].map(() => {
      const v = document.createElement('video');
      v.muted = true; v.setAttribute('muted', ''); v.setAttribute('playsinline', ''); v.preload = 'auto';
      view.appendChild(v);
      return v;
    });
    const pic = new Image(); pic.alt = ''; view.appendChild(pic);
    // TV browsers draw <video> as black; on those the film comes as a stream of
    // pictures from the server instead (any browser shows a picture).
    const STREAM = /Tizen|SMART-TV|Web0S|NetCast/i.test(navigator.userAgent) || /[?&]stream/.test(location.search);
    const reel = new Image(); reel.alt = ''; view.appendChild(reel);
    reel.onerror = () => report('picture stream failed for ' + reel.getAttribute('src'));
    players.forEach((v) => { v.onerror = () => report('video error ' + (v.error && v.error.code) + ' for ' + v.getAttribute('src')); });
    const wait = document.createElement('div');
    wait.className = 'browser-wait';
    wait.textContent = 'Filming our sites';
    view.appendChild(wait);
    let list = [], index = -1, front = 0, timer = null, holdUntil = 0;

    const playable = () => list.filter((d) => d.film || (S && S.shots && S.shots[d.url]));
    function label(d) {
      const h = S && S.sites && S.sites[d.url];
      $('site-name').textContent = d.name;
      $('site-url').textContent = d.url.replace(/^https?:\/\//, '');
      $('site-health').className = 'dot ' + (h ? (h.ok ? 'ok' : 'bad') : 'ok');
      $('site-count').textContent = `${index + 1} of ${playable().length}`;
    }
    function picOf(d) {
      const shot = S && S.shots && S.shots[d.url];
      return shot ? (typeof shot === 'string' ? shot : shot.small || shot.full) : null;
    }
    // Load a film into the player that is not showing.
    function prime(d) {
      const back = players[1 - front];
      if (d && d.film && back.getAttribute('src') !== d.film) { back.setAttribute('src', d.film); back.load(); }
    }
    function go(i) {
      const all = playable();
      if (!all.length) return;
      clearTimeout(timer);
      index = ((i % all.length) + all.length) % all.length;
      const d = all[index];
      wait.style.display = 'none';
      label(d);
      if (d.film) {
        if (STREAM) {
          const slug = (d.film.match(/\/demos\/([a-z0-9-]+)\./) || [])[1];
          reel.src = '/film-stream/' + slug + '?t=' + Date.now();
          reel.className = 'show'; pic.className = ''; players[0].className = players[1].className = '';
          timer = setTimeout(() => go(index + 1), 11000);
          return;
        }
        const v = players[1 - front];
        if (v.getAttribute('src') !== d.film) { v.setAttribute('src', d.film); v.load(); }
        v.currentTime = 0;
        const p = v.play();
        if (p && p.catch) p.catch(() => {});
        v.className = 'show'; players[front].className = ''; pic.className = '';
        players[front].pause();
        front = 1 - front;
        v.onended = () => { if (holdUntil <= Date.now()) go(index + 1); else { v.currentTime = 0; v.play(); } };
        timer = setTimeout(() => go(index + 1), 16000);   // a film that stalls doesn't stop the show
      } else {
        pic.src = picOf(d); pic.className = 'show'; reel.className = '';
        players[0].className = players[1].className = '';
        players[front].pause();
        timer = setTimeout(() => go(index + 1), 6000);
      }
      prime(all[(index + 1) % all.length]);
    }
    return {
      current: () => playable()[index],
      next() { holdUntil = 0; go(index + 1); },
      previous() { holdUntil = 0; go(index - 1); },
      // Show one site and stay on it for a while ("pull up Okulya").
      show(url) {
        const i = playable().findIndex((d) => d.url.replace(/\/$/, '') === String(url).replace(/\/$/, ''));
        if (i >= 0) { holdUntil = Date.now() + 30000; go(i); }
      },
      sync() {
        list = (S && S.demos) || [];
        if (index === -1 && playable().length) go(0);
        else if (index >= 0) $('site-count').textContent = `${index + 1} of ${playable().length}`;
      },
    };
  })();

  // "Give me a summary": each panel full screen in turn while Jarvis talks, then back.
  let touring = null;
  function tour() {
    clearTimeout(touring);
    const keys = ['ach', 'lead', 'pipe', 'team', 'todo', 'link', 'meta', 'log'].filter((k) => panels[k]);
    let i = 0;
    const next = () => {
      if (i >= keys.length) { unzoom(); touring = null; return; }
      zoom(keys[i++], 8);
      touring = setTimeout(next, 6000);
    };
    next();
  }

  // WhatsApp takes the place of the website on the monitor until "go back".
  function showWhatsApp(on) {
    const el = $('wa-view');
    el.className = on ? 'wa-view show' : 'wa-view';
    if (!on) { const d = rotator.current(); if (d) $('site-name').textContent = d.name; return; }
    $('site-name').textContent = 'WhatsApp';
    const wa = S && S.whatsapp;
    $('wa-chat').textContent = wa && wa.chat ? wa.chat : wa && wa.qr ? 'scan to link' : 'starting';
    $('wa-msgs').innerHTML = wa && wa.ready && wa.messages && wa.messages.length
      ? wa.messages.slice(-12).map((m) => `<div class="wa-m${m.mine ? ' mine' : ''}"><b>${esc(m.from)}</b>${esc(m.text)}<i>${esc(m.time || '')}</i></div>`).join('')
      : wa && wa.qr ? `<div class="wa-qr"><img src="${wa.qr}" alt=""><div>On the phone: WhatsApp, Settings, <b>Linked devices</b>, <b>Link a device</b>, then scan this code.</div></div>`
      : wa && wa.ready ? `<div class="wa-empty">${esc(wa.detail || 'Linked. Waiting for the group chat.')}</div>`
      : '<div class="wa-empty">WhatsApp is starting on the Jarvis computer.</div>';
  }

  // Tell the server about a playback problem on this screen.
  function report(msg) {
    try {
      const x = new XMLHttpRequest();
      x.open('POST', '/api/client-log'); x.setRequestHeader('Content-Type', 'application/json');
      x.send(JSON.stringify({ msg: msg + ' | ' + navigator.userAgent.slice(-60) }));
    } catch (err) { /* nothing to do */ }
  }

  // ------------------------------------------------------------ fx: confetti and fireworks
  const fx = (() => {
    const canvas = $('fx');
    const ctx = canvas.getContext('2d');
    const parts = [];
    const COLORS = ['#3b82f6', '#8b5cf6', '#38bdf8', '#f1f5f9', '#34d399', '#fb923c'];
    let running = false;

    function resize() {
      canvas.width = stacked ? stage.offsetWidth : SW;
      canvas.height = stacked ? stage.offsetHeight : H;
      canvas.style.width = canvas.width + 'px';
      canvas.style.height = canvas.height + 'px';
    }
    function confetti(x, y, n = 160, spread = 1) {
      for (let i = 0; i < n; i++) {
        const a = rand(-Math.PI, 0), v = rand(6, 17) * spread;
        parts.push({ kind: 'c', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 4, w: rand(7, 14), h: rand(4, 8), r: rand(0, 6), vr: rand(-0.3, 0.3), c: pick(COLORS), life: rand(160, 260) });
      }
      start();
    }
    function rain(n = 220) {
      for (let i = 0; i < n; i++) parts.push({ kind: 'c', x: rand(0, canvas.width), y: rand(-400, -10), vx: rand(-2, 2), vy: rand(2, 6), w: rand(7, 14), h: rand(4, 8), r: rand(0, 6), vr: rand(-0.2, 0.2), c: pick(COLORS), life: 420 });
      start();
    }
    function rocket(x) {
      parts.push({ kind: 'r', x, y: canvas.height + 10, vx: rand(-1.5, 1.5), vy: rand(-19, -14), c: pick(COLORS), life: 200 });
      start();
    }
    function burst(x, y, c) {
      const n = 90;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2, v = rand(3, 9);
        parts.push({ kind: 's', x, y, px: x, py: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, c: Math.random() < 0.25 ? '#ffffff' : c, life: rand(60, 100), max: 100 });
      }
      sound.pop();
    }
    function fireworks(seconds = 6) {
      const end = performance.now() + seconds * 1000;
      const launch = () => {
        if (performance.now() > end) return;
        rocket(rand(canvas.width * 0.1, canvas.width * 0.9));
        setTimeout(launch, rand(250, 600));
      };
      launch();
    }
    function start() { if (!running) { running = true; requestAnimationFrame(frame); } }
    function frame() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        p.life--;
        if (p.kind === 'c') {
          p.vx *= 0.985; p.vy = p.vy * 0.985 + 0.32; p.x += p.vx + Math.sin(p.life / 9) * 0.6; p.y += p.vy; p.r += p.vr;
          ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c;
          ctx.globalAlpha = Math.min(1, p.life / 40);
          ctx.fillRect(-p.w / 2, -p.h / 2 * Math.abs(Math.cos(p.life / 6)), p.w, p.h * Math.abs(Math.cos(p.life / 6)) + 1);
          ctx.restore();
        } else if (p.kind === 'r') {
          p.x += p.vx; p.y += p.vy; p.vy += 0.22;
          ctx.fillStyle = p.c; ctx.globalAlpha = 1;
          ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, 7); ctx.fill();
          ctx.globalAlpha = 0.4; ctx.fillRect(p.x - 1, p.y, 2, 22);
          if (p.vy >= -1.5) { burst(p.x, p.y, p.c); p.life = 0; }
        } else {
          p.px = p.x; p.py = p.y; p.vx *= 0.96; p.vy = p.vy * 0.96 + 0.08; p.x += p.vx; p.y += p.vy;
          ctx.strokeStyle = p.c; ctx.globalAlpha = Math.max(0, p.life / p.max); ctx.lineWidth = 2.5;
          ctx.beginPath(); ctx.moveTo(p.px - p.vx * 2, p.py - p.vy * 2); ctx.lineTo(p.x, p.y); ctx.stroke();
        }
        if (p.life <= 0 || p.y > canvas.height + 60) parts.splice(i, 1);
      }
      ctx.globalAlpha = 1;
      if (parts.length) requestAnimationFrame(frame); else { running = false; ctx.clearRect(0, 0, canvas.width, canvas.height); }
    }
    return { resize, confetti, rain, fireworks };
  })();

  // ------------------------------------------------------------ sound
  const sound = (() => {
    let ac = null;
    const ok = () => ac && ac.state !== 'suspended' && ac.state !== 'closed';
    // Sound starts by itself where the TV allows it; otherwise the first press
    // of any remote button turns it on. Nothing has to be clicked.
    function arm() {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!ac && Ctx) ac = new Ctx();
        if (ac && ac.resume && ac.state === 'suspended') ac.resume().catch(() => {});
      } catch (err) { /* no sound on this set */ }
    }
    function tone(freq, t0, dur, type = 'sine', vol = 0.18) {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(vol, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(ac.destination); o.start(t0); o.stop(t0 + dur + 0.05);
    }
    return {
      arm,
      chime() {
        if (!ok()) return;
        const t = ac.currentTime;
        [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => tone(f, t + i * 0.11, 0.6, 'triangle', 0.16));
      },
      pop() {
        if (!ok()) return;
        const t = ac.currentTime, len = 0.25;
        const buf = ac.createBuffer(1, ac.sampleRate * len, ac.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3);
        const src = ac.createBufferSource(), g = ac.createGain();
        g.gain.value = 0.12; src.buffer = buf; src.connect(g).connect(ac.destination); src.start(t);
      },
      siren(seconds = 8) {
        if (!ok()) return;
        const t = ac.currentTime;
        const o = ac.createOscillator(), g = ac.createGain(), lfo = ac.createOscillator(), depth = ac.createGain();
        o.type = 'sawtooth'; o.frequency.value = 760;
        lfo.type = 'square'; lfo.frequency.value = 1.6; depth.gain.value = 220;
        lfo.connect(depth).connect(o.frequency);
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.16, t + 0.05);
        g.gain.setValueAtTime(0.16, t + seconds - 0.3); g.gain.linearRampToValueAtTime(0, t + seconds);
        o.connect(g).connect(ac.destination);
        o.start(t); lfo.start(t); o.stop(t + seconds); lfo.stop(t + seconds);
      },
    };
  })();

  // ------------------------------------------------------------ the octopus
  // A soft yellow plush octopus: a tall dome head with a seam across it, two
  // small round eyes, and eight thick arms with cream undersides that taper and
  // curl at the tips. It swims between the panels: the arms wave and trail
  // behind it, and its eyes look where it's going. Drawn at 30 frames a second,
  // with no blur or shadow effects, so the TV keeps up. (Still called "spider"
  // in the code below.)
  const spider = (() => {
    const el = $('spider');
    const ARMS = 8;
    // Back arms (odd) sit behind the head and are a shade darker; front arms sit over it.
    const armEls = (cls) => {
      let h = '';
      for (let i = 0; i < ARMS; i++) {
        if ((i % 2 === 1) !== (cls === 'back')) continue;
        h += `<path class="arm-under" data-i="${i}" fill="${cls === 'back' ? '#efd795' : '#fff0bf'}"/><path class="arm-top" data-i="${i}" fill="url(#${cls === 'back' ? 'octoArmBack' : 'octoArm'})"/>`;
      }
      return h;
    };
    let svg = '<svg viewBox="-90 -92 180 184">';
    svg += '<defs>' +
      '<radialGradient id="octoBody" cx="0.38" cy="0.3" r="0.85"><stop offset="0" stop-color="#ffe27a"/><stop offset="0.45" stop-color="#fcc419"/><stop offset="1" stop-color="#e9a000"/></radialGradient>' +
      '<linearGradient id="octoArm" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fcc419"/><stop offset="1" stop-color="#f2b000"/></linearGradient>' +
      '<linearGradient id="octoArmBack" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e5a400"/><stop offset="1" stop-color="#d49400"/></linearGradient>' +
      '</defs>';
    svg += '<g class="arms-back">' + armEls('back') + '</g>';
    svg += '<path class="octo-body" fill="url(#octoBody)" d="M-25,12 C-29,-6 -36,-28 -35,-50 C-33,-75 -17,-86 0,-86 C17,-86 33,-75 35,-50 C36,-28 29,-6 25,12 Z"/>' +
      '<path d="M-33,-36 Q0,-25 33,-36" fill="none" stroke="#b97f00" stroke-opacity="0.35" stroke-width="1.4"/>' +
      '<ellipse cx="-13" cy="-63" rx="9" ry="14" fill="#fff" fill-opacity="0.12" transform="rotate(-16 -13 -63)"/>';
    svg += '<g class="arms-front">' + armEls('front') + '</g>';
    svg += '<g class="eyes">' +
      '<circle cx="-16" cy="-14" r="6.2" fill="#fff" stroke="#d6d3d1" stroke-width="0.9"/><circle cx="16" cy="-14" r="6.2" fill="#fff" stroke="#d6d3d1" stroke-width="0.9"/>' +
      '<circle class="pupil" cx="-16" cy="-14" r="3.7" fill="#111"/><circle class="pupil" cx="16" cy="-14" r="3.7" fill="#111"/>' +
      '<circle class="glint" cx="-17.2" cy="-15.4" r="1.1" fill="#fff"/><circle class="glint" cx="14.8" cy="-15.4" r="1.1" fill="#fff"/>' +
      '</g>';
    svg += '</svg>';
    el.innerHTML = svg;
    const unders = [], tops = [];
    [].forEach.call(el.querySelectorAll('.arm-under'), (p) => { unders[+p.getAttribute('data-i')] = p; });
    [].forEach.call(el.querySelectorAll('.arm-top'), (p) => { tops[+p.getAttribute('data-i')] = p; });
    const pupils = el.querySelectorAll('.pupil'), glints = el.querySelectorAll('.glint');

    const s = { x: 960, y: -90, vx: 0, vy: 0, hop: 0, spin: 0, shake: 0, phase: 0, moving: false, target: null, happy: 0 };
    let last = performance.now(), lastDraw = 0;

    // One arm: a centre line that heads down and out, waves, and curls outward
    // at the tip; around it a tapered shape, with the cream underside showing on
    // the inside of the curl. Returns [underside, top] path strings.
    const N = 9, f = (v) => v.toFixed(1);
    function armShapes(i, trailX, trailY) {
      const off = (i - 3.5) / 3.5, side = off < 0 ? -1 : 1, back = i % 2 === 1;
      const L = back ? 58 : 68, W = back ? 8.6 : 10.2, seg = L / N;
      const deg = Math.PI / 180;
      const pts = [];
      let x = off * 21, y = 2;
      for (let j = 0; j <= N; j++) {
        const a = j / N;
        const theta = (90 - off * 30 - side * 125 * a * a * a + Math.sin(s.phase * 1.6 + i * 0.9 + a * 3) * 13 * a) * deg;
        pts.push([x + trailX * L * a * a, y + trailY * L * a * a]);
        x += Math.cos(theta) * seg; y += Math.sin(theta) * seg;
      }
      // The curl bends toward this side of the arm, so the underside shows there.
      const c = -side;
      const edge = (k) => pts.map((p, j) => {
        const q = pts[Math.min(N, j + 1)], r = pts[Math.max(0, j - 1)];
        let tx = q[0] - r[0], ty = q[1] - r[1];
        const len = Math.sqrt(tx * tx + ty * ty) || 1;
        tx /= len; ty /= len;
        const w = W * (1 - 0.62 * (j / N)) * k;
        return [p[0] - ty * w * c, p[1] + tx * w * c, tx, ty];
      });
      const shape = (kOut, kIn) => {
        const A = edge(-kOut), B = edge(kIn), tip = pts[N], tA = A[N];
        const w = W * 0.38;
        let d = `M${f(A[0][0])},${f(A[0][1])}`;
        for (let j = 1; j <= N; j++) d += `L${f(A[j][0])},${f(A[j][1])}`;
        d += `Q${f(tip[0] + tA[2] * w * 1.7)},${f(tip[1] + tA[3] * w * 1.7)} ${f(B[N][0])},${f(B[N][1])}`;
        for (let j = N - 1; j >= 0; j--) d += `L${f(B[j][0])},${f(B[j][1])}`;
        return d + 'Z';
      };
      return [shape(1, 1.1), shape(1.02, 0.5)];
    }

    function frame(t) {
      requestAnimationFrame(frame);
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      let vx = 0, vy = 0;
      if (s.target) {
        const dx = s.target.x - s.x, dy = s.target.y - s.y, dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 3 || (s.target.abort && s.target.abort())) {
          const done = s.target.done; s.target = null; s.moving = false; done();
        } else {
          // Jetting: the speed swells and eases with each squeeze of the body.
          const surge = 0.65 + 0.55 * Math.max(0, Math.sin(s.phase * 1.1));
          const step = Math.min(dist, s.target.speed * surge * dt);
          vx = (dx / dist) * step / dt; vy = (dy / dist) * step / dt;
          s.x += (dx / dist) * step; s.y += (dy / dist) * step;
          s.moving = true;
        }
      }
      s.vx += (vx - s.vx) * Math.min(1, dt * 4);
      s.vy += (vy - s.vy) * Math.min(1, dt * 4);
      s.phase += dt * (s.moving ? 5.5 : 2.2) * (s.happy > 0 ? 2.2 : 1);
      if (s.happy > 0) s.happy -= dt;
      if (t - lastDraw < 32) return;   // 30 frames a second is plenty, and easy on the TV
      lastDraw = t;
      const sp = Math.sqrt(s.vx * s.vx + s.vy * s.vy) || 1;
      const trailX = s.moving ? (-s.vx / sp) * 0.45 : 0, trailY = s.moving ? (-s.vy / sp) * 0.35 : 0;
      for (let i = 0; i < ARMS; i++) { const d = armShapes(i, trailX, trailY); unders[i].setAttribute('d', d[0]); tops[i].setAttribute('d', d[1]); }
      // Eyes follow the way it's going.
      const lx = s.moving ? (s.vx / sp) * 2.6 : Math.sin(t / 1400) * 1.5, ly = s.moving ? (s.vy / sp) * 2 : 0;
      pupils[0].setAttribute('cx', -16 + lx); pupils[0].setAttribute('cy', -14 + ly);
      pupils[1].setAttribute('cx', 16 + lx); pupils[1].setAttribute('cy', -14 + ly);
      glints[0].setAttribute('cx', -17.2 + lx); glints[1].setAttribute('cx', 14.8 + lx);
      // Squish: wide and short as it squeezes, tall and thin as it shoots forward.
      const pulse = Math.sin(s.phase * 1.1);
      const sx = 1 + (s.moving ? 0.1 : 0.04) * pulse, sy = 1 - (s.moving ? 0.09 : 0.035) * pulse;
      const tilt = Math.max(-16, Math.min(16, s.vx * 0.05));
      const jx = s.shake ? rand(-s.shake, s.shake) : 0, jy = s.shake ? rand(-s.shake, s.shake) : 0;
      const tr = `translate(${(s.x + jx).toFixed(1)}px, ${(s.y - s.hop + jy).toFixed(1)}px) rotate(${(tilt + s.spin).toFixed(1)}deg) scale(${(sx * (1 + s.hop / 220)).toFixed(3)}, ${(sy * (1 + s.hop / 220)).toFixed(3)})`;
      el.style.webkitTransform = tr; el.style.transform = tr;
    }
    requestAnimationFrame(frame);

    return {
      state: s,
      el,
      walkTo(x, y, speed = 220, abort) {
        return new Promise((done) => { s.target = { x, y, speed, abort, done }; });
      },
      face() {},
      async hop(times = 3, spin = true) {
        s.happy = times * 0.6 + 0.5;
        for (let n = 0; n < times; n++) {
          const t0 = performance.now(), dur = 560;
          await new Promise((r) => {
            const step = (t) => {
              const k = Math.min(1, (t - t0) / dur);
              s.hop = Math.sin(k * Math.PI) * 60;
              if (spin) s.spin = Math.sin(k * Math.PI * 2) * 14;
              if (k < 1) requestAnimationFrame(step); else { s.hop = 0; s.spin = 0; r(); }
            };
            requestAnimationFrame(step);
          });
        }
      },
    };
  })();

  // Where the spider stands on a panel: on its top edge, looking in.
  function spotOn(key, centre = false) {
    const p = panels[key];
    return { x: p.offsetLeft + p.offsetWidth * (centre ? 0.5 : rand(0.22, 0.78)), y: p.offsetTop + 8 };
  }

  // ------------------------------------------------------------ the show
  const queue = [];
  const interrupted = () => queue.length > 0;

  async function patrol(lastKey) {
    if (zoomed) {
      await spider.walkTo(SW / 2, 96, 300, interrupted);
      spider.face(180);
      await sleep(500);
      return lastKey;
    }
    const keys = Object.keys(panels).filter((k) => k !== lastKey);
    const key = pick(keys);
    const pt = spotOn(key);
    await spider.walkTo(pt.x, pt.y, rand(220, 320), interrupted);
    if (interrupted()) return key;
    spider.face(180);
    await sleep(500);
    const panel = panels[key];
    panel.classList.add('scanning');
    const t0 = performance.now(), total = rand(3500, 5500);
    while (performance.now() - t0 < total && !interrupted()) await sleep(200);
    panel.classList.remove('scanning');
    // Now and then it likes what it sees.
    if (!interrupted() && ['ach', 'lead', 'link', 'team'].includes(key) && Math.random() < 0.18) {
      const r = spider.state;
      fx.confetti(r.x, r.y, 40, 0.6);
      await spider.hop(1);
    }
    return key;
  }

  function insight(key) {
    if (!S) return '';
    const a = S.board?.achievements || {};
    const days = S.board?.countdown ? Math.max(0, Math.ceil((new Date(S.board.countdown.target) - Date.now()) / 864e5)) : null;
    switch (key) {
      case 'ach': return `${eur(a.revenue)} of ${eur(a.revenueGoal)}, ${S.flowdesk && S.flowdesk.todo ? S.flowdesk.todo.open.length + ' to do' : ''}`;
      case 'pipe': { const pl = S.leads && S.leads.pipeline; return pl ? `${pl.sent} contacted, ${pl.replied} replied, ${pl.won} won` : ''; }
      case 'site': { const c = rotator.current(); const h = c && S.sites?.[c.url]; return c ? `${c.name} ${h ? (h.ok ? `answers in ${h.ms} ms` : 'is not answering') : 'online'}` : ''; }
      case 'meta': { const t = (S.tokens || []).filter((x) => x.used != null); return t.length ? t.map((x) => `${x.account} ${Math.round(x.used)}%`).join(', ') : 'Claude usage'; }
      case 'team': return S.flowdesk?.ok ? `${S.flowdesk.doneToday} done today, ${S.flowdesk.doneWeek} this week, ${S.flowdesk.inProgress} in progress` : 'FlowDesk not connected';
      case 'lead': return S.leads?.ok ? `${num(S.leads.sitesSentToday)} sites sent, ${num(S.leads.whatsappToday)} WhatsApps, ${num(S.leads.leadsToday)} new leads today` : '';
      case 'link': return S.innolink?.ok ? `${num(S.innolink.views)} opens, ${num(S.innolink.clicks)} clicks on ${S.innolink.clients.length} pages` : `${(S.board?.innolinkClients || []).length} Innolink pages`;
      case 'log': { const errs = (S.events || []).filter((e) => e.level === 'error' && Date.now() - Date.parse(e.at) < 864e5).length; return errs ? `${errs} alert${errs > 1 ? 's' : ''} in the last 24 hours` : 'No alerts in the last 24 hours'; }
    }
    return '';
  }

  const banner = $('banner');
  function showBanner(title, text, danger, ms) {
    banner.className = danger ? 'danger' : '';
    banner.innerHTML = `<div class="b-title">${esc(title)}</div><div class="b-text">${esc(text)}</div>`;
    requestAnimationFrame(() => banner.classList.add('show'));
    setTimeout(() => banner.classList.remove('show'), ms);
  }

  async function celebrate(e) {
    unzoom();
    const key = panels[e.panel] ? e.panel : 'ach';
    const panel = panels[key];
    const pt = spotOn(key, true);
    await spider.walkTo(pt.x, pt.y, 760);
    spider.face(180);
    panel.classList.add('party');
    sound.chime();
    if (e.big) {
      showBanner(e.title || 'ACHIEVEMENT', e.text, false, 7000);
      fx.confetti(pt.x, pt.y, 260, 1.2);
      fx.rain(240);
      fx.fireworks(6);
      await spider.hop(4);
      fx.confetti(pt.x, pt.y, 160, 1);
      await spider.hop(3);
    } else {
      fx.confetti(pt.x, pt.y, 90, 0.8);
      await spider.hop(2);
    }
    setTimeout(() => panel.classList.remove('party'), e.big ? 4000 : 1500);
  }

  const alarmEl = $('alarm');
  async function alarm(e) {
    unzoom();
    const key = panels[e.panel] ? e.panel : 'log';
    const panel = panels[key];
    spider.el.classList.add('angry');
    alarmEl.classList.add('on');
    panel.classList.add('danger');
    sound.siren(8);
    showBanner('ALERT', e.text, true, 9000);
    const pt = spotOn(key, true);
    await spider.walkTo(pt.x, pt.y, 900);
    spider.face(180);
    spider.state.shake = 4;
    await sleep(7000);
    spider.state.shake = 0;
    alarmEl.classList.remove('on');
    spider.el.classList.remove('angry');
    setTimeout(() => panel.classList.remove('danger'), 20000);
  }

  async function show() {
    let lastKey = null;
    await spider.walkTo(SW / 2, 140, 300);
    for (;;) {
      if (queue.length) {
        // Alarms jump the queue.
        const i = queue.findIndex((e) => e.level === 'error');
        const e = queue.splice(i >= 0 ? i : 0, 1)[0];
        try { await (e.level === 'error' ? alarm(e) : celebrate(e)); } catch (err) { console.error(err); }
        continue;
      }
      try { lastKey = await patrol(lastKey); } catch (err) { console.error(err); await sleep(1000); }
    }
  }

  // ------------------------------------------------------------ zoom ("pull up ...")
  let zoomed = null, zoomTimer = null;
  function setTransform(el, t) { el.style.webkitTransform = t; el.style.transform = t; }
  function zoom(key, seconds) {
    const p = panels[key];
    if (!p || stacked) return;
    if (zoomed && zoomed !== key) unzoom();
    // Grow the panel from its own centre to fill the area under the header.
    const tx = 20, ty = 108, tw = SW - 40, th = H - 128;
    const k = Math.min(tw / p.offsetWidth, th / p.offsetHeight);
    setTransform(p, `translate(${Math.round(tx + tw / 2 - (p.offsetLeft + p.offsetWidth / 2))}px, ${Math.round(ty + th / 2 - (p.offsetTop + p.offsetHeight / 2))}px) scale(${k.toFixed(3)})`);
    p.classList.add('zoomed');
    $('dim').classList.add('on');
    zoomed = key;
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(unzoom, (seconds || 120) * 1000);
  }
  function unzoom() {
    if (!zoomed) return;
    const p = panels[zoomed];
    setTransform(p, '');
    $('dim').classList.remove('on');
    setTimeout(() => p.classList.remove('zoomed'), 600);
    zoomed = null;
    clearTimeout(zoomTimer);
  }

  // ------------------------------------------------------------ voice: commands from /voice
  // The server turns what was said into a command. The TV checks every second,
  // acts on new ones, shows the exchange and speaks the reply.
  let lastCommand = null, muted = false, sayTimer = null;
  function showSay(heard, reply) {
    $('say-heard').textContent = heard ? `"${heard}"` : '';
    $('say-reply').textContent = reply || '';
    $('say').className = 'show';
    clearTimeout(sayTimer);
    sayTimer = setTimeout(() => { $('say').className = ''; }, Math.max(6000, (reply || '').split(' ').length * 420));
  }
  function speak(c) {
    if (muted || !c.reply || !(S && S.board && S.board.tvSpeaks)) return;
    const fallback = () => {
      if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) return;
      const u = new SpeechSynthesisUtterance(c.reply);
      u.lang = 'en-GB';
      window.speechSynthesis.speak(u);
    };
    try {
      const a = new Audio('/api/tts/' + c.id);
      const p = a.play();
      if (p && p.catch) p.catch(fallback);
    } catch (err) { fallback(); }
  }
  function runCommand(c) {
    if (c.action === 'announce') {
      showSay('', c.reply);
      speak(c);
      if (c.panel) zoom(c.panel, 20);
      return;
    }
    if (c.action === 'thinking') {
      showSay(c.heard, 'Thinking');
      $('say').className = 'show thinking';
      return;
    }
    if (c.action === 'unmute') muted = false;
    showSay(c.heard, c.reply);
    speak(c);
    switch (c.action) {
      case 'zoom': zoom(c.panel); break;
      case 'focus': zoom(c.panel, 30); break;
      case 'unzoom': unzoom(); showWhatsApp(false); break;
      case 'whatsapp': showWhatsApp(true); break;
      case 'tour': tour(); break;
      case 'reload': setTimeout(() => location.reload(), 3000); break;
      case 'next': rotator.next(); break;
      case 'previous': rotator.previous(); break;
      case 'show_site': rotator.show(c.site); zoom('site', 60); break;
      case 'celebrate': queue.push({ level: 'win', panel: 'ach', big: true, title: 'INNOWEB', text: c.reply }); break;
      case 'alarm': queue.push({ level: 'error', panel: 'log', text: 'Alarm test' }); break;
      case 'mute': muted = true; break;
    }
  }
  async function pollCommands() {
    try {
      const r = await getJson('/api/commands' + (lastCommand == null ? '' : '?after=' + lastCommand));
      if (lastCommand == null) { lastCommand = r.last; return; }
      for (const c of r.commands) { lastCommand = Math.max(lastCommand, c.id); runCommand(c); }
    } catch (err) { /* the state poll reports a dead server */ }
  }

  // ------------------------------------------------------------ polling
  let serverDown = false, failures = 0, build = null;
  // XMLHttpRequest rather than fetch: every TV browser has it.
  function getJson(url) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('GET', url + (url.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now());
      x.timeout = 15000;
      x.onload = () => {
        // On the live site without the password yet: go to the password page.
        if (x.status === 401) { location.href = '/login.html?next=' + encodeURIComponent(location.pathname + location.search); return; }
        if (x.status !== 200) return reject(new Error(x.status));
        try { resolve(JSON.parse(x.responseText)); } catch (e) { reject(e); }
      };
      x.onerror = x.ontimeout = () => reject(new Error('network'));
      x.send();
    });
  }
  async function poll() {
    try {
      S = await getJson(`/api/state?vw=${window.innerWidth}&vh=${window.innerHeight}&dpr=${window.devicePixelRatio || 1}`);
      // The server restarted with new code: reload so this TV runs it too.
      if (S.build && build && S.build !== build) { location.reload(); return; }
      build = S.build;
      if (serverDown) note('Jarvis server is back');
      serverDown = false; failures = 0;
      const evs = S.events || [];
      if (lastEventId == null) lastEventId = evs.length ? evs[evs.length - 1].id : 0;
      for (const e of evs) {
        if (e.id <= lastEventId) continue;
        lastEventId = e.id;
        if (!e.history && (e.level === 'win' || e.level === 'error')) queue.push(e);
      }
      render();
    } catch {
      failures++;
      if (failures === 3 && !serverDown) {
        serverDown = true;
        queue.push({ level: 'error', panel: 'log', text: 'Jarvis server is not answering' });
        note('Jarvis server is not answering');
      }
    }
  }

  // ------------------------------------------------------------ start
  addEventListener('resize', layout);
  layout();
  tickClock();
  setInterval(tickClock, 1000);
  poll();
  setInterval(poll, POLL_MS);
  setInterval(pollCommands, 1000);
  show();

  // A clean reload every 6 hours keeps a browser that runs day and night fresh.
  setTimeout(() => location.reload(), 6 * 3600e3);

  sound.arm();
  for (const type of ['keydown', 'click', 'touchstart', 'mousedown']) addEventListener(type, sound.arm, true);

  // Full screen: a browser only allows it after a button press, so the first
  // press of any remote button (OK, an arrow...) puts Jarvis full screen and
  // hides the browser's address bar. A small note says so until then.
  const fsNote = document.createElement('div');
  fsNote.id = 'fs-note';
  fsNote.textContent = 'Press OK on the remote for full screen';
  document.body.appendChild(fsNote);
  const isFull = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
  const goFull = () => {
    if (isFull() || stacked) return;
    const el = document.documentElement, req = el.requestFullscreen || el.webkitRequestFullscreen || el.webkitRequestFullScreen;
    if (req) { try { const r = req.call(el); if (r && r.catch) r.catch(() => {}); } catch (err) { /* not allowed here */ } }
  };
  const fsCheck = () => { fsNote.style.display = isFull() || stacked || window.innerHeight >= screen.height - 4 ? 'none' : 'block'; };
  for (const type of ['keydown', 'click', 'touchstart']) addEventListener(type, goFull, true);
  document.addEventListener('webkitfullscreenchange', () => { fsCheck(); setTimeout(layout, 300); });
  document.addEventListener('fullscreenchange', () => { fsCheck(); setTimeout(layout, 300); });
  setInterval(fsCheck, 3000);
  fsCheck();

  // Keys for testing from a keyboard: C celebrate, A alarm, F full screen.
  addEventListener('keydown', (ev) => {
    if (ev.key === 'c') queue.push({ level: 'win', panel: 'ach', big: true, title: 'TEST WIN', text: 'Celebration test' });
    if (ev.key === 'a') queue.push({ level: 'error', panel: 'log', text: 'Alarm test' });
    if (ev.key === 'f' && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
  });
})();
