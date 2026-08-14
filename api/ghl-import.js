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

function buildRecord(contact, agentId, cfg) {
  const cf = {};
  (contact.customFields || []).forEach(f => { cf[f.id] = f.fieldValue; });

  const str = (val) => {
    if (val === null || val === undefined || val === '' || val === 'null') return null;
    return String(val).trim() || null;
  };

  const num = (val) => {
    if (val === null || val === undefined || val === '') return null;
    const n = parseFloat(val);
    return isNaN(n) ? null : n;
  };

  const toDate = (val) => {
    if (!val) return null;
    try {
      if (/^\d{10,13}$/.test(String(val))) {
        const ms = parseInt(val);
        const d = new Date(ms > 9999999999 ? ms : ms * 1000);
        if (isNaN(d.getTime())) return null;
        return d.toISOString().split('T')[0];
      }
      if (String(val).includes('-')) return String(val).split('T')[0];
      return null;
    } catch { return null; }
  };

  const mapProduct = (val) => {
    if (!val) return 'Hospital Indemnity';
    const v = String(val).toLowerCase();
    if (v.includes('cancer')) return 'Cancer';
    if (v.includes('dental') || v.includes('vision')) return 'Dental/Vision';
    if (v.includes('heart') || v.includes('stroke')) return 'Heart Attack/Stroke';
    if (v.includes('home health') || v.includes('home')) return 'Home Health';
    if (v.includes('life')) return 'Life Insurance';
    return 'Hospital Indemnity';
  };

  return {
    agent_id:            agentId,
    status:              'live',
    customer_first_name: str(contact.firstName),
    customer_last_name:  str(contact.lastName),
    customer_phone:      str(contact.phone),
    customer_email: (() => {
      const e = str(contact.email);
      return e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
    })(),
    customer_dob:          toDate(contact.dateOfBirth),
    customer_gender:       str(contact.gender),
    customer_street:       str(contact.address1),
    customer_city:         str(contact.city),
    customer_state:        str(contact.state),
    customer_postal_code:  str(contact.postalCode),
    product_type:          mapProduct(cf[cfg.ghl_field_product_type]),
    policy_number:         str(cf[cfg.ghl_field_policy_number]),
    carrier_name:          str(cf[cfg.ghl_field_carrier]),
    plan_name:             str(cf[cfg.ghl_field_plan_name]),
    monthly_premium:       num(cf[cfg.ghl_field_monthly_premium]),
    // annual_premium is a generated column — do not include
    effective_date:        toDate(cf[cfg.ghl_field_effective_date]),
    agent_email:           str(cf[cfg.ghl_field_agent_email]),
    banking_institution:   null,
    routing_number:        null,
    account_number:        null,
    mothers_maiden_name:   null,
    carrier_status:        null,
    submitted_at: (() => {
      if (contact.dateAdded) {
        const d = new Date(contact.dateAdded);
        if (!isNaN(d.getTime())) return d.toISOString();
      }
      return null;
    })(),
  };
}

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth removed — one-time import endpoint, delete after use
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  if (!GHL_API_KEY) return res.status(500).json({ error: 'GHL_API_KEY not configured' });

  const { pageToken: bodyPageToken = null, batchNum = 1 } = req.body || {};

  // Load GHL settings (includes cursor)
  const { data: settings } = await supabase.from('lb_settings').select('key, value').like('key', 'ghl_%');
  const cfg = {};
  (settings || []).forEach(s => { cfg[s.key] = s.value; });
  const locationId = cfg.ghl_location_id || 'j9qoEVXyaE55rXmQ7kLg';

  // Resume from stored cursor if no pageToken passed in request body
  const pageToken = bodyPageToken || cfg.ghl_import_cursor || null;

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

  // Resolve agent_id from custom field values
  // Returns { agentId, hasAgentFields }
  function resolveAgent(contact) {
    const cfMap = {};
    (contact.customFields || []).forEach(f => { cfMap[f.id] = f.value; });
    const firstFieldId = cfg.ghl_field_agent_first_name;
    const lastFieldId  = cfg.ghl_field_agent_last_name;
    const hasAgentFields = !!(firstFieldId && cfMap[firstFieldId]) || !!(lastFieldId && cfMap[lastFieldId]);
    const agentFirst = ((firstFieldId && cfMap[firstFieldId]) || '').trim();
    const agentLast  = ((lastFieldId  && cfMap[lastFieldId])  || '').trim();
    if (agentFirst && agentLast) {
      const ghlName = `${agentFirst} ${agentLast}`.trim().toLowerCase();
      const match = agents.find(a => a.name.trim().toLowerCase() === ghlName);
      if (match) return { agentId: match.id, hasAgentFields: true };
    }
    return { agentId: null, hasAgentFields };
  }

  const stats = { batchNum, fetched: contacts.length, imported: 0, skipped_duplicates: 0, skipped_unattributed: 0, errors: 0 };
  const unattributedSamples = [];
  const errorSamples = [];

  for (const contact of contacts) {
    // Skip contacts with no real name
    const firstName = (contact.firstName || '').trim();
    const lastName  = (contact.lastName  || '').trim();
    if ((!firstName && !lastName) || (firstName === 'null' && lastName === 'null')) continue;

    const { agentId, hasAgentFields } = resolveAgent(contact);

    // Skip silently if no agent fields present — not an enrollment contact
    if (!hasAgentFields) continue;

    if (!agentId) {
      stats.skipped_unattributed++;
      if (unattributedSamples.length < 3) {
        const cfMap = {};
        (contact.customFields || []).forEach(c => { cfMap[c.id] = c.value; });
        unattributedSamples.push({
          contact_name: `${firstName} ${lastName}`,
          agent_first_from_cf: cfg.ghl_field_agent_first_name ? cfMap[cfg.ghl_field_agent_first_name] : '(field id not set)',
          agent_last_from_cf:  cfg.ghl_field_agent_last_name  ? cfMap[cfg.ghl_field_agent_last_name]  : '(field id not set)',
        });
      }
      continue;
    }

    // Duplicate check: same first+last+phone+agent_id
    const { data: existing } = await supabase
      .from('lb_submissions')
      .select('id')
      .eq('customer_first_name', firstName)
      .eq('customer_last_name',  lastName)
      .eq('customer_phone',      contact.phone || '')
      .eq('agent_id',            agentId)
      .limit(1);
    if (existing && existing.length > 0) { stats.skipped_duplicates++; continue; }

    let record;
    try {
      record = buildRecord(contact, agentId, cfg);
    } catch (mapErr) {
      stats.errors++;
      if (errorSamples.length < 3) errorSamples.push({ stage: 'mapping', error: mapErr.message, contact: `${firstName} ${lastName}` });
      continue;
    }

    const { error: insertError } = await supabase.from('lb_submissions').insert(record);
    if (insertError) {
      console.error('Insert error:', JSON.stringify(insertError));
      stats.errors++;
      if (errorSamples.length < 3) {
        const cfRaw = {};
        (contact.customFields || []).forEach(f => { cfRaw[f.id] = { value: f.value, fieldValue: f.fieldValue }; });
        errorSamples.push({
          stage: 'insert',
          error: insertError.message,
          detail: insertError.details,
          hint: insertError.hint,
          product_type:    record.product_type,
          monthly_premium: record.monthly_premium,
          effective_date:  record.effective_date,
          submitted_at:    record.submitted_at,
          raw_premium_field: cfg.ghl_field_monthly_premium ? cfRaw[cfg.ghl_field_monthly_premium] : '(field id not set)',
        });
      }
      continue;
    }

    stats.imported++;
  }

  // Persist cursor — save next position or clear on completion
  console.log('Upserting cursor:', nextPageToken, 'SUPABASE_URL set:', !!SUPABASE_URL, 'SERVICE_KEY set:', !!SUPABASE_SERVICE_KEY);
  const { error: cursorErr } = await supabase
    .from('lb_settings')
    .upsert({ key: 'ghl_import_cursor', value: nextPageToken || null, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  console.log('Cursor upsert result:', cursorErr ? cursorErr.message : 'ok');

  return res.status(200).json({ ...stats, unattributedSamples, errorSamples, nextPageToken, cursor_saved: !cursorErr, cursor_error: cursorErr?.message || null });
}
