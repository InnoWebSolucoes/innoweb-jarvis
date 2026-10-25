var __defProp = Object.defineProperty;
var __defProps = Object.defineProperties;
var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
var __getOwnPropSymbols = Object.getOwnPropertySymbols;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __propIsEnum = Object.prototype.propertyIsEnumerable;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __spreadValues = (a, b) => {
  for (var prop in b || (b = {}))
    if (__hasOwnProp.call(b, prop))
      __defNormalProp(a, prop, b[prop]);
  if (__getOwnPropSymbols)
    for (var prop of __getOwnPropSymbols(b)) {
      if (__propIsEnum.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    }
  return a;
};
var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));
var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    };
    var rejected = (value) => {
      try {
        step(generator.throw(value));
      } catch (e) {
        reject(e);
      }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};
if (!Object.fromEntries) Object.fromEntries = (pairs) => {
  const o = {};
  for (const [k, v] of pairs) o[k] = v;
  return o;
};
if (!String.prototype.padStart) String.prototype.padStart = function(n, c) {
  let s = String(this);
  while (s.length < n) s = (c || " ") + s;
  return s.slice(-Math.max(n, String(this).length));
};
if (window.NodeList && !NodeList.prototype.forEach) NodeList.prototype.forEach = Array.prototype.forEach;
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const stage = $("stage");
  const W = 1920, H = 1080;
  const POLL_MS = 5e3;
  const eur = (n) => "\u20AC" + Math.round(n || 0).toLocaleString("en-IE");
  const num = (n) => Math.round(n || 0).toLocaleString("en-IE");
  const esc = (s) => String(s != null ? s : "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const PANEL_NAMES = { ach: "Goal", todo: "To do", site: "Our work", meta: "Claude usage", team: "FlowDesk team", pipe: "Pipeline", lead: "Lead finder", link: "Innolink", log: "Live log" };
  const panels = Object.fromEntries([...document.querySelectorAll("[data-panel]")].map((el) => [el.dataset.panel, el]));
  let S = null;
  let lastEventId = null;
  const localLog = [];
  let stacked = false;
  let SW = W;
  let K = 1;
  function layout() {
    const w = window.innerWidth || document.documentElement.clientWidth;
    const h = window.innerHeight || document.documentElement.clientHeight;
    stacked = w < 700 && h > w;
    if (stacked) document.body.classList.add("stack");
    else document.body.classList.remove("stack");
    if (stacked) {
      stage.style.transform = stage.style.webkitTransform = "";
      stage.style.width = "";
      SW = stage.offsetWidth;
    } else {
      SW = Math.max(W, Math.round(H * w / h));
      stage.style.width = SW + "px";
      const k = Math.min(w / SW, h / H);
      K = k;
      const t = `translate(${Math.round((w - SW * k) / 2)}px, ${Math.round((h - H * k) / 2)}px) scale(${k})`;
      stage.style.webkitTransform = t;
      stage.style.transform = t;
    }
    fx.resize();
  }
  function tickClock() {
    var _a;
    const now = /* @__PURE__ */ new Date();
    $("clock-time").textContent = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
    const hr = now.getHours();
    $("greet").textContent = `${hr < 5 ? "Working late" : hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening"}, Innoweb`;
    $("clock-date").textContent = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    const cd = (_a = S == null ? void 0 : S.board) == null ? void 0 : _a.countdown;
    if (!cd) return;
    let left = Math.max(0, new Date(cd.target) - now);
    const d = Math.floor(left / 864e5);
    left -= d * 864e5;
    const h = Math.floor(left / 36e5);
    left -= h * 36e5;
    const m = Math.floor(left / 6e4);
    left -= m * 6e4;
    const s = Math.floor(left / 1e3);
    $("cd-d").textContent = String(d).padStart(2, "0");
    $("cd-h").textContent = String(h).padStart(2, "0");
    $("cd-m").textContent = String(m).padStart(2, "0");
    $("cd-s").textContent = String(s).padStart(2, "0");
    $("cd-label").textContent = cd.label || "";
  }
  const values = /* @__PURE__ */ new Map();
  function roll(el, to, format = num) {
    if (to == null || Number.isNaN(to)) {
      el.textContent = "\u2014";
      values.delete(el);
      return;
    }
    const from = values.get(el);
    if (from === to) return;
    values.set(el, to);
    if (from == null) {
      el.textContent = format(to);
      return;
    }
    const t0 = Date.now(), ms = 1400;
    el.classList.add("changed");
    const step = () => {
      if (values.get(el) !== to) return;
      const k = Math.min(1, (Date.now() - t0) / ms);
      el.textContent = format(from + (to - from) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(step);
      else setTimeout(() => el.classList.remove("changed"), 2500);
    };
    requestAnimationFrame(step);
  }
  function render() {
    const b = S.board || {};
    const a = b.achievements || {};
    roll($("rev-now"), a.revenue, eur);
    $("rev-goal").textContent = eur(a.revenueGoal);
    $("rev-goal2").textContent = eur(a.revenueGoal);
    const pct = a.revenueGoal ? Math.min(1, (a.revenue || 0) / a.revenueGoal) : 0;
    $("rev-bar").style.width = (pct * 100).toFixed(2) + "%";
    $("rev-pct").textContent = `${(pct * 100).toFixed(pct < 0.1 && pct > 0 ? 1 : 0)}% of the way`;
    const td = S.flowdesk && S.flowdesk.todo;
    if (td) {
      $("todo-count").textContent = `${td.open.length} open${td.doneToday ? `, ${td.doneToday} done today` : ""}`;
      $("todo").innerHTML = td.open.map((t) => {
        const meta = [t.urgent ? "Urgent" : "", t.who, t.doDate ? (/* @__PURE__ */ new Date(t.doDate + "T12:00")).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : ""].filter(Boolean).join(", ");
        return `<li class="${t.urgent ? "urgent" : ""}"><span>${esc(t.title)}</span>${meta ? `<small>${esc(meta)}</small>` : ""}</li>`;
      }).join("") || "<li><span>Nothing left on the list</span></li>";
    } else {
      $("todo-count").textContent = "";
      $("todo").innerHTML = "<li><span>Reading the FlowDesk to-do list</span></li>";
    }
    const pctCls = (v) => v >= 100 ? "full" : v >= 85 ? "warn" : "";
    const resets = (iso, fallback) => {
      const ms = Date.parse(iso) - Date.now();
      if (isNaN(ms)) return fallback ? "resets " + fallback : "";
      if (ms <= 0) return "resetting now";
      if (ms < 864e5) {
        const h = Math.floor(ms / 36e5), m = Math.floor(ms % 36e5 / 6e4);
        return "resets in " + (h ? h + "h " : "") + m + "m";
      }
      const d = new Date(iso);
      return "resets " + d.toLocaleDateString("en-GB", { weekday: "short" }) + " " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    };
    const limit = (label, v, when) => `<div class="cu-row"><span>${label} <b>${v == null ? "\u2014" : Math.round(v) + "%"}</b></span><small>${esc(when)}</small></div><div class="cu-bar ${pctCls(v || 0)}"><i style="width:${Math.max(0, Math.min(100, v || 0))}%"></i></div>`;
    $("tokens").innerHTML = (S.tokens || []).map((t) => t.used == null ? `<div class="cu off"><div class="cu-name">${esc(t.account)}</div><div class="cu-row"><small>${esc(t.note === "not signed in yet" ? "not connected yet" : t.note || "")}</small></div></div>` : `<div class="cu"><div class="cu-name">${esc(t.account)}</div>${limit("Session", t.used, resets(t.sessionAt, String(t.note || "").replace(/^resets\s+/, "")))}${limit("Week", t.week, resets(t.weekAt, t.weekReset))}</div>`).join("") || '<div class="empty">Reading Claude usage</div>';
    const fd = S.flowdesk || {};
    if (fd.ok) {
      $("team-total").textContent = `${fd.doneToday} today, ${fd.doneWeek} this week`;
      const hhmm = (iso) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
      $("team").innerHTML = fd.people.length ? fd.people.map((p) => `
        <div class="person ${p.status === "working" ? "busy" : p.status === "todo" ? "idle" : "clear"}">
          <div class="p-top"><div class="avatar">${esc(p.initials || p.name.slice(0, 2))}</div>
            <div><div class="person-name">${esc(p.name)}</div><div class="p-state">${p.status === "working" ? `Working${p.since ? " since " + hhmm(p.since) : ""}` : p.status === "todo" ? "Not started" : "All done for today"}</div></div></div>
          ${p.working.length ? `<div class="p-now"><small>Working on</small>${esc(p.working[0])}</div>` : p.status === "todo" ? `<div class="p-now late"><small>Not started</small>${esc(p.dueToday[0])}</div>` : `<div class="p-now quiet"><small>Last done</small>${p.lastDone ? esc(p.lastDone) : "Nothing yet today"}</div>`}
          ${(() => {
        const rest = p.dueToday.filter((t) => t !== p.working[0] && !(p.status === "todo" && t === p.dueToday[0]));
        return rest.length ? `<div class="p-list"><small>Still to do today</small>${rest.slice(0, 3).map((t) => `<div>${esc(t)}</div>`).join("")}${rest.length > 3 ? `<div class="more">and ${rest.length - 3} more</div>` : ""}</div>` : `<div class="p-list"><small>Still to do today</small><div class="clear">Nothing else due today</div></div>`;
      })()}
          ${(() => {
        const left = p.dueToday.length, total = p.done + left, pct2 = total ? Math.round(p.done / total * 100) : 0;
        return `<div class="p-bar"><div class="p-bar-track"><i style="width:${pct2}%"></i></div><div class="p-bar-text"><span><b>${p.done}</b> done</span><span><b>${left}</b> left today</span><span class="wk">${p.week} this week</span></div></div>`;
      })()}
        </div>`).join("") : '<div class="empty">No active employees in FlowDesk.</div>';
    } else {
      $("team-total").textContent = "";
      $("team").innerHTML = fd.configured ? '<div class="empty">FlowDesk is not answering. Retrying every 30 seconds.</div>' : `<div class="empty">Waiting for FlowDesk access.<br>Add <code>FLOWDESK_SERVICE_ROLE_KEY</code>, or an admin <code>FLOWDESK_EMAIL</code> and <code>FLOWDESK_PASSWORD</code>, to Jarvis's .env file.</div>`;
    }
    const lf = S.leads || {};
    if (lf.ok) {
      roll($("lf-wa"), lf.whatsappToday);
      roll($("lf-email"), lf.emailsToday);
      $("lf-senders").innerHTML = (lf.senders || []).map((x) => `<div class="${x.linked === false ? "off" : ""}"><span>${esc(String(x.label).replace(/^RAFA PERSONAL$/i, "Rafa").replace(/^Personal\s*/i, "Pers "))}</span><b>${num(x.today)}</b></div>`).join("");
      roll($("lf-new"), lf.leadsToday);
      const tr = lf.tracker || {};
      const hhmm = (iso) => iso ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "";
      const stuck = tr.stuck;
      const ago = (iso) => {
        if (!iso) return "";
        const m = Math.round((Date.now() - Date.parse(iso)) / 6e4);
        return m < 1 ? "just now" : m < 60 ? m + " min ago" : hhmm(iso);
      };
      const now = !tr.online ? `Mac offline since ${hhmm(tr.lastSeen)}` : tr.claudeLimited ? `Out of Claude usage${tr.claudeResets ? ` until ${hhmm(tr.claudeResets)}` : ""}` : stuck ? `Stuck: ${stuck.replace(/^The finder /, "the finder ")}` : `Finding leads: the last one ${ago(tr.lastLeadAt)}`;
      $("lf-now").textContent = now;
      $("lf-tracker").className = "tracker" + (!tr.online ? " down" : stuck || tr.claudeLimited ? " stuck" : "");
      $("lf-wa-line").textContent = `WhatsApp: ${num(lf.whatsappToday)} sent today${tr.lastSendAt ? ", the last " + ago(tr.lastSendAt) : ""}`;
      const lm = lf.lastMessage;
      $("lf-last").innerHTML = lm ? `<div class="lf-last-head"><b>Last WhatsApp</b> to ${esc(lm.to)}<span>${esc(lm.from)}, ${new Date(lm.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span></div><div class="lf-last-text">${esc(lm.text).replace(/\n/g, "<br>")}</div>` : "";
      roll($("lf-replies"), lf.repliesToday);
      roll($("lf-total"), lf.leads);
      const week = lf.week || [];
      const most = Math.max(1, ...week.map((d) => d.whatsapps));
      $("lf-week").innerHTML = week.map((d, k) => {
        const today = k === week.length - 1;
        const label = today ? "Today" : (/* @__PURE__ */ new Date(d.date + "T12:00")).toLocaleDateString("en-GB", { weekday: "short" });
        return `<div class="wk${today ? " today" : ""}">${today || d.whatsapps === most ? `<em>${d.whatsapps}</em>` : ""}<i style="height:${Math.max(4, d.whatsapps / most * 100)}%"></i><span>${label}</span></div>`;
      }).join("");
      const pl = lf.pipeline;
      if (pl) {
        const stages = [["Contacted", pl.sent], ["They replied", pl.replied], ["We answered", pl.answered], ["Follow-up", pl.followUp], ["Won", pl.won]];
        drawPipeline(pl);
      }
    } else {
      $("lf-now").textContent = lf.error ? `Not connected: ${lf.error}` : "Connecting to the lead finder";
      $("lf-tracker").className = "tracker down";
    }
    const il = S.innolink || {};
    if (il.ok) {
      roll($("il-views"), il.views);
      roll($("il-clicks"), il.clicks);
      $("il-rate").textContent = il.views ? Math.round(il.clicks / il.views * 100) + "%" : "0%";
      const top = Math.max(1, ...il.clients.map((c) => c.views));
      const rows = il.clients.map((c) => `<div class="link-row"><span class="link-name">${esc(c.name)}</span><span>${num(c.views)}</span><span>${num(c.clicks)}</span><i><u style="width:${(c.views / top * 100).toFixed(1)}%"></u></i></div>`).join("");
      linkList.set(rows);
    } else {
      for (const id of ["il-views", "il-clicks"]) roll($(id), null);
      $("il-rate").textContent = "\u2014";
      const rows = (b.innolinkClients || []).map((n) => `<div class="link-row"><span class="link-name">${esc(n)}</span><span>\u2014</span><span>\u2014</span></div>`).join("");
      linkList.set(rows, il.configured ? "Innolink is not answering. Retrying." : "Add INNOLINK_SERVICE_ROLE_KEY to .env for live opens and clicks.");
    }
    const failing = S.failing || {};
    const NAMES = { leads: "The lead finder", flowdesk: "FlowDesk", innolink: "Innolink", board: "The board" };
    const down = Object.keys(failing).map((k) => `${NAMES[k] || k} is offline`);
    for (const site of S.board && S.board.sites || []) {
      const h = S.sites && S.sites[site.url];
      if (h && !h.ok) down.push(`${site.name} is down`);
    }
    if (S.stale) down.unshift(S.live && S.live.length >= 3 ? "the Jarvis computer is off: voice and films are paused, the figures are live" : S.live && S.live.length ? "the Jarvis computer is off: " + S.live.join(", ") + " live, the rest from " + new Date(S.savedAt).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "the Jarvis computer is off, figures from " + new Date(S.savedAt).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" }));
    showOffline(down);
    rotator.sync();
    if ($("wa-view").className.indexOf("show") >= 0) showWhatsApp(true);
    renderLog();
  }
  function showOffline(list) {
    const el = $("offline");
    if (!list.length) {
      el.className = "";
      return;
    }
    el.innerHTML = `<b>Offline</b>${list.map(esc).join(", ")}`;
    el.className = "show";
  }
  function drawPipeline(pl) {
    const box = $("funnel"), W2 = box.offsetWidth || 400, H2 = box.offsetHeight || 210;
    const NODE = 8, GAP = 10, LABEL = 70, SLOT = 40;
    const sent = pl.sent || 0, replied = pl.replied || 0, auto = pl.autoReplied || 0;
    const yes = pl.yes || 0, no = pl.saidNo || 0, waiting = pl.waitingOnUs || 0, follow = pl.followUp || 0, won = pl.won || 0;
    const nodes = {
      sent: { n: sent, label: "Contacted", color: "#94a3b8" },
      replied: { n: replied, label: "Replied", color: "#3b82f6" },
      auto: { n: auto, label: "Auto reply", color: "#64748b" },
      silent: { n: Math.max(0, sent - replied - auto), label: "No reply yet", color: "#475569" },
      yes: { n: yes, label: "Said yes", color: "#34d399" },
      waiting: { n: waiting, label: "Waiting on us", color: "#fb923c" },
      no: { n: no, label: "Said no", color: "#f87171" },
      follow: { n: follow, label: "Followed up", color: "#38bdf8" },
      won: { n: won, label: "Won", color: "#facc15" }
    };
    const links = [["sent", "replied"], ["sent", "auto"], ["sent", "silent"], ["replied", "yes"], ["replied", "waiting"], ["replied", "no"], ["yes", "follow"], ["follow", "won"]];
    const cols = [["sent"], ["replied", "auto", "silent"], ["yes", "waiting", "no"], ["follow"], ["won"]].map((ids) => ids.filter((id) => id === "sent" || nodes[id].n > 0)).filter((ids) => ids.length);
    const scale = (H2 - SLOT * 2 - GAP * 2) / Math.max(1, sent);
    const step = cols.length > 1 ? Math.min((W2 - NODE - LABEL - 40) / (cols.length - 1), 420) : 0;
    const ox = Math.max(0, Math.round((W2 - ((cols.length - 1) * step + NODE + LABEL)) / 2));
    cols.forEach((ids, c) => {
      let y = 0;
      ids.forEach((id) => {
        const nd = nodes[id];
        nd.x = ox + Math.round(c * step);
        nd.h = Math.max(3, nd.n * scale);
        nd.y = y;
        nd.out = y;
        nd.in = y;
        y += Math.max(nd.h, SLOT) + GAP;
      });
    });
    let paths = "";
    for (const [a, b] of links) {
      const A = nodes[a], B = nodes[b], v = B.n * scale;
      if (!B.n) continue;
      const x0 = A.x + NODE, x1 = B.x, ya = A.out, yb = B.in, mx = (x0 + x1) / 2;
      paths += `<path d="M${x0},${ya} C${mx},${ya} ${mx},${yb} ${x1},${yb} L${x1},${yb + v} C${mx},${yb + v} ${mx},${ya + v} ${x0},${ya + v} Z" fill="${B.color}" fill-opacity="0.3"/>`;
      A.out += v;
      B.in += v;
    }
    let text = "";
    for (const id in nodes) {
      if (nodes[id].x == null) continue;
      const nd = nodes[id], parent = links.filter((l) => l[1] === id)[0];
      paths += `<rect x="${nd.x}" y="${nd.y}" width="${NODE}" height="${nd.h}" rx="2" fill="${nd.color}" fill-opacity="${nd.n ? 1 : 0.35}"/>`;
      const pct = parent && nodes[parent[0]].n ? `<i style="color:${nd.color}">${Math.round(nd.n / nodes[parent[0]].n * 100)}%</i>` : "";
      const top = Math.round(nd.h < SLOT ? nd.y : Math.min(H2 - SLOT, nd.y + nd.h / 2 - 16));
      text += `<div class="sk${nd.n ? "" : " none"}" style="left:${nd.x + NODE + 8}px;top:${top}px"><b>${num(nd.n)}</b>${pct}<span>${nd.label}</span></div>`;
    }
    box.innerHTML = `<svg width="${W2}" height="${H2}" viewBox="0 0 ${W2} ${H2}">${paths}</svg><div class="sk-labels">${text}</div>`;
    $("replies").innerHTML = pl.replies.length ? pl.replies.slice(0, 2).map((r) => `<div class="rp${r.auto ? " auto" : ""}"><b>${esc(r.name)}</b>${r.kind === "yes" ? '<i class="hot">said yes</i>' : r.kind === "no" ? '<i class="no">said no</i>' : r.kind === "question" ? "<i>waiting on us</i>" : ""}${r.auto ? "<i>automatic reply</i>" : ""}<span>${esc(r.said)}</span></div>`).join("") : `<div class="rp none">No replies yet from the ${num(pl.sent)} businesses contacted.</div>`;
  }
  function compact(n) {
    if (n == null) return "\u2014";
    if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e4) return Math.round(n / 1e3) + "k";
    return num(n);
  }
  const linkList = (() => {
    const box = $("il-list");
    let html = "";
    const head = '<div class="link-row head"><span class="link-name">Page</span><span>Opens</span><span>Clicks</span></div>';
    box.innerHTML = head + '<div class="link-scroll"><div class="link-track"></div></div>';
    const track = box.querySelector(".link-track");
    return {
      set(rows, note2) {
        const next = rows + (note2 ? `<div class="empty" style="font-size:14px">${esc(note2)}</div>` : "");
        if (next !== html) {
          html = next;
          track.innerHTML = next;
        }
      }
    };
  })();
  let logKey = "";
  const SOURCE_NAMES = { flowdesk: "FlowDesk", leads: "Leads", innolink: "Innolink", sites: "Sites", board: "Board", meta: "Meta", tokens: "Usage", voice: "You", jarvis: "Jarvis", test: "Test" };
  function renderLog() {
    const server = ((S == null ? void 0 : S.events) || []).map((e) => __spreadProps(__spreadValues({}, e), { t: Date.parse(e.at) }));
    const all = [...server, ...localLog].sort((x, y) => y.t - x.t).slice(0, 18);
    const key = all.map((e) => {
      var _a;
      return (_a = e.id) != null ? _a : e.t;
    }).join(",");
    if (key === logKey) return;
    logKey = key;
    const fresh = Date.now() - 15e3;
    $("log").innerHTML = all.map((e) => {
      const cls = e.level === "jarvis" ? "jarvis" : e.level;
      const time = new Date(e.t).toLocaleTimeString("en-GB", { hour12: false });
      return `<li class="${cls}${e.level === "error" && e.t > fresh ? " fresh" : ""}"><time>${time.slice(0, 5)}</time><b class="src src-${esc(e.source || "jarvis")}">${esc(SOURCE_NAMES[e.source] || e.source || "jarvis")}</b><span>${esc(e.text)}</span></li>`;
    }).join("");
  }
  function note(text) {
    localLog.push({ level: "jarvis", text, t: Date.now() });
    if (localLog.length > 40) localLog.shift();
    renderLog();
  }
  const rotator = { current: () => null, next() {
  }, previous() {
  }, show() {
  }, sync() {
  }, pause() {
  }, resume() {
  } };
  let touring = null;
  function tour() {
    clearTimeout(touring);
    const keys = ["ach", "lead", "pipe", "team", "todo", "link", "meta", "log"].filter((k) => panels[k]);
    let i = 0;
    const next = () => {
      if (i >= keys.length) {
        unzoom();
        touring = null;
        return;
      }
      zoom(keys[i++], 8);
      touring = setTimeout(next, 6e3);
    };
    next();
  }
  let waTimer = null, waLoading = false;
  function waFrame() {
    const wa = S && S.whatsapp;
    if (!wa || !wa.ready || waLoading) return;
    waLoading = true;
    const img = new Image();
    img.onload = () => {
      waLoading = false;
      $("wa-screen").src = img.src;
      $("wa-screen").style.display = "block";
      $("wa-msgs").style.display = "none";
    };
    img.onerror = () => {
      waLoading = false;
    };
    img.src = "/api/whatsapp/screen?t=" + Date.now();
  }
  function showWhatsApp(on) {
    const el = $("wa-view");
    el.className = on ? "wa-view show" : "wa-view";
    $("wa-layer").className = on ? "on" : "";
    clearInterval(waTimer);
    if (!on) {
      $("dim").classList.remove("on");
      return;
    }
    unzoom();
    $("dim").classList.add("on");
    waTimer = setInterval(waFrame, 350);
    waFrame();
    const wa = S && S.whatsapp;
    $("wa-chat").textContent = wa && wa.chat ? wa.chat : wa && wa.qr ? "scan to link" : "starting";
    $("wa-msgs").innerHTML = wa && wa.ready && wa.messages && wa.messages.length ? wa.messages.slice(-12).map((m) => `<div class="wa-m${m.mine ? " mine" : ""}"><b>${esc(m.from)}</b>${esc(m.text)}<i>${esc(m.time || "")}</i></div>`).join("") : wa && wa.qr ? `<div class="wa-qr"><img src="${wa.qr}" alt=""><div>On the phone: WhatsApp, Settings, <b>Linked devices</b>, <b>Link a device</b>, then scan this code.</div></div>` : wa && wa.ready ? `<div class="wa-empty">${esc(wa.detail || "Linked. Waiting for the group chat.")}</div>` : '<div class="wa-empty">WhatsApp is starting on the Jarvis computer.</div>';
  }
  function report(msg) {
    try {
      const x = new XMLHttpRequest();
      x.open("POST", "/api/client-log");
      x.setRequestHeader("Content-Type", "application/json");
      x.send(JSON.stringify({ msg: msg + " | " + navigator.userAgent.slice(-60) }));
    } catch (err) {
    }
  }
  const fx = (() => {
    const canvas = $("fx");
    const ctx = canvas.getContext("2d");
    const parts = [];
    const COLORS = ["#3b82f6", "#8b5cf6", "#38bdf8", "#f1f5f9", "#34d399", "#fb923c"];
    let running = false;
    function resize() {
      canvas.width = stacked ? stage.offsetWidth : SW;
      canvas.height = stacked ? stage.offsetHeight : H;
      canvas.style.width = canvas.width + "px";
      canvas.style.height = canvas.height + "px";
    }
    function confetti(x, y, n = 160, spread = 1) {
      for (let i = 0; i < n; i++) {
        const a = rand(-Math.PI, 0), v = rand(6, 17) * spread;
        parts.push({ kind: "c", x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 4, w: rand(7, 14), h: rand(4, 8), r: rand(0, 6), vr: rand(-0.3, 0.3), c: pick(COLORS), life: rand(160, 260) });
      }
      start();
    }
    function rain(n = 220) {
      for (let i = 0; i < n; i++) parts.push({ kind: "c", x: rand(0, canvas.width), y: rand(-400, -10), vx: rand(-2, 2), vy: rand(2, 6), w: rand(7, 14), h: rand(4, 8), r: rand(0, 6), vr: rand(-0.2, 0.2), c: pick(COLORS), life: 420 });
      start();
    }
    function rocket(x) {
      parts.push({ kind: "r", x, y: canvas.height + 10, vx: rand(-1.5, 1.5), vy: rand(-19, -14), c: pick(COLORS), life: 200 });
      start();
    }
    function burst(x, y, c) {
      const n = 90;
      for (let i = 0; i < n; i++) {
        const a = i / n * Math.PI * 2, v = rand(3, 9);
        parts.push({ kind: "s", x, y, px: x, py: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, c: Math.random() < 0.25 ? "#ffffff" : c, life: rand(60, 100), max: 100 });
      }
      sound.pop();
    }
    function fireworks(seconds = 6) {
      const end = performance.now() + seconds * 1e3;
      const launch = () => {
        if (performance.now() > end) return;
        rocket(rand(canvas.width * 0.1, canvas.width * 0.9));
        setTimeout(launch, rand(250, 600));
      };
      launch();
    }
    function start() {
      if (!running) {
        running = true;
        requestAnimationFrame(frame);
      }
    }
    function frame() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        p.life--;
        if (p.kind === "c") {
          p.vx *= 0.985;
          p.vy = p.vy * 0.985 + 0.32;
          p.x += p.vx + Math.sin(p.life / 9) * 0.6;
          p.y += p.vy;
          p.r += p.vr;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.r);
          ctx.fillStyle = p.c;
          ctx.globalAlpha = Math.min(1, p.life / 40);
          ctx.fillRect(-p.w / 2, -p.h / 2 * Math.abs(Math.cos(p.life / 6)), p.w, p.h * Math.abs(Math.cos(p.life / 6)) + 1);
          ctx.restore();
        } else if (p.kind === "r") {
          p.x += p.vx;
          p.y += p.vy;
          p.vy += 0.22;
          ctx.fillStyle = p.c;
          ctx.globalAlpha = 1;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 3, 0, 7);
          ctx.fill();
          ctx.globalAlpha = 0.4;
          ctx.fillRect(p.x - 1, p.y, 2, 22);
          if (p.vy >= -1.5) {
            burst(p.x, p.y, p.c);
            p.life = 0;
          }
        } else {
          p.px = p.x;
          p.py = p.y;
          p.vx *= 0.96;
          p.vy = p.vy * 0.96 + 0.08;
          p.x += p.vx;
          p.y += p.vy;
          ctx.strokeStyle = p.c;
          ctx.globalAlpha = Math.max(0, p.life / p.max);
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.moveTo(p.px - p.vx * 2, p.py - p.vy * 2);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
        }
        if (p.life <= 0 || p.y > canvas.height + 60) parts.splice(i, 1);
      }
      ctx.globalAlpha = 1;
      if (parts.length) requestAnimationFrame(frame);
      else {
        running = false;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
    return { resize, confetti, rain, fireworks };
  })();
  const sound = /* @__PURE__ */ (() => {
    let ac = null;
    const ok = () => ac && ac.state !== "suspended" && ac.state !== "closed";
    function arm() {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!ac && Ctx) ac = new Ctx();
        if (ac && ac.resume && ac.state === "suspended") ac.resume().catch(() => {
        });
      } catch (err) {
      }
    }
    function tone(freq, t0, dur, type = "sine", vol = 0.18) {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(vol, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(1e-4, t0 + dur);
      o.connect(g).connect(ac.destination);
      o.start(t0);
      o.stop(t0 + dur + 0.05);
    }
    return {
      arm,
      chime() {
        if (!ok()) return;
        const t = ac.currentTime;
        [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => tone(f, t + i * 0.11, 0.6, "triangle", 0.16));
      },
      pop() {
        if (!ok()) return;
        const t = ac.currentTime, len = 0.25;
        const buf = ac.createBuffer(1, ac.sampleRate * len, ac.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3);
        const src = ac.createBufferSource(), g = ac.createGain();
        g.gain.value = 0.12;
        src.buffer = buf;
        src.connect(g).connect(ac.destination);
        src.start(t);
      },
      siren(seconds = 8) {
        if (!ok()) return;
        const t = ac.currentTime;
        const o = ac.createOscillator(), g = ac.createGain(), lfo = ac.createOscillator(), depth = ac.createGain();
        o.type = "sawtooth";
        o.frequency.value = 760;
        lfo.type = "square";
        lfo.frequency.value = 1.6;
        depth.gain.value = 220;
        lfo.connect(depth).connect(o.frequency);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.16, t + 0.05);
        g.gain.setValueAtTime(0.16, t + seconds - 0.3);
        g.gain.linearRampToValueAtTime(0, t + seconds);
        o.connect(g).connect(ac.destination);
        o.start(t);
        lfo.start(t);
        o.stop(t + seconds);
        lfo.stop(t + seconds);
      }
    };
  })();
  function keepIn(x, y) {
    return { x: Math.max(80, Math.min(SW - 80, x)), y: Math.max(88, Math.min(H - 88, y)) };
  }
  const spider = (() => {
    const el = $("spider");
    const ARMS = 8;
    const armEls = (cls) => {
      let h = "";
      for (let i = 0; i < ARMS; i++) {
        if (i % 2 === 1 !== (cls === "back")) continue;
        h += `<path class="arm-under" data-i="${i}" fill="${cls === "back" ? "#efd795" : "#fff0bf"}"/><path class="arm-top" data-i="${i}" fill="url(#${cls === "back" ? "octoArmBack" : "octoArm"})"/>`;
      }
      return h;
    };
    let svg = '<svg viewBox="-90 -92 180 184">';
    svg += '<defs><radialGradient id="octoBody" cx="0.38" cy="0.3" r="0.85"><stop offset="0" stop-color="#ffe27a"/><stop offset="0.45" stop-color="#fcc419"/><stop offset="1" stop-color="#e9a000"/></radialGradient><linearGradient id="octoArm" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fcc419"/><stop offset="1" stop-color="#f2b000"/></linearGradient><linearGradient id="octoArmBack" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e5a400"/><stop offset="1" stop-color="#d49400"/></linearGradient></defs>';
    svg += '<g class="arms-back">' + armEls("back") + "</g>";
    svg += '<path class="octo-body" fill="url(#octoBody)" d="M-25,12 C-29,-6 -36,-28 -35,-50 C-33,-75 -17,-86 0,-86 C17,-86 33,-75 35,-50 C36,-28 29,-6 25,12 Z"/><path d="M-33,-36 Q0,-25 33,-36" fill="none" stroke="#b97f00" stroke-opacity="0.35" stroke-width="1.4"/><ellipse cx="-13" cy="-63" rx="9" ry="14" fill="#fff" fill-opacity="0.12" transform="rotate(-16 -13 -63)"/>';
    svg += '<g class="arms-front">' + armEls("front") + "</g>";
    svg += '<g class="eyes"><circle cx="-16" cy="-14" r="6.2" fill="#fff" stroke="#d6d3d1" stroke-width="0.9"/><circle cx="16" cy="-14" r="6.2" fill="#fff" stroke="#d6d3d1" stroke-width="0.9"/><circle class="pupil" cx="-16" cy="-14" r="3.7" fill="#111"/><circle class="pupil" cx="16" cy="-14" r="3.7" fill="#111"/><circle class="glint" cx="-17.2" cy="-15.4" r="1.1" fill="#fff"/><circle class="glint" cx="14.8" cy="-15.4" r="1.1" fill="#fff"/></g>';
    svg += "</svg>";
    el.innerHTML = svg;
    const unders = [], tops = [];
    [].forEach.call(el.querySelectorAll(".arm-under"), (p) => {
      unders[+p.getAttribute("data-i")] = p;
    });
    [].forEach.call(el.querySelectorAll(".arm-top"), (p) => {
      tops[+p.getAttribute("data-i")] = p;
    });
    const pupils = el.querySelectorAll(".pupil"), glints = el.querySelectorAll(".glint");
    const s = { x: 960, y: -90, vx: 0, vy: 0, hop: 0, spin: 0, shake: 0, phase: 0, moving: false, target: null, happy: 0 };
    let last = performance.now(), lastDraw = 0;
    const N = 9, f = (v) => v.toFixed(1);
    function armShapes(i, trailX, trailY) {
      const off = (i - 3.5) / 3.5, side = off < 0 ? -1 : 1, back = i % 2 === 1;
      const L = back ? 58 : 68, W2 = back ? 8.6 : 10.2, seg = L / N;
      const deg = Math.PI / 180;
      const pts = [];
      let x = off * 21, y = 2;
      for (let j = 0; j <= N; j++) {
        const a = j / N;
        const theta = (90 - off * 30 - side * 125 * a * a * a + Math.sin(s.phase * 1.6 + i * 0.9 + a * 3) * 13 * a) * deg;
        pts.push([x + trailX * L * a * a, y + trailY * L * a * a]);
        x += Math.cos(theta) * seg;
        y += Math.sin(theta) * seg;
      }
      const c = -side;
      const edge = (k) => pts.map((p, j) => {
        const q = pts[Math.min(N, j + 1)], r = pts[Math.max(0, j - 1)];
        let tx = q[0] - r[0], ty = q[1] - r[1];
        const len = Math.sqrt(tx * tx + ty * ty) || 1;
        tx /= len;
        ty /= len;
        const w = W2 * (1 - 0.62 * (j / N)) * k;
        return [p[0] - ty * w * c, p[1] + tx * w * c, tx, ty];
      });
      const shape = (kOut, kIn) => {
        const A = edge(-kOut), B = edge(kIn), tip = pts[N], tA = A[N];
        const w = W2 * 0.38;
        let d = `M${f(A[0][0])},${f(A[0][1])}`;
        for (let j = 1; j <= N; j++) d += `L${f(A[j][0])},${f(A[j][1])}`;
        d += `Q${f(tip[0] + tA[2] * w * 1.7)},${f(tip[1] + tA[3] * w * 1.7)} ${f(B[N][0])},${f(B[N][1])}`;
        for (let j = N - 1; j >= 0; j--) d += `L${f(B[j][0])},${f(B[j][1])}`;
        return d + "Z";
      };
      return [shape(1, 1.1), shape(1.02, 0.5)];
    }
    function frame(t) {
      requestAnimationFrame(frame);
      const dt = Math.min(0.05, (t - last) / 1e3);
      last = t;
      let vx = 0, vy = 0;
      if (s.target) {
        const dx = s.target.x - s.x, dy = s.target.y - s.y, dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 3 || s.target.abort && s.target.abort()) {
          const done = s.target.done;
          s.target = null;
          s.moving = false;
          done();
        } else {
          const surge = 0.65 + 0.55 * Math.max(0, Math.sin(s.phase * 1.1));
          const step = Math.min(dist, s.target.speed * surge * dt);
          vx = dx / dist * step / dt;
          vy = dy / dist * step / dt;
          s.x += dx / dist * step;
          s.y += dy / dist * step;
          s.moving = true;
        }
      }
      s.vx += (vx - s.vx) * Math.min(1, dt * 4);
      s.vy += (vy - s.vy) * Math.min(1, dt * 4);
      s.phase += dt * (s.moving ? 5.5 : 2.2) * (s.happy > 0 ? 2.2 : 1) * (s.frantic ? 3 : 1);
      if (s.happy > 0) s.happy -= dt;
      if (t - lastDraw < 32) return;
      lastDraw = t;
      const sp = Math.sqrt(s.vx * s.vx + s.vy * s.vy) || 1;
      const trailX = s.moving ? -s.vx / sp * 0.45 : 0, trailY = s.moving ? -s.vy / sp * 0.35 : 0;
      for (let i = 0; i < ARMS; i++) {
        const d = armShapes(i, trailX, trailY);
        unders[i].setAttribute("d", d[0]);
        tops[i].setAttribute("d", d[1]);
      }
      let lx = s.moving ? s.vx / sp * 2.6 : Math.sin(t / 1400) * 1.5, ly = s.moving ? s.vy / sp * 2 : 0;
      if (s.frantic) {
        lx += rand(-2.2, 2.2);
        ly += rand(-2.2, 2.2);
      }
      pupils[0].setAttribute("cx", -16 + lx);
      pupils[0].setAttribute("cy", -14 + ly);
      pupils[1].setAttribute("cx", 16 + lx);
      pupils[1].setAttribute("cy", -14 + ly);
      glints[0].setAttribute("cx", -17.2 + lx);
      glints[1].setAttribute("cx", 14.8 + lx);
      const pulse = Math.sin(s.phase * 1.1);
      const sx = 1 + (s.moving ? 0.1 : 0.04) * pulse, sy = 1 - (s.moving ? 0.09 : 0.035) * pulse;
      const tilt = s.frantic ? Math.max(-45, Math.min(45, s.vx * 0.03)) : Math.max(-16, Math.min(16, s.vx * 0.05));
      const jx = s.shake ? rand(-s.shake, s.shake) : 0, jy = s.shake ? rand(-s.shake, s.shake) : 0;
      const at = keepIn(s.x + jx, s.y - s.hop + jy);
      const tr = `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px) rotate(${(tilt + s.spin).toFixed(1)}deg) scale(${(sx * (1 + s.hop / 220)).toFixed(3)}, ${(sy * (1 + s.hop / 220)).toFixed(3)})`;
      el.style.webkitTransform = tr;
      el.style.transform = tr;
    }
    requestAnimationFrame(frame);
    return {
      state: s,
      el,
      walkTo(x, y, speed = 220, abort) {
        const p = keepIn(x, y);
        return new Promise((done) => {
          s.target = { x: p.x, y: p.y, speed, abort, done };
        });
      },
      face() {
      },
      // One big backflip: up, a full turn backwards, and a squishy landing.
      flip() {
        s.happy = 2;
        const t0 = performance.now(), dur = 1100;
        return new Promise((r) => {
          const step = (t) => {
            const k = Math.min(1, (t - t0) / dur);
            const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
            s.hop = Math.sin(k * Math.PI) * 110;
            s.spin = -360 * e;
            if (k < 1) requestAnimationFrame(step);
            else {
              s.hop = 0;
              s.spin = 0;
              r();
            }
          };
          requestAnimationFrame(step);
        });
      },
      hop(times = 3, spin = true) {
        return __async(this, null, function* () {
          s.happy = times * 0.6 + 0.5;
          for (let n = 0; n < times; n++) {
            const t0 = performance.now(), dur = 560;
            yield new Promise((r) => {
              const step = (t) => {
                const k = Math.min(1, (t - t0) / dur);
                s.hop = Math.sin(k * Math.PI) * 60;
                if (spin) s.spin = Math.sin(k * Math.PI * 2) * 14;
                if (k < 1) requestAnimationFrame(step);
                else {
                  s.hop = 0;
                  s.spin = 0;
                  r();
                }
              };
              requestAnimationFrame(step);
            });
          }
        });
      }
    };
  })();
  function spotOn(key, centre = false) {
    const p = panels[key];
    return { x: p.offsetLeft + p.offsetWidth * (centre ? 0.5 : rand(0.22, 0.78)), y: p.offsetTop + 8 };
  }
  const queue = [];
  const interrupted = () => queue.length > 0;
  function patrol(lastKey) {
    return __async(this, null, function* () {
      if (zoomed) {
        yield spider.walkTo(SW / 2, 96, 300, interrupted);
        spider.face(180);
        yield sleep(500);
        return lastKey;
      }
      const keys = Object.keys(panels).filter((k) => k !== lastKey);
      const key = pick(keys);
      const pt = spotOn(key);
      yield spider.walkTo(pt.x, pt.y, rand(220, 320), interrupted);
      if (interrupted()) return key;
      spider.face(180);
      yield sleep(500);
      const panel = panels[key];
      panel.classList.add("scanning");
      const t0 = performance.now(), total = rand(3500, 5500);
      while (performance.now() - t0 < total && !interrupted()) yield sleep(200);
      panel.classList.remove("scanning");
      if (!interrupted() && ["ach", "lead", "link", "team"].includes(key) && Math.random() < 0.18) {
        const r = spider.state;
        fx.confetti(r.x, r.y, 40, 0.6);
        yield spider.hop(1);
      }
      return key;
    });
  }
  function insight(key) {
    var _a, _b, _c, _d, _e, _f;
    if (!S) return "";
    const a = ((_a = S.board) == null ? void 0 : _a.achievements) || {};
    const days = ((_b = S.board) == null ? void 0 : _b.countdown) ? Math.max(0, Math.ceil((new Date(S.board.countdown.target) - Date.now()) / 864e5)) : null;
    switch (key) {
      case "ach":
        return `${eur(a.revenue)} of ${eur(a.revenueGoal)}, ${S.flowdesk && S.flowdesk.todo ? S.flowdesk.todo.open.length + " to do" : ""}`;
      case "pipe": {
        const pl = S.leads && S.leads.pipeline;
        return pl ? `${pl.sent} contacted, ${pl.replied} replied, ${pl.won} won` : "";
      }
      case "meta": {
        const t = (S.tokens || []).filter((x) => x.used != null);
        return t.length ? t.map((x) => `${x.account} ${Math.round(x.used)}%`).join(", ") : "Claude usage";
      }
      case "team":
        return ((_c = S.flowdesk) == null ? void 0 : _c.ok) ? `${S.flowdesk.doneToday} done today, ${S.flowdesk.doneWeek} this week, ${S.flowdesk.inProgress} in progress` : "FlowDesk not connected";
      case "lead":
        return ((_d = S.leads) == null ? void 0 : _d.ok) ? `${num(S.leads.whatsappToday)} WhatsApps, ${num(S.leads.emailsToday)} emails, ${num(S.leads.leadsToday)} new leads today` : "";
      case "link":
        return ((_e = S.innolink) == null ? void 0 : _e.ok) ? `${num(S.innolink.views)} opens, ${num(S.innolink.clicks)} clicks on ${S.innolink.clients.length} pages` : `${(((_f = S.board) == null ? void 0 : _f.innolinkClients) || []).length} Innolink pages`;
      case "log": {
        const errs = (S.events || []).filter((e) => e.level === "error" && Date.now() - Date.parse(e.at) < 864e5).length;
        return errs ? `${errs} alert${errs > 1 ? "s" : ""} in the last 24 hours` : "No alerts in the last 24 hours";
      }
    }
    return "";
  }
  const banner = $("banner");
  function showBanner(title, text, danger, ms) {
    banner.className = danger ? "danger" : "";
    banner.innerHTML = `<div class="b-title">${esc(title)}</div><div class="b-text">${esc(text)}</div>`;
    requestAnimationFrame(() => banner.classList.add("show"));
    setTimeout(() => banner.classList.remove("show"), ms);
  }
  function backflip() {
    spider.flip().then(() => {
      const r = spider.state;
      fx.confetti(r.x, r.y, 70, 0.7);
    });
  }
  function celebrate(e) {
    return __async(this, null, function* () {
      unzoom();
      const key = panels[e.panel] ? e.panel : "ach";
      const panel = panels[key];
      const pt = spotOn(key, true);
      yield spider.walkTo(pt.x, pt.y, 760);
      spider.face(180);
      panel.classList.add("party");
      sound.chime();
      if (e.big) {
        showBanner(e.title || "ACHIEVEMENT", e.text, false, 7e3);
        fx.confetti(pt.x, pt.y, 260, 1.2);
        fx.rain(240);
        fx.fireworks(6);
        yield spider.hop(4);
        fx.confetti(pt.x, pt.y, 160, 1);
        yield spider.hop(3);
      } else {
        fx.confetti(pt.x, pt.y, 90, 0.8);
        yield spider.hop(2);
      }
      setTimeout(() => panel.classList.remove("party"), e.big ? 4e3 : 1500);
    });
  }
  const alarmEl = $("alarm");
  function alarm(e) {
    return __async(this, null, function* () {
      unzoom();
      const key = panels[e.panel] ? e.panel : "log";
      const panel = panels[key];
      spider.el.classList.add("angry");
      alarmEl.classList.add("on");
      panel.classList.add("danger");
      sound.siren(8);
      showBanner("ALERT", e.text, true, 9e3);
      const st = spider.state;
      st.shake = 10;
      st.frantic = true;
      const corners = [[70, 70], [SW - 70, 70], [70, H - 70], [SW - 70, H - 70]];
      const until = performance.now() + 8e3;
      for (let n = 0; performance.now() < until; n++) {
        const pt2 = n % 3 === 0 ? corners[Math.floor(Math.random() * 4)] : [rand(60, SW - 60), rand(60, H - 60)];
        st.spin = rand(-40, 40);
        yield spider.walkTo(pt2[0], pt2[1], rand(2200, 3600));
        if (n % 5 === 4) yield spider.flip();
      }
      st.frantic = false;
      st.spin = 0;
      const pt = spotOn(key, true);
      st.shake = 4;
      yield spider.walkTo(pt.x, pt.y, 1400);
      yield sleep(1500);
      st.shake = 0;
      alarmEl.classList.remove("on");
      spider.el.classList.remove("angry");
      setTimeout(() => panel.classList.remove("danger"), 2e4);
    });
  }
  function show() {
    return __async(this, null, function* () {
      let lastKey = null;
      yield spider.walkTo(SW / 2, 140, 300);
      for (; ; ) {
        if (queue.length) {
          const i = queue.findIndex((e2) => e2.level === "error");
          const e = queue.splice(i >= 0 ? i : 0, 1)[0];
          try {
            yield e.level === "error" ? alarm(e) : celebrate(e);
          } catch (err) {
            console.error(err);
          }
          continue;
        }
        try {
          lastKey = yield patrol(lastKey);
        } catch (err) {
          console.error(err);
          yield sleep(1e3);
        }
      }
    });
  }
  let zoomed = null, zoomTimer = null;
  function setTransform(el, t) {
    el.style.webkitTransform = t;
    el.style.transform = t;
  }
  function zoom(key, seconds) {
    const p = panels[key];
    if (!p || stacked) return;
    if (zoomed && zoomed !== key) unzoom();
    const tx = 20, ty = 108, tw = SW - 40, th = H - 128;
    const k = Math.min(tw / p.offsetWidth, th / p.offsetHeight);
    setTransform(p, `translate(${Math.round(tx + tw / 2 - (p.offsetLeft + p.offsetWidth / 2))}px, ${Math.round(ty + th / 2 - (p.offsetTop + p.offsetHeight / 2))}px) scale(${k.toFixed(3)})`);
    p.classList.add("zoomed");
    $("dim").classList.add("on");
    zoomed = key;
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(unzoom, (seconds || 120) * 1e3);
  }
  function unzoom() {
    if (!zoomed) return;
    const p = panels[zoomed];
    setTransform(p, "");
    $("dim").classList.remove("on");
    setTimeout(() => p.classList.remove("zoomed"), 600);
    zoomed = null;
    clearTimeout(zoomTimer);
  }
  let lastCommand = null, muted = false, sayTimer = null;
  function showSay(heard, reply) {
    $("say-heard").textContent = heard ? `"${heard}"` : "";
    $("say-reply").textContent = reply || "";
    $("say").className = "show";
    clearTimeout(sayTimer);
    sayTimer = setTimeout(() => {
      $("say").className = "";
    }, Math.max(6e3, (reply || "").split(" ").length * 420));
  }
  function speak(c, onStart) {
    if (muted || !(c.reply || c.streaming) || !(S && S.board && S.board.tvSpeaks)) {
      if (c.reply || c.streaming) tvReport("answer " + c.id + " not spoken: " + (muted ? "muted" : !(S && S.board) ? "no data yet" : "TV speech is off"));
      return false;
    }
    const fallback = () => {
      if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) return;
      const u = new SpeechSynthesisUtterance(c.reply);
      u.lang = "en-GB";
      window.speechSynthesis.speak(u);
    };
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      clearTimeout(guard);
      clearTimeout(sayTimer);
      if (onStart) onStart();
    };
    const release = () => {
      clearTimeout(sayTimer);
      sayTimer = setTimeout(() => {
        $("say").className = "";
      }, 2500);
    };
    const guard = setTimeout(start, 15e3);
    const fail = () => {
      start();
      fallback();
    };
    const est = 6e3 + String(c.reply || "").split(" ").length * 600 + (c.streaming ? 2e4 : 0);
    try {
      play("/api/tts/" + c.id + "?sig=" + (c.sig || "") + (IS_TV ? "&full=1" : ""), fail, start, release, est);
    } catch (err) {
      fail();
    }
    return true;
  }
  const player = new Audio();
  const IS_TV = /Tizen|SMART-TV|Web0S|NetCast/i.test(navigator.userAgent);
  let soundOn = false, current = null;
  const sounds = [];
  const SILENCE = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
  function tvReport(msg) {
    try {
      const x = new XMLHttpRequest();
      x.open("POST", "/api/client-log");
      x.withCredentials = true;
      x.setRequestHeader("Content-Type", "application/json");
      x.send(JSON.stringify({ msg: (IS_TV ? "tv" : "screen " + innerWidth + "x" + innerHeight) + ": " + msg }));
    } catch (err) {
    }
  }
  function unlockSound() {
    if (soundOn) return;
    try {
      if (!current) player.src = SILENCE;
      const p = player.play();
      const ok = () => {
        if (!soundOn) tvReport("voice turned on");
        soundOn = true;
        fsCheck();
        if (!current) nextSound();
      };
      if (p && p.then) p.then(ok, (e) => {
        if (e && e.name === "AbortError") ok();
        else tvReport("voice still blocked: " + (e && e.name));
      });
      else ok();
    } catch (err) {
    }
  }
  function play(src, fallback, onStart, onEnd, est) {
    sounds.push({ src, fallback, onStart, onEnd, tries: 0, est: est || 15e3 });
    if (!current) nextSound();
  }
  function nextSound() {
    const sd = current = sounds.shift() || null;
    if (!sd) return;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(watch);
      current = null;
      nextSound();
    };
    const began = Date.now();
    let lastT = -1, still = 0;
    const watch = setInterval(() => {
      const d = player.duration, t = player.currentTime;
      still = t > 0.2 && Math.abs(t - lastT) < 0.01 ? still + 1 : 0;
      lastT = t;
      const over = isFinite(d) && d > 0 && t >= d - 0.15 || still >= 3;
      if (over || Date.now() - began > sd.est + (isFinite(d) ? d * 1e3 : 0)) {
        if (!over) tvReport("voice timer freed the player for " + sd.src + " (at " + t.toFixed(1) + "s of " + d + ", paused " + player.paused + ", ready " + player.readyState + ")");
        if (sd.onStart) {
          const f = sd.onStart;
          sd.onStart = null;
          f();
        }
        if (sd.onEnd) sd.onEnd();
        finish();
      }
    }, 500);
    const giveUp = (why) => {
      if (done) return;
      tvReport("voice failed (" + why + ") for " + sd.src);
      if (sd.fallback) sd.fallback();
      if (sd.onEnd) sd.onEnd();
      finish();
    };
    const fail = (why) => {
      if (done) return;
      if (sd.tries++ >= 1) return giveUp(why);
      setTimeout(() => {
        if (done) return;
        player.src = sd.src + (sd.src.indexOf("?") < 0 ? "?" : "&") + "again=1";
        const p2 = player.play();
        if (p2 && p2.catch) p2.catch((e) => giveUp(e && e.name));
      }, 1200);
    };
    player.onplaying = () => {
      soundOn = true;
      if (sd.onStart) {
        const f = sd.onStart;
        sd.onStart = null;
        f();
      }
    };
    player.onended = () => {
      if (sd.onEnd) sd.onEnd();
      finish();
    };
    player.onerror = () => fail("error " + (player.error && player.error.code));
    player.src = sd.src;
    const p = player.play();
    if (reports++ < 12) tvReport("playing " + sd.src.replace(/^.*\/api\/tts\//, "").replace(/sig=[a-f0-9]+&?/, "") + ", voice " + (soundOn ? "on" : "not turned on yet"));
    if (p && p.catch) p.catch((e) => {
      if (e && e.name === "NotAllowedError") {
        soundOn = false;
        fsCheck();
      }
      fail(e && e.name);
    });
  }
  let reports = 0;
  setTimeout(() => tvReport("page loaded on " + location.host + ", voice " + (soundOn ? "on" : "waiting for OK")), 3e3);
  function runCommand(c) {
    if (c.action === "announce") {
      const go2 = () => {
        showSay("", c.reply);
        if (c.panel) zoom(c.panel, 20);
      };
      if (!speak(c, go2)) go2();
      return;
    }
    if (c.action === "thinking") {
      if (c.filler && !muted && S && S.board && S.board.tvSpeaks) {
        try {
          play("/api/tts/" + c.filler + "?sig=" + (c.fillerSig || ""), null, null, null, 3500);
        } catch (err) {
        }
      }
      showSay(c.heard, "Thinking");
      $("say").className = "show thinking";
      return;
    }
    if (c.action === "unmute") muted = false;
    const go = () => {
      showSay(c.heard, c.reply || "\u2026");
      if (c.streaming) liveCommand = c.id;
      act(c);
    };
    if (speak(c, go)) {
      showSay(c.heard, "Thinking");
      $("say").className = "show thinking";
    } else go();
  }
  function act(c) {
    switch (c.action) {
      case "zoom":
        zoom(c.panel);
        break;
      case "focus":
        zoom(c.panel, 30);
        break;
      case "unzoom":
        unzoom();
        showWhatsApp(false);
        break;
      case "whatsapp":
        showWhatsApp(true);
        break;
      case "tour":
        tour();
        break;
      case "reload":
        setTimeout(() => location.reload(), 3e3);
        break;
      case "next":
        rotator.next();
        break;
      case "previous":
        rotator.previous();
        break;
      case "show_site":
        rotator.show(c.site);
        zoom("site", 60);
        break;
      case "backflip":
        backflip();
        break;
      case "celebrate":
        queue.push({ level: "win", panel: "ach", big: true, title: "INNOWEB", text: c.reply });
        break;
      case "alarm":
        queue.push({ level: "error", panel: "log", text: "Alarm test" });
        break;
      case "mute":
        muted = true;
        break;
    }
  }
  let polling = false, liveCommand = null;
  function pollCommands() {
    return __async(this, null, function* () {
      if (polling) return;
      polling = true;
      try {
        const r = yield getJson("/api/commands" + (lastCommand == null ? "" : "?after=" + lastCommand) + (liveCommand ? (lastCommand == null ? "?" : "&") + "live=" + liveCommand : ""));
        if (r.live && r.live.id === liveCommand) {
          if (r.live.reply) $("say-reply").textContent = r.live.reply;
          if (r.live.done) liveCommand = null;
        }
        if (lastCommand == null) {
          lastCommand = r.last;
          return;
        }
        for (const c of r.commands) {
          lastCommand = Math.max(lastCommand, c.id);
          runCommand(c);
        }
      } catch (err) {
      } finally {
        polling = false;
      }
    });
  }
  let serverDown = false, failures = 0, build = null;
  function getJson(url) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open("GET", url + (url.indexOf("?") < 0 ? "?" : "&") + "t=" + Date.now());
      x.timeout = 15e3;
      x.onload = () => {
        if (x.status === 401) {
          location.href = "/login.html?next=" + encodeURIComponent(location.pathname + location.search);
          return;
        }
        if (x.status !== 200) return reject(new Error(x.status));
        try {
          resolve(JSON.parse(x.responseText));
        } catch (e) {
          reject(e);
        }
      };
      x.onerror = x.ontimeout = () => reject(new Error("network"));
      x.send();
    });
  }
  function poll() {
    return __async(this, null, function* () {
      try {
        S = yield getJson(`/api/state?vw=${window.innerWidth}&vh=${window.innerHeight}&dpr=${window.devicePixelRatio || 1}`);
        if (S.build && build && S.build !== build) {
          location.reload();
          return;
        }
        build = S.build;
        if (serverDown) note("Jarvis server is back");
        serverDown = false;
        failures = 0;
        const evs = S.events || [];
        if (lastEventId == null) lastEventId = evs.length ? evs[evs.length - 1].id : 0;
        for (const e of evs) {
          if (e.id <= lastEventId) continue;
          lastEventId = e.id;
          if (!e.history && (e.level === "win" || e.level === "error")) queue.push(e);
        }
        render();
      } catch (e) {
        failures++;
        if (failures === 3 && !serverDown) {
          serverDown = true;
          queue.push({ level: "error", panel: "log", text: "Jarvis server is not answering" });
          note("Jarvis server is not answering");
        }
      }
    });
  }
  addEventListener("resize", layout);
  layout();
  tickClock();
  setInterval(tickClock, 1e3);
  poll();
  setInterval(poll, POLL_MS);
  setInterval(pollCommands, 500);
  show();
  setTimeout(() => location.reload(), 6 * 36e5);
  sound.arm();
  for (const type of ["keydown", "click", "touchstart", "mousedown"]) {
    addEventListener(type, sound.arm, true);
    addEventListener(type, unlockSound, true);
  }
  const fsNote = document.createElement("div");
  fsNote.id = "fs-note";
  fsNote.textContent = "Press OK on the remote to turn on Jarvis's voice";
  document.body.appendChild(fsNote);
  const isFull = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
  const goFull = () => {
    if (isFull() || stacked) return;
    const el = document.documentElement, req = el.requestFullscreen || el.webkitRequestFullscreen || el.webkitRequestFullScreen;
    if (req) {
      try {
        const r = req.call(el);
        if (r && r.catch) r.catch(() => {
        });
      } catch (err) {
      }
    }
  };
  const fsCheck = () => {
    const full = isFull() || stacked || window.innerHeight >= screen.height - 4;
    fsNote.textContent = !soundOn ? "Press OK on the remote to turn on Jarvis's voice" : "Press OK on the remote for full screen";
    fsNote.style.display = full && soundOn ? "none" : "block";
  };
  for (const type of ["keydown", "click", "touchstart"]) addEventListener(type, goFull, true);
  document.addEventListener("webkitfullscreenchange", () => {
    fsCheck();
    setTimeout(layout, 300);
  });
  document.addEventListener("fullscreenchange", () => {
    fsCheck();
    setTimeout(layout, 300);
  });
  setInterval(fsCheck, 3e3);
  fsCheck();
  addEventListener("keydown", (ev) => {
    if (ev.key === "c") queue.push({ level: "win", panel: "ach", big: true, title: "TEST WIN", text: "Celebration test" });
    if (ev.key === "a") queue.push({ level: "error", panel: "log", text: "Alarm test" });
    if (ev.key === "f" && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
  });
})();
