// Everything live (the dashboard's data, voice, films, Jarvis's voice) comes from
// the Jarvis PC in the office, through its Cloudflare tunnel. The tunnel's
// current address is published by the PC (TUNNEL_JSON_URL); each request is
// passed on with RELAY_SECRET, which the PC requires.
import { authed } from './_auth.js';

let cached = { url: null, at: 0 };
async function tunnel(fresh) {
  if (!fresh && cached.url && Date.now() - cached.at < 20000) return cached.url;
  const r = await fetch(`${process.env.TUNNEL_JSON_URL}?t=${Date.now()}`, { cache: 'no-store' });
  const j = await r.json();
  cached = { url: j.url, at: Date.now() };
  return j.url;
}

export default async function handler(req, res) {
  if (!authed(req)) return res.status(401).json({ error: 'login' });
  const q = { ...req.query };
  const p = String(q.p || '/'); delete q.p;
  const qs = new URLSearchParams(q).toString();
  const init = { method: req.method, headers: { 'x-jarvis-relay': process.env.RELAY_SECRET || '', 'content-type': req.headers['content-type'] || 'application/json' } };
  if (req.headers.range) init.headers.range = req.headers.range;
  if (req.method !== 'GET' && req.method !== 'HEAD') init.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
  let r = null;
  for (const fresh of [false, true]) {
    try { r = await fetch(`${await tunnel(fresh)}${p}${qs ? '?' + qs : ''}`, init); break; } catch (err) { r = null; }
  }
  if (!r) return res.status(502).json({ error: 'The Jarvis computer in the office is not reachable' });
  res.status(r.status);
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) { const v = r.headers.get(h); if (v) res.setHeader(h, v); }
  if (!r.body) return res.end();
  const reader = r.body.getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(Buffer.from(value)); }
  res.end();
}
