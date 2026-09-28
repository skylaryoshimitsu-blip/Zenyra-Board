// Handler for /api/secure?op=reports (dispatched by api/secure.js)
// Report data, served only to REPORT_ALLOWED_USER_IDS. Each run is audited.
// Queries mirror what the page used to run directly with the anon key.

import { serviceClient, setCORS, requireUser, canReport, canSeeBanking, audit, deny } from './auth.js';

const BANKING_FIELDS = ['banking_institution', 'routing_number', 'account_number', 'mothers_maiden_name'];
const EOD_FIELDS = 'id,customer_first_name,customer_last_name,carrier_name,plan_name,monthly_premium,annual_premium,effective_date,carrier_status,lb_agents(name)';

const isISO = s => typeof s === 'string' && !Number.isNaN(Date.parse(s));
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = serviceClient();
  const user = await requireUser(req, supabase);
  if (!user) return res.status(401).json({ error: 'Session expired' });

  const { report, from, to, agentId, date } = req.body || {};
  if (!['performance', 'product_breakdown', 'dialer_effort', 'eod'].includes(report)) return res.status(400).json({ error: 'Unknown report' });
  if (!canReport(user)) return deny(res, supabase, req, user, 'report', { report });
  if (report === 'eod' ? !isDate(date) : !(isISO(from) && isISO(to))) return res.status(400).json({ error: 'Invalid date range' });

  if (!(await audit(supabase, req, { actor: user.id, action: 'report', detail: { report, from: from || null, to: to || null, date: date || null, agent_id: agentId || null } }))) {
    return res.status(500).json({ error: 'Could not record this action; try again.' });
  }

  try {
    const strip = rows => canSeeBanking(user) ? rows : (rows || []).map(r => { const o = { ...r }; BANKING_FIELDS.forEach(k => delete o[k]); return o; });
    const agentFiltered = q => (agentId && agentId !== 'all') ? q.eq('agent_id', agentId) : q;
    const check = r => { if (r.error) throw new Error(r.error.message); return r.data || []; };

    if (report === 'performance') {
      const [subs, calls] = await Promise.all([
        agentFiltered(supabase.from('lb_submissions').select('*,lb_agents(name)').eq('status', 'live').gte('submitted_at', from).lte('submitted_at', to)).order('submitted_at', { ascending: false }),
        agentFiltered(supabase.from('lb_dialer_activity').select('agent_id,log_date,total_calls').is('deleted_at', null).gte('log_date', from.slice(0, 10)).lte('log_date', to.slice(0, 10))),
      ]);
      return res.status(200).json({ subs: strip(check(subs)), calls: check(calls) });
    }
    if (report === 'product_breakdown') {
      const [anc, mapd] = await Promise.all([
        supabase.from('lb_submissions').select('*,lb_agents(name)').gte('submitted_at', from).lte('submitted_at', to).neq('status', 'deleted'),
        supabase.from('lb_mapd_submissions').select('*,lb_agents(name)').gte('submitted_at', from).lte('submitted_at', to).neq('status', 'deleted'),
      ]);
      return res.status(200).json({ ancSubs: strip(check(anc)), mapdSubs: check(mapd) });
    }
    if (report === 'dialer_effort') {
      const [calls, subs] = await Promise.all([
        agentFiltered(supabase.from('lb_dialer_activity').select('*,lb_agents(name)').is('deleted_at', null).gte('log_date', from.slice(0, 10)).lte('log_date', to.slice(0, 10))),
        agentFiltered(supabase.from('lb_submissions').select('agent_id,annual_premium,monthly_premium,submitted_at,lb_agents(name)').eq('status', 'live').gte('submitted_at', from).lte('submitted_at', to)),
      ]);
      return res.status(200).json({ calls: check(calls), subs: check(subs) });
    }
    // eod
    const [subsRes, heartlandRes, processedRes, notifRes] = await Promise.all([
      supabase.from('lb_submissions').select(EOD_FIELDS).eq('status', 'live').gte('submitted_at', date + 'T00:00:00').lte('submitted_at', date + 'T23:59:59').order('submitted_at', { ascending: false }),
      supabase.from('lb_submissions').select(EOD_FIELDS).eq('status', 'live').eq('carrier_name', 'Heartland').or('carrier_status.is.null,carrier_status.eq.awaiting_window,carrier_status.eq.ready_to_submit'),
      supabase.from('lb_submissions').select(EOD_FIELDS).eq('status', 'live').eq('carrier_status', 'processed').order('effective_date', { ascending: true }),
      supabase.from('lb_notifications').select('id,title,message,created_at,lb_users!recipient_id(display_name)').eq('escalated', true).gte('created_at', date + 'T00:00:00').lte('created_at', date + 'T23:59:59'),
    ]);
    return res.status(200).json({ todaySubs: check(subsRes), heartland: check(heartlandRes), processed: check(processedRes), escalated: check(notifRes) });
  } catch (err) {
    console.error('report error', report, err);
    return res.status(500).json({ error: 'Report failed' });
  }
}
