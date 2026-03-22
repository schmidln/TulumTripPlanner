export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  
  const GMAPS_KEY = process.env.VITE_GOOGLE_MAPS_KEY || "AIzaSyDs3SBHq2KvtCg2e3afj0C3bWKqzJXWTYI";
  
  try {
    const { fromLat, fromLng, toLat, toLng, mode } = req.body;
    if (!fromLat || !toLat) return res.status(400).json({ error: 'Missing coordinates' });

    const travelMode = mode || 'driving';
    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${fromLat},${fromLng}&destination=${toLat},${toLng}&mode=${travelMode}&key=${GMAPS_KEY}`;
    
    const r = await fetch(url);
    const d = await r.json();
    
    if (d.status === 'OK' && d.routes?.length) {
      const leg = d.routes[0].legs[0];
      return res.status(200).json({
        duration: leg.duration.value,
        durationText: leg.duration.text,
        distance: leg.distance.value,
        distanceText: leg.distance.text,
      });
    }
    
    return res.status(404).json({ error: 'No route found', status: d.status });
  } catch (e) {
    console.error('Directions error:', e);
    return res.status(500).json({ error: 'Directions failed' });
  }
}
