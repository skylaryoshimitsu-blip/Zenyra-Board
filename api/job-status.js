// api/job-status.js
// Polling endpoint — returns current job status and result when complete

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

  const { jobId } = req.query;
  if (!jobId) return res.status(400).json({ error: 'Missing jobId' });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data, error } = await supabase
    .from('lb_scorer_results')
    .select('*')
    .eq('id', jobId)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Job not found' });

  return res.status(200).json(data);
}
