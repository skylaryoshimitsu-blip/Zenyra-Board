// api/auth.js
// Server-side login, registration, password change and session check.
// Passwords are verified here; password_hash never leaves the server.

import {
  serviceClient, setCORS, sha256Hex, safeEqual, issueToken, publicUser, requireUser,
  isRevokedRow, audit, USER_PUBLIC_FIELDS,
} from './_lib/auth.js';

const LOGIN_ROLES = { agent: ['agent', 'solo'], solo: ['solo'], admin: ['admin'], dialer: ['dialer'] };
const LOGIN_FAILED = 'Incorrect password. Try again or register.';

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const supabase = serviceClient();
  try {
    switch (body.action) {
      case 'login':           return await login(req, res, supabase, body);
      case 'register':        return await register(req, res, supabase, body);
      case 'change_password': return await changePassword(req, res, supabase, body);
      case 'me': {
        const user = await requireUser(req, supabase);
        if (!user) return res.status(401).json({ error: 'Session expired' });
        return res.status(200).json({ user });
      }
      default: return res.status(400).json({ error: 'Unknown action' });
    }
  } catch (err) {
    console.error('auth error', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

async function login(req, res, supabase, { portal, agentId, username, password }) {
  const roles = LOGIN_ROLES[portal];
  if (!roles || !password) return res.status(400).json({ error: 'Missing credentials' });

  let q = supabase.from('lb_users').select(USER_PUBLIC_FIELDS + ',password_hash').in('role', roles);
  if (portal === 'dialer') {
    if (!username) return res.status(400).json({ error: 'Enter your username.' });
    q = q.eq('display_name', String(username).trim());
  } else {
    if (!agentId) return res.status(400).json({ error: 'Select your name.' });
    q = q.eq('agent_id', agentId);
  }
  const { data: rows, error } = await q;
  if (error) return res.status(500).json({ error: 'Login failed' });

  const hash = sha256Hex(password);
  const row = (rows || []).find(r => !isRevokedRow(r) && safeEqual(r.password_hash, hash));
  if (!row) {
    await audit(supabase, req, { action: 'login_failed', table: 'lb_users', detail: { portal, agent_id: agentId || null, username: username || null } });
    return res.status(401).json({ error: portal === 'dialer' ? 'Incorrect username or password.' : LOGIN_FAILED });
  }

  const lastLogin = new Date().toISOString();
  await supabase.from('lb_users').update({ last_login: lastLogin }).eq('id', row.id);
  await audit(supabase, req, { actor: row.id, action: 'login', table: 'lb_users', target: row.id, detail: { portal } });
  return res.status(200).json({ token: issueToken(row), user: { ...publicUser(row), last_login: lastLogin } });
}

async function register(req, res, supabase, { portal, agentId, displayName, password }) {
  if (portal === 'admin' || portal === 'solo') {
    await audit(supabase, req, { action: 'denied:register', detail: { portal, agent_id: agentId || null } });
    return res.status(403).json({ error: 'Admin sign-up is disabled. Ask Tahj to create your account.' });
  }
  if (portal !== 'agent' && portal !== 'dialer') return res.status(400).json({ error: 'Invalid portal' });
  if (!password || String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  let insert;
  if (portal === 'dialer') {
    const name = String(displayName || '').trim();
    if (!name) return res.status(400).json({ error: 'Enter a display name.' });
    const { data: existing } = await supabase.from('lb_users').select('id').eq('display_name', name).eq('role', 'dialer');
    if (existing?.length) return res.status(409).json({ error: 'Account already exists. Sign in instead.' });
    insert = { agent_id: null, display_name: name, role: 'dialer', password_hash: sha256Hex(password) };
  } else {
    if (!agentId) return res.status(400).json({ error: 'Select your name.' });
    const { data: agent } = await supabase.from('lb_agents').select('id,name,active').eq('id', agentId).single();
    if (!agent || !agent.active) return res.status(400).json({ error: 'Unknown agent.' });
    const { data: existing } = await supabase.from('lb_users').select('id').eq('agent_id', agentId).eq('role', 'agent');
    if (existing?.length) return res.status(409).json({ error: 'Account already exists. Sign in instead.' });
    insert = { agent_id: agentId, display_name: agent.name || 'Agent', role: 'agent', password_hash: sha256Hex(password) };
  }

  const { data: row, error } = await supabase.from('lb_users').insert(insert).select(USER_PUBLIC_FIELDS + ',password_hash').single();
  if (error) return res.status(500).json({ error: 'Registration failed: ' + error.message });
  await audit(supabase, req, { actor: row.id, action: 'register', table: 'lb_users', target: row.id, detail: { role: row.role } });
  return res.status(200).json({ token: issueToken(row), user: publicUser(row) });
}

async function changePassword(req, res, supabase, { currentPassword, newPassword }) {
  const user = await requireUser(req, supabase);
  if (!user) return res.status(401).json({ error: 'Session expired' });
  if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });

  const { data: row } = await supabase.from('lb_users').select('id,password_hash').eq('id', user.id).single();
  if (!row || !safeEqual(row.password_hash, sha256Hex(currentPassword || ''))) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }
  const newHash = sha256Hex(newPassword);
  const { error } = await supabase.from('lb_users').update({ password_hash: newHash }).eq('id', user.id);
  if (error) return res.status(500).json({ error: 'Failed to update password: ' + error.message });
  await audit(supabase, req, { actor: user.id, action: 'password_change', table: 'lb_users', target: user.id });
  return res.status(200).json({ token: issueToken({ id: user.id, password_hash: newHash }) });
}
