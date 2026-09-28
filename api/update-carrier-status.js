import { serviceClient, setCORS, requireUser } from './_lib/auth.js';

const VALID_STATUSES = ['awaiting_window','ready_to_submit','submitted_to_carrier','processed'];

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { submissionId, status } = req.body || {};
  if (!submissionId || !status)
    return res.status(400).json({ error: 'submissionId and status are required' });
  if (!VALID_STATUSES.includes(status))
    return res.status(400).json({ error: 'Invalid status value' });

  const supabase = serviceClient();

  // Identity comes from the signed session token, never the request body
  const user = await requireUser(req, supabase);
  if (!user) return res.status(401).json({ error: 'Session expired' });

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
