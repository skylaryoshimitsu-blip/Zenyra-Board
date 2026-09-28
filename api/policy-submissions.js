import {
  serviceClient, setCORS, requireUser, canReport, canSeeBanking as userCanSeeBanking, audit, deny,
} from './_lib/auth.js';

const BANKING_FIELDS = ['banking_institution', 'routing_number', 'account_number', 'mothers_maiden_name'];

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { from, to, purpose } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: 'from and to are required' });

  const supabase = serviceClient();
  const user = await requireUser(req, supabase);
  if (!user) return res.status(401).json({ error: 'Session expired' });

  // CSV export is a download: allowlisted users only, and audited.
  if (purpose === 'export') {
    if (!canReport(user)) return deny(res, supabase, req, user, 'export', { kind: 'policy_csv', from, to });
    if (!(await audit(supabase, req, { actor: user.id, action: 'export', table: 'lb_submissions', detail: { kind: 'policy_csv', from, to } }))) {
      return res.status(500).json({ error: 'Could not record this action; try again.' });
    }
  }

  const canSeeBanking = userCanSeeBanking(user);
  const canEdit = user.role === 'admin' || user.role === 'dialer';

  // Fetch submissions in the requested date range (by submitted_at)
  const selectFields = [
    'id', 'submitted_at', 'agent_id', 'created_at',
    // customer
    'customer_first_name', 'customer_last_name',
    'customer_phone', 'customer_email', 'customer_dob', 'customer_gender',
    'customer_street', 'customer_city', 'customer_state', 'customer_postal_code',
    // product
    'product_type', 'policy_number', 'carrier_name', 'plan_name',
    'monthly_premium', 'annual_premium',
    'recurring_draft_day', 'draft_date', 'effective_date', 'carrier_status',
    // agent
    'agent_first_name', 'agent_last_name', 'agent_email', 'agent_npn',
    // medical
    'pcp_name', 'specialist_name', 'medications',
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

  return res.status(200).json({ data: safeData, canSeeBanking, canEdit });
}
