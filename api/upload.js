// api/upload.js
// Receives multipart audio upload → stores to Supabase Storage → triggers Inngest job → returns jobId

import { createClient } from '@supabase/supabase-js';
import { inngest } from '../inngest/client.js';

export const config = { api: { bodyParser: false } };

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

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    // Read raw body as buffer
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks);

    // Parse multipart manually — extract boundary from content-type header
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) return res.status(400).json({ error: 'No boundary in Content-Type' });
    const boundary = '--' + boundaryMatch[1];

    // Split body by boundary
    const parts = rawBody.toString('binary').split(boundary);
    let audioBuffer = null;
    let fileName = 'call.mp3';
    let mimeType = 'audio/mpeg';
    let agentName = 'Unknown Agent';
    let agentId = null;

    for (const part of parts) {
      if (part.includes('Content-Disposition')) {
        const nameMatch = part.match(/name="([^"]+)"/);
        const filenameMatch = part.match(/filename="([^"]+)"/);
        const ctMatch = part.match(/Content-Type: ([^\r\n]+)/);

        const fieldName = nameMatch?.[1];
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const rawValue = part.slice(headerEnd + 4, part.lastIndexOf('\r\n'));

        if (fieldName === 'agentName') {
          agentName = rawValue.trim();
        } else if (fieldName === 'agentId') {
          agentId = rawValue.trim() || null;
        } else if (fieldName === 'audio' && filenameMatch) {
          fileName = filenameMatch[1];
          mimeType = ctMatch?.[1]?.trim() || 'audio/mpeg';
          audioBuffer = Buffer.from(rawValue, 'binary');
        }
      }
    }

    if (!audioBuffer || audioBuffer.length < 100) {
      return res.status(400).json({ error: 'No valid audio file received' });
    }

    // Upload to Supabase Storage
    const storagePath = `ancillary/${Date.now()}_${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const { error: uploadError } = await supabase.storage
      .from('lb-scorer-audio')
      .upload(storagePath, audioBuffer, { contentType: mimeType, upsert: false });

    if (uploadError) return res.status(500).json({ error: 'Storage upload failed: ' + uploadError.message });

    // Create job record in Supabase
    const { data: jobRow, error: insertError } = await supabase
      .from('lb_scorer_results')
      .insert({
        status: 'queued',
        agent_name: agentName,
        agent_id: agentId,
        file_name: fileName,
        scorer_type: 'ancillary',
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (insertError) return res.status(500).json({ error: 'Job record failed: ' + insertError.message });

    // Trigger Inngest job
    await inngest.send({
      name: 'board/ancillary.call.uploaded',
      data: { jobId: jobRow.id, storagePath, agentName, agentId },
    });

    return res.status(200).json({ jobId: jobRow.id });

  } catch (err) {
    console.error('Upload error:', err);
    return res.status(500).json({ error: err.message });
  }
}
