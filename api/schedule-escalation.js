import { inngest } from '../inngest/client.js';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ALLOWED_ORIGIN       = process.env.ALLOWED_ORIGIN || '*';

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { notificationId, userId, escalateAfterHours = 4 } = req.body || {};
  if (!notificationId || !userId)
    return res.status(400).json({ error: 'notificationId and userId are required' });

  // Verify the caller is a dialer or admin (only they send reminders)
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data: user, error: userErr } = await supabase
    .from('lb_users').select('id, role').eq('id', userId).single();
  if (userErr || !user) return res.status(401).json({ error: 'Unknown user' });
  if (!['admin', 'dialer'].includes(user.role))
    return res.status(403).json({ error: 'Only admin or dialer may schedule escalations' });

  await inngest.send({
    name: 'notification/reminder.sent',
    data: { notificationId, escalateAfterHours },
  });

  return res.status(200).json({ ok: true, escalateAfterHours });
}
