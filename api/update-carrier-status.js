import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ALLOWED_ORIGIN       = process.env.ALLOWED_ORIGIN || '*';

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const VALID_STATUSES = ['awaiting_window','ready_to_submit','submitted_to_carrier','processed'];

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { submissionId, status, userId } = req.body || {};
  if (!submissionId || !status || !userId)
    return res.status(400).json({ error: 'submissionId, status, and userId are required' });
  if (!VALID_STATUSES.includes(status))
    return res.status(400).json({ error: 'Invalid status value' });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Verify requesting user exists (agent confirming their own submission is allowed)
  const { data: user, error: userErr } = await supabase
    .from('lb_users').select('id,role').eq('id', userId).single();
  if (userErr || !user) return res.status(401).json({ error: 'Unknown user' });

  // Agents may only set status to 'processed'; admins/dialers may set any status
  const isPrivileged = user.role === 'admin' || user.role === 'dialer';
  if (!isPrivileged && status !== 'processed')
    return res.status(403).json({ error: 'Agents may only mark submissions as processed' });

  const { error } = await supabase
    .from('lb_submissions')
    .update({ carrier_status: status })
    .eq('id', submissionId);

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true });
}
