// api/ghl-import.js
// Processes one page of GHL contacts per request to avoid Vercel timeouts.
// Client chains requests using nextPageToken until null.
// Routes contacts to lb_submissions (ancillary) or lb_mapd_submissions (MAPD).
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

// Shared helpers — defined at module scope so both builders can use them
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

const submittedAt = (contact) => {
  if (contact.dateAdded) {
    const d = new Date(contact.dateAdded);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return null;
};

const safeEmail = (val) => {
  const e = str(val);
  return e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
};

// Detect whether a contact is a MAPD enrollment, ancillary enrollment, or neither.
// Import ALL contacts with a real name and any custom fields — only skip obvious non-persons.
function detectContactType(contact, cfg) {
  const firstName = (contact.firstName || '').trim().toLowerCase();
  const lastName  = (contact.lastName  || '').trim().toLowerCase();

  if (!firstName && !lastName) return 'unknown';
  if (firstName === 'null' || lastName === 'null') return 'unknown';

  const nonPersonKeywords = [
    'aetna', 'humana', 'uhc', 'unitedhealthcare', 'united health',
    'care plus', 'careplus', 'test', 'medicare', 'medicaid',
    'insurance', 'agency', 'health plan', 'blue cross', 'cigna',
    'molina', 'centene', 'wellcare', 'bcbs', 'anthem',
  ];
  const fullName = `${firstName} ${lastName}`;
  if (nonPersonKeywords.some(kw => fullName.includes(kw))) return 'unknown';

  const presentFieldIds = new Set((contact.customFields || []).map(f => f.id));

  const mapdFieldIds = [
    cfg.ghl_field_medicare_number,
    cfg.ghl_field_medicare_part_a,
    cfg.ghl_field_medicare_part_b,
    cfg.ghl_field_plan_code,
    cfg.ghl_field_app_submit_date,
    cfg.ghl_field_sunfire_date,
    cfg.ghl_field_on_medicaid,
    cfg.ghl_field_medicaid_number,
  ].filter(Boolean);

  if (mapdFieldIds.some(id => presentFieldIds.has(id))) return 'mapd';
  if (cfg.ghl_field_monthly_premium && presentFieldIds.has(cfg.ghl_field_monthly_premium)) return 'ancillary';

  // Default — historical data is predominantly MAPD before the switch to ancillary
  if (presentFieldIds.size > 0) return 'mapd';

  return 'unknown';
}

function buildRecord(contact, agentId, cfg) {
  const cf = {};
  (contact.customFields || []).forEach(f => { cf[f.id] = f.fieldValue; });

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
    agent_id:              agentId,
    status:                'live',
    ghl_contact_id:        contact.id || null,
    submitted_at:          submittedAt(contact),
    customer_first_name:   str(contact.firstName),
    customer_last_name:    str(contact.lastName),
    customer_phone:        str(contact.phone),
    customer_email:        safeEmail(contact.email),
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
  };
}

