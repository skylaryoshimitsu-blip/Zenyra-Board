// api/inngest.js
import { serve } from 'inngest/express';
import { inngest } from '../inngest/client.js';
import { scoreAncillaryCall } from '../inngest/functions/scoreAncillaryCall.js';
 
export const config = { api: { bodyParser: false } };
 
const handler = serve({
  client: inngest,
  functions: [scoreAncillaryCall],
});
 
export default async function (req, res) {
  return handler(req, res);
}
