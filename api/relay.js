// Everything live (the dashboard's data, voice, films, Jarvis's voice) comes from
// the Jarvis PC in the office, through its Cloudflare tunnel. The tunnel's
// current address is published by the PC (TUNNEL_JSON_URL); each request is
// passed on with RELAY_SECRET, which the PC requires.
import crypto from 'node:crypto';
import { authed } from './_auth.js';
import { readInnolink, readFlowdesk } from '../lib/sources.mjs';

let cached = { url: null, at: 0 };
async function tunnel(fresh) {
  if (!fresh && cached.url && Date.now() - cached.at < 20000) return cached.url;
  const r = await fetch(`${process.env.TUNNEL_JSON_URL}?t=${Date.now()}`, { cache: 'no-store' });
  const j = await r.json();
  cached = { url: j.url, at: Date.now() };
  return j.url;
}

// The state the Jarvis PC saves every 30 seconds (iv | encrypted | tag, AES-256-GCM, key from RELAY_SECRET).
async function lastSaved() {
  const url = String(process.env.TUNNEL_JSON_URL).replace(/tunnel\.json$/, 'state.bin');
  const buf = Buffer.from(await (await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' })).arrayBuffer());
  const key = crypto.createHash('sha256').update(process.env.RELAY_SECRET || '').digest();
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]).toString('utf8'));
}

// With the PC off, the figures still come live from where they're kept online:
// Innolink and FlowDesk read here (lib/sources.mjs, the same code Jarvis runs),
// the lead finder through api/leads.py. Each part that answers replaces the
// saved one; one that doesn't keeps the saved figures. Cached for 20 seconds.
let liveCache = { at: 0, parts: null };
async function liveFigures(host) {
  if (liveCache.parts && Date.now() - liveCache.at < 20000) return liveCache.parts;
  const e = process.env;
  const [innolink, flowdesk, leads] = await Promise.all([
    e.INNOLINK_SERVICE_ROLE_KEY ? readInnolink({ url: e.INNOLINK_URL || 'https://wjmrwszorppurykmwmwt.supabase.co', service: e.INNOLINK_SERVICE_ROLE_KEY }).catch(() => null) : null,
    e.FLOWDESK_URL ? readFlowdesk({ url: e.FLOWDESK_URL, anon: e.FLOWDESK_ANON_KEY, email: e.FLOWDESK_EMAIL, password: e.FLOWDESK_PASSWORD }).then(r => r.flowdesk).catch(() => null) : null,
    e.LEAD_DB_URL ? fetch(`https://${host}/api/leads`, { headers: { 'x-jarvis-relay': e.RELAY_SECRET || '' }, signal: AbortSignal.timeout(25000) })
      .then(r => r.json()).then(j => (j && j.ok ? { ...j, usage: undefined, spend: undefined, caps: undefined, demos: undefined, events: undefined } : null)).catch(() => null) : null,
  ]);
  const parts = {};
  if (innolink) parts.innolink = innolink;
  if (flowdesk) parts.flowdesk = flowdesk;
  if (leads) parts.leads = leads;
  liveCache = { at: Date.now(), parts };
  return parts;
}

export default async function handler(req, res) {
  const q = { ...req.query };
  const p = String(q.p || '/'); delete q.p;
  // A TV's media player fetches sound without the login cookie; voice files are
  // signed instead, and the Jarvis PC checks the signature.
  if (!authed(req) && !(p.startsWith('/api/tts/') && q.sig)) return res.status(401).json({ error: 'login' });
  const qs = new URLSearchParams(q).toString();
  const init = { method: req.method, headers: { 'x-jarvis-relay': process.env.RELAY_SECRET || '', 'content-type': req.headers['content-type'] || 'application/json' } };
  if (req.headers.range) init.headers.range = req.headers.range;
  if (req.method !== 'GET' && req.method !== 'HEAD') init.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
  let r = null;
  for (const fresh of [false, true]) {
    try { r = await fetch(`${await tunnel(fresh)}${p}${qs ? '?' + qs : ''}`, init); break; } catch (err) { r = null; }
  }
  // The Jarvis PC is off or unreachable: the dashboard shows the last figures it saved.
  if (!r || (r.status >= 500 && !String(r.headers.get('content-type') || '').includes('json'))) {
    if (p === '/api/state') {
      const [saved, live] = await Promise.all([lastSaved().catch(() => null), liveFigures(req.headers.host).catch(() => ({}))]);
      if (saved || Object.keys(live).length) {
        const out = { ...(saved || {}), ...live, stale: true, live: Object.keys(live), liveAt: new Date().toISOString() };
        // The sources that answered just now aren't "offline", whatever the saved state said.
        out.failing = Object.fromEntries(Object.entries(out.failing || {}).filter(([k]) => !live[k]));
        return res.status(200).json(out);
      }
    }
    if (p === '/api/commands') return res.status(200).json({ last: 0, commands: [], live: null });
    return res.status(502).json({ error: 'The Jarvis computer in the office is not reachable' });
  }
  res.status(r.status);
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) { const v = r.headers.get(h); if (v) res.setHeader(h, v); }
  if (!r.body) return res.end();
  const reader = r.body.getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(Buffer.from(value)); }
  res.end();
}
