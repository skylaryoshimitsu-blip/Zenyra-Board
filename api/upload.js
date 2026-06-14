// api/upload.js
import { createClient } from '@supabase/supabase-js';
import { inngest } from '../inngest/client.js';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ALLOWED_ORIGIN       = process.env.ALLOWED_ORIGIN || '*';

// DO NOT set bodyParser: false — we need it ON for JSON bodies
export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Body is already parsed by Vercel's default bodyParser
  const body = req.body || {};
  const { action, agentName, agentId, fileName, jobId, uploadPath } = body;

  // ── Action 1: Create job record + return storage path ──────────────────
  if (action === 'create-job') {
    const safeName = (fileName || 'call.mp3').replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `ancillary/${Date.now()}_${safeName}`;

    const { data: jobRow, error } = await supabase
      .from('lb_scorer_results')
      .insert({
        status:      'queued',
        agent_name:  agentName || 'Unknown',
        agent_id:    agentId || null,
        file_name:   fileName || 'call.mp3',
        scorer_type: 'ancillary',
        created_at:  new Date().toISOString(),
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: 'Job record failed: ' + error.message });
    return res.status(200).json({ jobId: jobRow.id, uploadPath: path });
  }

  // ── Action 2: Trigger Inngest after file is in storage ─────────────────
  if (action === 'trigger-job') {
    if (!jobId || !uploadPath) return res.status(400).json({ error: 'Missing jobId or uploadPath' });

    await inngest.send({
      name: 'board/ancillary.call.uploaded',
      data: {
        jobId,
        storagePath:  uploadPath,
        agentName:    agentName || 'Unknown',
        agentId:      agentId || null,
      },
    });

    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'Unknown action: ' + action });
}
