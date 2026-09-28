// api/secure.js
// Single entry point for auth, reports and secure actions. Kept as one function so the
// project stays within Vercel's per-deployment serverless function limit.

import authHandler from './_lib/route-auth.js';
import reportsHandler from './_lib/route-reports.js';
import actionHandler from './_lib/route-secure-action.js';

const HANDLERS = { auth: authHandler, reports: reportsHandler, action: actionHandler };

export default async function handler(req, res) {
  const route = HANDLERS[req.query?.op];
  if (!route) return res.status(404).json({ error: 'Not found' });
  return route(req, res);
}
