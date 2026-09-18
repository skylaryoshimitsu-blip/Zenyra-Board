import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPER_ADMIN_EMAIL    = process.env.SUPER_ADMIN_EMAIL;
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

  const { userId, name, phone, daily_goal, monthly_goal } = req.body || {};
  if (!userId || !name) return res.status(400).json({ error: 'userId and name are required' });
  if (!SUPER_ADMIN_EMAIL) return res.status(500).json({ error: 'SUPER_ADMIN_EMAIL is not configured' });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const { data: user, error: userErr } = await supabase
    .from('lb_users').select('id,email').eq('id', userId).single();
  if (userErr || !user) return res.status(401).json({ error: 'Unknown user' });

  const isSuperAdmin = !!user.email && user.email.toLowerCase() === SUPER_ADMIN_EMAIL.toLowerCase();
  if (!isSuperAdmin) return res.status(403).json({ error: 'Only the super admin may add agents' });

  const { data, error } = await supabase
    .from('lb_agents')
    .insert({
      name,
      phone: phone || null,
      daily_goal: daily_goal != null ? Number(daily_goal) : 1600,
      monthly_goal: monthly_goal != null ? Number(monthly_goal) : 160000,
      active: true,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ agent: data });
}
