// api/ghl-fields.js — temporary diagnostic tool, remove after field IDs are configured
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const GHL_API_KEY = process.env.GHL_API_KEY;
  const LOCATION_ID = 'j9qoEVXyaE55rXmQ7kLg';

  if (!GHL_API_KEY) {
    return res.status(500).json({ error: 'GHL_API_KEY not set' });
  }

  try {
    const response = await fetch(
      `https://services.leadconnectorhq.com/locations/${LOCATION_ID}/customFields`,
      {
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Version': '2021-07-28',
          'Content-Type': 'application/json',
        }
      }
    );

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
