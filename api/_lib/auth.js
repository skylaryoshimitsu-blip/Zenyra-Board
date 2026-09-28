// Shared server-side auth: signed session tokens, per-user allowlists, and the audit log.
// Files under api/_lib are not deployed as routes (Vercel ignores underscore-prefixed paths).

import crypto from 'node:crypto';
import net from 'node:net';
import { createClient } from '@supabase/supabase-js';

const SESSION_TTL_SECONDS = 12 * 60 * 60;

// Allowlists are keyed on lb_users.id — never display name or role.
const TAHJ_ADMIN_ID  = 'b180a6b3-6f73-415f-b0fb-3a3a505310d2'; // Tahj Williams (admin)
const LENT_DIALER_ID = '2a415341-76d2-4b08-a147-5ed14949464b'; // Lent Corteza (dialer)

export const DELETE_ALLOWED_USER_IDS = [TAHJ_ADMIN_ID];
export const REPORT_ALLOWED_USER_IDS = [TAHJ_ADMIN_ID, LENT_DIALER_ID];
export const BANKING_PII_ALLOWED_USER_IDS = [
  TAHJ_ADMIN_ID,
  'c9bd754c-1634-46d4-827b-58def8efbf67', // Kole McDevitt (solo)
];
// Accounts that may never sign in or use a session.
export const DISABLED_USER_IDS = [
  'd213e861-4833-45dc-bc79-388b497c2c04', // duplicate "Tahj Williams" admin row, created 7/19, no agent_id
];

export const DENIED_MESSAGE = "This action isn't available for your account.";

export const canDelete = user => !!user && DELETE_ALLOWED_USER_IDS.includes(user.id);
export const canReport = user => !!user && REPORT_ALLOWED_USER_IDS.includes(user.id);
export const canSeeBanking = user => !!user && BANKING_PII_ALLOWED_USER_IDS.includes(user.id);

export const USER_PUBLIC_FIELDS = 'id,agent_id,display_name,role,created_at,last_login,email';

export function serviceClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}

export function setCORS(res, methods = 'POST, OPTIONS') {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

export function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error('SESSION_SECRET is not configured');
  return s;
}

// Fingerprint of the stored password hash: changing or resetting a password revokes existing tokens.
function passwordVersion(passwordHash) { return sha256Hex('pv:' + (passwordHash || '')).slice(0, 16); }

export function isRevokedRow(row) {
  return !row || DISABLED_USER_IDS.includes(row.id) || !row.password_hash || row.password_hash.startsWith('invalidated');
}

export function issueToken(userRow) {
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({ sub: userRow.id, pv: passwordVersion(userRow.password_hash), iat: now, exp: now + SESSION_TTL_SECONDS }));
  const sig = b64url(crypto.createHmac('sha256', secret()).update(payload).digest());
  return payload + '.' + sig;
}

export function publicUser(row) {
  const { password_hash, ...rest } = row;
  return rest;
}

// Returns the signed-in user (without password_hash), or null. Default-deny on any doubt.
export async function requireUser(req, supabase) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = b64url(crypto.createHmac('sha256', secret()).update(payload).digest());
  if (!safeEqual(sig, expected)) return null;
  let claims;
  try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  if (!claims?.sub || !claims.exp || claims.exp < Math.floor(Date.now() / 1000)) return null;
  const { data: row, error } = await supabase.from('lb_users').select(USER_PUBLIC_FIELDS + ',password_hash').eq('id', claims.sub).single();
  if (error || isRevokedRow(row) || claims.pv !== passwordVersion(row.password_hash)) return null;
  return publicUser(row);
}

export function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = fwd || String(req.headers['x-real-ip'] || '').trim() || req.socket?.remoteAddress || '';
  return net.isIP(ip) ? ip : null;
}

// Append a row to lb_audit_log. Returns true on success.
export async function audit(supabase, req, { actor, action, table = null, target = null, detail = null }) {
  const { error } = await supabase.from('lb_audit_log').insert({
    actor_user_id: actor || null,
    action,
    target_table: table,
    target_id: target == null ? null : String(target),
    detail,
    ip: clientIp(req),
    user_agent: String(req.headers['user-agent'] || '').slice(0, 500) || null,
  });
  if (error) console.error('audit insert failed', action, error.message);
  return !error;
}

export async function deny(res, supabase, req, user, action, detail = null) {
  await audit(supabase, req, { actor: user?.id, action: 'denied:' + action, detail });
  return res.status(403).json({ error: DENIED_MESSAGE, denied: true });
}
