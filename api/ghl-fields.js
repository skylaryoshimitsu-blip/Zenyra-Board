// api/ghl-fields.js — temporary tool: fetches GHL custom fields and writes matched IDs to lb_settings
// Remove after field IDs are retrieved and confirmed in the Integrations panel
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const GHL_API_KEY        = process.env.GHL_API_KEY;
  const SUPABASE_URL       = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const LOCATION_ID        = 'j9qoEVXyaE55rXmQ7kLg';

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    const response = await fetch(
      `https://services.leadconnectorhq.com/locations/${LOCATION_ID}/customFields`,
      {
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Version': '2021-07-28',
        }
      }
    );

    const data = await response.json();
    const fields = data.customFields || [];

    const matchMap = [
      { key: 'ghl_field_agent_email',      keywords: ['agent email', 'sales agent | email', 'agent_email'] },
      { key: 'ghl_field_agent_first_name', keywords: ['agent first', 'agent_first'] },
      { key: 'ghl_field_agent_last_name',  keywords: ['agent last', 'agent_last'] },
      { key: 'ghl_field_product_type',     keywords: ['product type', 'product_type', 'ancillary product'] },
      { key: 'ghl_field_carrier',          keywords: ['carrier', 'carrier name'] },
      { key: 'ghl_field_plan_name',        keywords: ['plan name', 'plan_name', 'cmsplanname'] },
      { key: 'ghl_field_annual_premium',   keywords: ['annual premium', 'annual_premium', 'annual ap'] },
      { key: 'ghl_field_monthly_premium',  keywords: ['monthly premium', 'monthly_premium', 'ancillary product monthly'] },
      { key: 'ghl_field_effective_date',   keywords: ['effective date', 'effective_date'] },
      { key: 'ghl_field_policy_number',    keywords: ['policy number', 'policy_number'] },
      { key: 'ghl_field_medicare_number',  keywords: ['medicare number', 'medicare_number', 'medicare id'] },
      { key: 'ghl_field_medicare_part_a',  keywords: ['part a', 'part_a', 'medicare part a'] },
      { key: 'ghl_field_medicare_part_b',  keywords: ['part b', 'part_b', 'medicare part b'] },
      { key: 'ghl_field_sunfire_date',     keywords: ['sunfire', 'confirmation date', 'sunfire_confirm'] },
      { key: 'ghl_field_plan_code',        keywords: ['plan code', 'plan_code'] },
      { key: 'ghl_field_on_medicaid',      keywords: ['medicaid', 'on medicaid', 'is_medicaid'] },
      { key: 'ghl_field_medicaid_number',  keywords: ['medicaid number', 'medicaid_number', 'medicaid id'] },
      { key: 'ghl_field_app_submit_date',  keywords: ['app submit', 'application submit', 'submit date'] },
    ];

    const results = {};
    for (const field of fields) {
      const nameLower = (field.name || '').toLowerCase();
      const keyLower  = (field.fieldKey || '').toLowerCase();
      for (const mapping of matchMap) {
        if (!results[mapping.key] && mapping.keywords.some(kw => nameLower.includes(kw) || keyLower.includes(kw))) {
          results[mapping.key] = { id: field.id, name: field.name };
        }
      }
    }

    const updates = [];
    for (const [settingKey, match] of Object.entries(results)) {
      const { error } = await supabase
        .from('lb_settings')
        .update({ value: match.id, updated_at: new Date().toISOString() })
        .eq('key', settingKey);
      updates.push({ setting: settingKey, matched_name: match.name, id: match.id, saved: !error, error: error?.message });
    }

    const unmatched = matchMap.filter(m => !results[m.key]).map(m => m.key);

    return res.status(200).json({
      saved: updates,
      unmatched,
      total_ghl_fields: fields.length,
      all_fields: fields.map(f => ({ id: f.id, name: f.name, fieldKey: f.fieldKey })),
      message: `Matched and saved ${updates.length} field IDs to lb_settings. ${unmatched.length} fields need manual configuration.`,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
