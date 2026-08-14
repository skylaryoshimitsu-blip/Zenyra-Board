// api/ghl-push.js
import { createClient } from '@supabase/supabase-js';

const GHL_API_KEY        = process.env.GHL_API_KEY;
const SUPABASE_URL       = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ALLOWED_ORIGIN     = process.env.ALLOWED_ORIGIN || '*';

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { submission } = req.body || {};
  if (!submission) return res.status(400).json({ error: 'submission required' });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data: settings } = await supabase
    .from('lb_settings')
    .select('key, value')
    .like('key', 'ghl_%');

  const cfg = {};
  (settings || []).forEach(s => { cfg[s.key] = s.value; });

  if (cfg.ghl_enabled !== 'true') {
    return res.status(200).json({ ok: true, skipped: 'ghl_not_enabled' });
  }

  if (!GHL_API_KEY) {
    return res.status(500).json({ error: 'GHL_API_KEY not configured' });
  }

  const customFields = [];
  const fieldMap = {
    ghl_field_agent_email:       submission.agent_email,
    ghl_field_agent_first_name:  submission.agent_first_name,
    ghl_field_agent_last_name:   submission.agent_last_name,
    // ghl_field_product_type removed — GHL dropdown requires exact option match
    ghl_field_carrier:           submission.carrier_name,
    ghl_field_plan_name:         submission.plan_name,
    ghl_field_annual_premium:    String(submission.annual_premium || ''),
    ghl_field_monthly_premium:   String(submission.monthly_premium || ''),
    ghl_field_effective_date:    submission.effective_date || '',
    ghl_field_policy_number:     submission.policy_number || '',
  };

  Object.entries(fieldMap).forEach(([settingKey, value]) => {
    const fieldId = cfg[settingKey];
    if (fieldId && value !== null && value !== undefined && value !== '') {
      const cleanValue = typeof value === 'string' ? value : String(value);
      customFields.push({ id: fieldId, value: cleanValue });
    }
  });

  const contactPayload = {
    locationId: cfg.ghl_location_id || 'j9qoEVXyaE55rXmQ7kLg',
    firstName:  submission.customer_first_name || '',
    lastName:   submission.customer_last_name || '',
    phone:      submission.customer_phone || '',
    address1:   submission.customer_street || '',
    city:       submission.customer_city || '',
    state:      submission.customer_state || '',
    postalCode: submission.customer_postal_code || '',
    tags: ['zenyra-enrollment', submission.product_type || '', submission.carrier_name || ''].filter(Boolean),
    customFields,
    source: 'Zenyra Board',
  };

  // Only include email if valid — GHL rejects empty or malformed email
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (submission.customer_email && emailRegex.test(submission.customer_email)) {
    contactPayload.email = submission.customer_email;
  }
  // Only include typed fields if non-empty — GHL may reject empty strings
  if (submission.customer_dob) contactPayload.dateOfBirth = submission.customer_dob;
  if (submission.customer_gender) contactPayload.gender = submission.customer_gender;

  try {
    const ghlRes = await fetch('https://services.leadconnectorhq.com/contacts/', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Content-Type': 'application/json',
        'Version': '2021-07-28',
      },
      body: JSON.stringify(contactPayload),
    });

    const ghlData = await ghlRes.json();

    if (!ghlRes.ok) {
      // Return 200 — GHL failure must never block a Zenyra submission
      return res.status(200).json({ ok: false, ghl_status: ghlRes.status, ghl_error: ghlData });
    }

    return res.status(200).json({ ok: true, ghl_status: ghlRes.status, ghl_contact_id: ghlData.contact?.id });
  } catch (err) {
    console.error('GHL push error:', err);
    // Non-blocking — always return 200
    return res.status(200).json({ ok: false, error: err.message });
  }
}
