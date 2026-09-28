import { serviceClient, requireUser, canReport, audit, deny } from './_lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const supabase = serviceClient();
    const user = await requireUser(req, supabase);
    if (!user) return res.status(401).json({ error: 'Session expired' });
    // AI analysis is report generation: admins need the report allowlist; agents keep their own analysis.
    if (user.role === 'admin' && !canReport(user)) return deny(res, supabase, req, user, 'report', { report: 'intelligence' });
    if (user.role === 'admin') await audit(supabase, req, { actor: user.id, action: 'report', detail: { report: 'intelligence' } });

    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'prompt is required' });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const error = await response.text();
      return res.status(response.status).json({ error });
    }

    const data = await response.json();
    const text = data.content?.find(b => b.type === 'text')?.text || 'Analysis unavailable.';
    return res.status(200).json({ text });

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
