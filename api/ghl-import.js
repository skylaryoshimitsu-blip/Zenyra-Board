// api/ghl-import.js
// Processes one page of GHL contacts per request to avoid Vercel timeouts.
// Client chains requests using nextPageToken until null.
// Banking fields are always null — GHL does not carry them.
import { createClient } from '@supabase/supabase-js';

const GHL_API_KEY          = process.env.GHL_API_KEY;
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ALLOWED_ORIGIN       = process.env.ALLOWED_ORIGIN || '*';

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth removed — one-time import endpoint, delete after use
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  if (!GHL_API_KEY) return res.status(500).json({ error: 'GHL_API_KEY not configured' });

  const { pageToken = null, batchNum = 1 } = req.body || {};

  // Load GHL settings
  const { data: settings } = await supabase.from('lb_settings').select('key, value').like('key', 'ghl_%');
  const cfg = {};
  (settings || []).forEach(s => { cfg[s.key] = s.value; });
  const locationId = cfg.ghl_location_id || 'j9qoEVXyaE55rXmQ7kLg';

  // Load all lb_agents for matching
  const { data: agentRows } = await supabase.from('lb_agents').select('id, name').eq('active', true);
  const agents = agentRows || [];

  // Fetch one page of GHL contacts
  const url = new URL('https://services.leadconnectorhq.com/contacts/');
  url.searchParams.set('locationId', locationId);
  url.searchParams.set('limit', '25');
  if (pageToken) url.searchParams.set('startAfter', pageToken);

  const ghlRes = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28' },
  });
  if (!ghlRes.ok) {
    const err = await ghlRes.text();
    return res.status(200).json({ ok: false, error: `GHL fetch failed batch ${batchNum}: ${err}` });
  }
  const ghlData = await ghlRes.json();
  const contacts = ghlData.contacts || [];

  // Determine next page cursor
  let nextPageToken = null;
  if (contacts.length === 25 && ghlData.meta?.nextPageUrl) {
    try {
      const next = new URL(ghlData.meta.nextPageUrl);
      nextPageToken = next.searchParams.get('startAfter') || null;
    } catch { /* no next page */ }
  }

  // Helper: resolve agent_id from custom field values
  function resolveAgent(contact) {
    const cfMap = {};
    (contact.customFields || []).forEach(cf => { cfMap[cf.id] = cf.value; });
    const agentFirst = cfg.ghl_field_agent_first_name ? cfMap[cfg.ghl_field_agent_first_name] : null;
    const agentLast  = cfg.ghl_field_agent_last_name  ? cfMap[cfg.ghl_field_agent_last_name]  : null;
    if (agentFirst && agentLast) {
      const fullName = `${agentFirst} ${agentLast}`.toLowerCase();
      const match = agents.find(a => a.name.toLowerCase() === fullName);
      if (match) return match.id;
    }
    return null;
  }

  // Helper: extract custom field value
  function cf(contact, settingKey) {
    const fieldId = cfg[settingKey];
    if (!fieldId) return null;
    const f = (contact.customFields || []).find(c => c.id === fieldId);
    return f ? f.value : null;
  }

  const stats = { batchNum, fetched: contacts.length, imported: 0, skipped_duplicates: 0, skipped_unattributed: 0, errors: 0 };
  const toInsert = [];

  for (const contact of contacts) {
    try {
      const agentId = resolveAgent(contact);
      if (!agentId) { stats.skipped_unattributed++; continue; }

      // Duplicate check: same first+last+phone+agent_id
      const { data: existing } = await supabase
        .from('lb_submissions')
        .select('id')
        .eq('customer_first_name', contact.firstName || '')
        .eq('customer_last_name', contact.lastName || '')
        .eq('customer_phone', contact.phone || '')
        .eq('agent_id', agentId)
        .limit(1);
      if (existing && existing.length > 0) { stats.skipped_duplicates++; continue; }

      toInsert.push({
        agent_id:              agentId,
        status:                'live',
        customer_first_name:   contact.firstName || '',
        customer_last_name:    contact.lastName || '',
        customer_phone:        contact.phone || '',
        customer_email:        contact.email || '',
        customer_dob:          contact.dateOfBirth || null,
        customer_gender:       contact.gender || '',
        customer_street:       contact.address1 || '',
        customer_city:         contact.city || '',
        customer_state:        contact.state || '',
        customer_postal_code:  contact.postalCode || '',
        product_type:          cf(contact, 'ghl_field_product_type') || '',
        policy_number:         cf(contact, 'ghl_field_policy_number') || '',
        carrier_name:          cf(contact, 'ghl_field_carrier') || '',
        plan_name:             cf(contact, 'ghl_field_plan_name') || '',
        monthly_premium:       parseFloat(cf(contact, 'ghl_field_monthly_premium') || '0') || null,
        annual_premium:        parseFloat(cf(contact, 'ghl_field_annual_premium') || '0') || null,
        effective_date:        cf(contact, 'ghl_field_effective_date') || null,
        agent_email:           cf(contact, 'ghl_field_agent_email') || '',
        banking_institution:   null,
        routing_number:        null,
        account_number:        null,
        mothers_maiden_name:   null,
      });
    } catch (e) {
      console.error('Contact mapping error:', e);
      stats.errors++;
    }
  }

  if (toInsert.length > 0) {
    const { data: insertData, error: insertErr } = await supabase.from('lb_submissions').insert(toInsert);
    if (insertErr) {
      console.error('Insert error:', JSON.stringify(insertErr));
      return res.status(200).json({
        batchNum,
        fetched: contacts.length,
        imported: 0,
        insert_error: insertErr.message,
        insert_error_detail: insertErr.details,
        insert_error_hint: insertErr.hint,
        sample_record: toInsert[0],
        nextPageToken: null,
      });
    } else {
      stats.imported += toInsert.length;
    }
  }

  // DEBUG: stop after first batch so we can verify inserts before running full import
  return res.status(200).json({ ...stats, sample_record: toInsert[0] || null, nextPageToken: null });
}
