// POST {password}: the right password sets the cookie for a year.
import { token, authed } from './_auth.js';

export default function handler(req, res) {
  if (req.method === 'GET') return res.status(authed(req) ? 200 : 401).json({ ok: authed(req) });
  const given = String((req.body && req.body.password) || '');
  if (!process.env.JARVIS_PASSWORD || given !== process.env.JARVIS_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  res.setHeader('Set-Cookie', `jarvis=${token()}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`);
  return res.status(200).json({ ok: true });
}
