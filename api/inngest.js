// api/inngest.js
// Inngest serve handler for plain Vercel serverless (not Next.js)

import { inngest } from '../inngest/client.js';
import { scoreAncillaryCall } from '../inngest/functions/scoreAncillaryCall.js';

export const config = { api: { bodyParser: false } };

let handler = null;
async function getHandler() {
  const { serve } = await import('inngest/next');
  return serve({ client: inngest, functions: [scoreAncillaryCall] });
}

export default async function (req, res) {
  if (!handler) handler = await getHandler();
  return handler(req, res);
}
