// api/inngest.js
import { inngest } from '../inngest/client.js';
import { scoreAncillaryCall } from '../inngest/functions/scoreAncillaryCall.js';

export const config = { api: { bodyParser: false } };

async function getHandler() {
  const { serve } = await import('inngest/next');
  return serve({ client: inngest, functions: [scoreAncillaryCall] });
}

let handler = null;

export default async function (req, res) {
  if (!handler) handler = await getHandler();
  return handler(req, res);
}
