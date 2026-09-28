import { inngest } from '../inngest/client.js';
import { serviceClient, setCORS, requireUser } from './_lib/auth.js';

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { notificationId, escalateAfterHours = 4 } = req.body || {};
  if (!notificationId)
    return res.status(400).json({ error: 'notificationId is required' });

  // Verify the caller is a dialer or admin (only they send reminders)
  const supabase = serviceClient();
  const user = await requireUser(req, supabase);
  if (!user) return res.status(401).json({ error: 'Session expired' });
  if (!['admin', 'dialer'].includes(user.role))
    return res.status(403).json({ error: 'Only admin or dialer may schedule escalations' });

  await inngest.send({
    name: 'notification/reminder.sent',
    data: { notificationId, escalateAfterHours },
  });

  return res.status(200).json({ ok: true, escalateAfterHours });
}
