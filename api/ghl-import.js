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
  // Returns { agentId, hasAgentFields } — hasAgentFields=false means no agent fields present at all
  function resolveAgent(contact) {
    const cfMap = {};
    (contact.customFields || []).forEach(cf => { cfMap[cf.id] = cf.value; });
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

  // Helper: extract custom field value
  function cf(contact, settingKey) {
    const fieldId = cfg[settingKey];
    if (!fieldId) return null;
    const f = (contact.customFields || []).find(c => c.id === fieldId);
    return f ? f.value : null;
  }

  const stats = { batchNum, fetched: contacts.length, imported: 0, skipped_duplicates: 0, skipped_unattributed: 0, errors: 0 };
  const toInsert = [];
  const unattributedSamples = [];

  for (const contact of contacts) {
    try {
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
            ghl_field_agent_first_name_id: cfg.ghl_field_agent_first_name,
            ghl_field_agent_last_name_id: cfg.ghl_field_agent_last_name,
            agent_first_from_cf: cfg.ghl_field_agent_first_name ? cfMap[cfg.ghl_field_agent_first_name] : '(field id not set)',
            agent_last_from_cf: cfg.ghl_field_agent_last_name ? cfMap[cfg.ghl_field_agent_last_name] : '(field id not set)',
            all_custom_field_ids: Object.keys(cfMap),
          });
        }
        continue;
      }

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

      const clean = val => (val === '' || val === undefined) ? null : val;
      const mapProductType = val => {
        if (!val) return 'Hospital Indemnity';
        const v = val.toLowerCase();
        if (v.includes('cancer')) return 'Cancer';
        if (v.includes('dental') || v.includes('vision')) return 'Dental/Vision';
        if (v.includes('heart') || v.includes('stroke')) return 'Heart Attack/Stroke';
        if (v.includes('home health') || v.includes('home')) return 'Home Health';
        if (v.includes('life')) return 'Life Insurance';
        return 'Hospital Indemnity';
      };
      const toDateString = val => {
        if (!val) return null;
        if (typeof val === 'number' || (typeof val === 'string' && /^\d{10,13}$/.test(val))) {
          const ms = typeof val === 'number' ? val : parseInt(val);
          return new Date(ms > 9999999999 ? ms : ms * 1000).toISOString().split('T')[0];
        }
        if (typeof val === 'string' && val.includes('-')) return val.split('T')[0];
        return null;
      };
      toInsert.push({
        agent_id:              agentId,
        status:                'live',
        customer_first_name:   clean(contact.firstName),
        customer_last_name:    clean(contact.lastName),
        customer_phone:        clean(contact.phone),
        customer_email:        clean(contact.email),
        customer_dob:          toDateString(contact.dateOfBirth),
        customer_gender:       clean(contact.gender),
        customer_street:       clean(contact.address1),
        customer_city:         clean(contact.city),
        customer_state:        clean(contact.state),
        customer_postal_code:  clean(contact.postalCode),
        product_type:          mapProductType(cf(contact, 'ghl_field_product_type')),
        policy_number:         clean(cf(contact, 'ghl_field_policy_number')),
        carrier_name:          clean(cf(contact, 'ghl_field_carrier')),
        plan_name:             clean(cf(contact, 'ghl_field_plan_name')),
        monthly_premium:       parseFloat(cf(contact, 'ghl_field_monthly_premium') || '0') || null,
        effective_date:        toDateString(cf(contact, 'ghl_field_effective_date')),
        agent_email:           clean(cf(contact, 'ghl_field_agent_email')),
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

  const errorSamples = [];
  for (const record of toInsert) {
    const { error: insertErr } = await supabase.from('lb_submissions').insert(record);
    if (insertErr) {
      console.error('Insert error:', JSON.stringify(insertErr));
      stats.errors++;
      if (errorSamples.length < 3) {
        errorSamples.push({
          error: insertErr.message,
          error_detail: insertErr.details,
          error_hint: insertErr.hint,
          record_sample: {
            agent_id: record.agent_id,
            product_type: record.product_type,
            effective_date: record.effective_date,
            customer_dob: record.customer_dob,
            monthly_premium: record.monthly_premium,
            carrier_name: record.carrier_name,
          },
        });
      }
    } else {
      stats.imported++;
    }
  }

  return res.status(200).json({ ...stats, unattributedSamples, errorSamples, knownAgents: agents.map(a => a.name), nextPageToken });
}
