// inngest/client.js
import { Inngest } from 'inngest';

export const inngest = new Inngest({
  id: 'zenyra-board',
  eventKey: process.env.INNGEST_EVENT_KEY,
});
