import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ALLOWED_ORIGIN       = process.env.ALLOWED_ORIGIN || '*';

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const BANKING_FIELDS = ['banking_institution', 'routing_number', 'account_number', 'mothers_maiden_name'];

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { userId, from, to } = req.body || {};
  if (!userId || !from || !to) return res.status(400).json({ error: 'userId, from, and to are required' });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Determine whether the requesting user may see banking fields
  const { data: user, error: userErr } = await supabase
    .from('lb_users')
    .select('id, role, display_name')
    .eq('id', userId)
    .single();

  if (userErr || !user) return res.status(401).json({ error: 'Unknown user' });

  const canSeeBanking = user.role === 'admin';

  // Fetch submissions in the requested date range (by submitted_at)
  const selectFields = [
    'id', 'submitted_at', 'agent_id',
    'customer_first_name', 'customer_last_name',
    'carrier_name', 'plan_name', 'customer_state',
    'monthly_premium', 'annual_premium',
    'effective_date', 'carrier_status', 'created_at',
    'lb_agents(name)',
    ...(canSeeBanking ? BANKING_FIELDS : [])
  ].join(',');

  // from/to are date strings (YYYY-MM-DD); expand to full day boundaries
  const { data, error } = await supabase
    .from('lb_submissions')
    .select(selectFields)
    .eq('status', 'live')
    .gte('submitted_at', from + 'T00:00:00')
    .lte('submitted_at', to   + 'T23:59:59')
    .order('submitted_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  // Strip banking keys from response for non-admins (belt-and-suspenders)
  const safeData = canSeeBanking
    ? data
    : data.map(r => {
        const out = { ...r };
        BANKING_FIELDS.forEach(k => delete out[k]);
        return out;
      });

  return res.status(200).json({ data: safeData, canSeeBanking });
}
