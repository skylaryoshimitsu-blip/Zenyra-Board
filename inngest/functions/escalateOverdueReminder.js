import { inngest } from '../client.js';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export const escalateOverdueReminder = inngest.createFunction(
  { id: 'escalate-overdue-reminder', name: 'Escalate Overdue Reminder' },
  { event: 'notification/reminder.sent' },
  async ({ event, step }) => {
    const { notificationId, escalateAfterHours = 4 } = event.data;

    await step.sleep('wait-for-agent-response', `${escalateAfterHours}h`);

    const result = await step.run('check-and-escalate', async () => {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

      const { data: notif, error } = await supabase
        .from('lb_notifications')
        .select('id, confirmed_at, escalated')
        .eq('id', notificationId)
        .single();

      if (error || !notif)    return { skipped: 'not_found' };
      if (notif.confirmed_at) return { skipped: 'already_confirmed' };
      if (notif.escalated)    return { skipped: 'already_escalated' };

      await supabase
        .from('lb_notifications')
        .update({ escalated: true })
        .eq('id', notificationId);

      return { escalated: true, notificationId };
    });

    return result;
  }
);
