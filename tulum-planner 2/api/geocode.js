export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
  try {
    const { address } = req.body;
    if (!address) return res.status(400).json({ error: 'No address provided' });

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key':apiKey, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({
        model:'claude-sonnet-4-20250514', max_tokens:300,
        messages:[{role:'user',content:`What are the exact GPS coordinates (latitude, longitude) of this address: "${address}"? Return ONLY JSON: {"lat":20.xxxxx,"lng":-87.xxxxx}. Be precise to 5 decimal places.`}],
      }),
    });
    const data = await r.json();
    const text = data.content?.map(c=>c.text||'').join('')||'';
    const match = text.replace(/```json|```/g,'').match(/\{[^}]+\}/);
    if (match) {
      const p = JSON.parse(match[0]);
      if (p.lat && p.lng) return res.status(200).json({ lat: +p.lat.toFixed(5), lng: +p.lng.toFixed(5) });
    }
    return res.status(404).json({ error: 'Could not geocode' });
  } catch(e) { console.error(e); return res.status(500).json({ error: 'Geocode failed' }); }
}
