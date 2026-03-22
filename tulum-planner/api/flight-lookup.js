export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
  try {
    const { airline, flightNo, date } = req.body;
    const ds = date ? new Date(date+'T12:00:00').toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'}) : '';
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key':apiKey, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({
        model:'claude-sonnet-4-20250514', max_tokens:1000,
        tools:[{type:'web_search_20250305',name:'web_search'}],
        messages:[{role:'user',content:`Look up ${airline} flight ${flightNo}${ds?` on ${ds}`:''}.
Search for "${airline} flight ${flightNo} route schedule".
RULES: Only VERIFIED data. Airline MUST be "${airline}". Flight# MUST be "${flightNo}". If not found return {"error":"not found"}.
Return ONLY JSON: {"airline":"${airline}","flightNumber":"${flightNo}","departureAirport":"IATA","departureCity":"...","departureTime":"HH:MM","arrivalAirport":"IATA","arrivalCity":"...","arrivalTime":"HH:MM","departureCoords":{"lat":0,"lng":0},"arrivalCoords":{"lat":0,"lng":0}}`}],
      }),
    });
    const data = await r.json();
    const text = data.content?.map(c=>c.text||'').join('')||'';
    const match = text.replace(/```json|```/g,'').match(/\{[\s\S]*\}/);
    if (match) { const p=JSON.parse(match[0]); if(!p.error) return res.status(200).json(p); }
    return res.status(404).json({error:'Flight not found'});
  } catch(e) { console.error(e); return res.status(500).json({error:'Lookup failed'}); }
}
