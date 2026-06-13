// api/recent-scores.js
// Returns last 3 completed ancillary call scores for the history strip

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ALLOWED_ORIGIN       = process.env.ALLOWED_ORIGIN || '*';

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data, error } = await supabase
    .from('lb_scorer_results')
    .select('id,agent_name,overall_score,call_summary,coaching_points,score_intro,score_health,score_plan,score_problem,score_solution,score_enrollment,completed_at,file_name')
    .eq('status', 'complete')
    .eq('scorer_type', 'ancillary')
    .order('completed_at', { ascending: false })
    .limit(3);

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json(data || []);
}