function buildMAPDRecord(contact, agentId, cfg) {
  const cf = {};
  (contact.customFields || []).forEach(f => { cf[f.id] = f.fieldValue; });

  return {
    agent_id:              agentId,
    status:                'live',
    ghl_contact_id:        contact.id || null,
    submitted_at:          submittedAt(contact),
    app_submit_date:       toDate(cf[cfg.ghl_field_app_submit_date]),
    sunfire_confirm_date:  toDate(cf[cfg.ghl_field_sunfire_date]),
    carrier_name:          str(cf[cfg.ghl_field_carrier]),
    plan_name:             str(cf[cfg.ghl_field_plan_name]),
    plan_code:             str(cf[cfg.ghl_field_plan_code]),
    effective_date:        toDate(cf[cfg.ghl_field_effective_date]),
    agent_npn:             null,
    agent_first_name:      str(cf[cfg.ghl_field_agent_first_name]),
    agent_last_name:       str(cf[cfg.ghl_field_agent_last_name]),
    customer_first_name:   str(contact.firstName),
    customer_last_name:    str(contact.lastName),
    customer_dob:          toDate(contact.dateOfBirth),
    customer_gender:       str(contact.gender),
    customer_phone:        str(contact.phone),
    customer_email:        safeEmail(contact.email),
    customer_street:       str(contact.address1),
    customer_city:         str(contact.city),
    customer_state:        str(contact.state),
    customer_postal_code:  str(contact.postalCode),
    medicare_number:       str(cf[cfg.ghl_field_medicare_number]),
    medicare_part_a_date:  toDate(cf[cfg.ghl_field_medicare_part_a]),
    medicare_part_b_date:  toDate(cf[cfg.ghl_field_medicare_part_b]),
    is_on_medicaid:        !!cf[cfg.ghl_field_on_medicaid],
    medicaid_number:       str(cf[cfg.ghl_field_medicaid_number]),
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
  console.log('Cursor in lb_settings:', JSON.stringify(cfg.ghl_import_cursor), 'bodyPageToken:', JSON.stringify(bodyPageToken));
  const pageToken = bodyPageToken || cfg.ghl_import_cursor || null;
  console.log('Effective pageToken:', JSON.stringify(pageToken));

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

  const stats = {
    batchNum,
    fetched: contacts.length,
    imported_ancillary: 0,
    imported_mapd: 0,
    skipped_duplicates: 0,
    skipped_unattributed: 0,
    skipped_no_name: 0,
    skipped_non_enrollment: 0,
    errors: 0,
  };
  const unattributedSamples = [];
  const nonEnrollmentSamples = [];
  const errorSamples = [];

  for (const contact of contacts) {
    // Skip contacts with no real name
    const firstName = (contact.firstName || '').trim();
    const lastName  = (contact.lastName  || '').trim();
    if ((!firstName && !lastName) || (firstName === 'null' && lastName === 'null')) { stats.skipped_no_name++; continue; }

    const contactType = detectContactType(contact, cfg);

    if (contactType === 'unknown') {
      stats.skipped_non_enrollment++;
      if (nonEnrollmentSamples.length < 3) {
        nonEnrollmentSamples.push({
          contact_name: `${firstName} ${lastName}`,
          custom_field_ids: (contact.customFields || []).map(f => f.id),
          custom_field_values: (contact.customFields || []).map(f => ({ id: f.id, value: f.fieldValue })),
        });
      }
      continue;
    }

    const { agentId, hasAgentFields } = resolveAgent(contact);

    if (!agentId) {
      stats.skipped_unattributed++;
      if (unattributedSamples.length < 3) {
        const cfMap = {};
        (contact.customFields || []).forEach(c => { cfMap[c.id] = c.value; });
        unattributedSamples.push({
          contact_name:        `${firstName} ${lastName}`,
          contact_type:        contactType,
          agent_first_from_cf: cfg.ghl_field_agent_first_name ? cfMap[cfg.ghl_field_agent_first_name] : '(field id not set)',
          agent_last_from_cf:  cfg.ghl_field_agent_last_name  ? cfMap[cfg.ghl_field_agent_last_name]  : '(field id not set)',
        });
      }
      continue;
    }

    // Duplicate check in the correct table
    const tableName = contactType === 'mapd' ? 'lb_mapd_submissions' : 'lb_submissions';
    if (contact.id) {
      const { data: existing } = await supabase
        .from(tableName)
        .select('id')
        .eq('ghl_contact_id', contact.id)
        .single();
      if (existing) { stats.skipped_duplicates++; continue; }
    }

    let record;
    try {
      record = contactType === 'mapd'
        ? buildMAPDRecord(contact, agentId, cfg)
        : buildRecord(contact, agentId, cfg);
    } catch (mapErr) {
      stats.errors++;
      if (errorSamples.length < 3) errorSamples.push({ stage: 'mapping', type: contactType, error: mapErr.message, contact: `${firstName} ${lastName}` });
      continue;
    }

    const { error: insertError } = await supabase.from(tableName).insert(record);
    if (insertError) {
      console.error('Insert error:', JSON.stringify(insertError));
      stats.errors++;
      if (errorSamples.length < 3) {
        errorSamples.push({
          stage:  'insert',
          type:   contactType,
          table:  tableName,
          error:  insertError.message,
          detail: insertError.details,
          hint:   insertError.hint,
        });
      }
      continue;
    }

    if (contactType === 'mapd') stats.imported_mapd++;
    else stats.imported_ancillary++;
  }

  // Persist cursor — save next position or clear on completion
  console.log('Upserting cursor:', nextPageToken, 'SUPABASE_URL set:', !!SUPABASE_URL, 'SERVICE_KEY set:', !!SUPABASE_SERVICE_KEY);
  const { error: cursorErr } = await supabase
    .from('lb_settings')
    .upsert({ key: 'ghl_import_cursor', value: nextPageToken || null, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  console.log('Cursor upsert result:', cursorErr ? cursorErr.message : 'ok');

  return res.status(200).json({ ...stats, unattributedSamples, nonEnrollmentSamples, errorSamples, nextPageToken, cursor_read_value: cfg.ghl_import_cursor || null, cursor_saved: !cursorErr, cursor_error: cursorErr?.message || null });
}
