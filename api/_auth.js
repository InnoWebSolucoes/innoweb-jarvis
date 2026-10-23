// The live site's password check. Logging in sets a cookie holding a token
// derived from the password and RELAY_SECRET; every request through the relay
// must carry it.
import crypto from 'node:crypto';

export function token() {
  return crypto.createHmac('sha256', process.env.RELAY_SECRET || '').update(process.env.JARVIS_PASSWORD || '').digest('hex');
}

export function authed(req) {
  const m = /(?:^|;\s*)jarvis=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  return !!(m && process.env.JARVIS_PASSWORD && m[1] === token());
}
