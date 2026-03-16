# 🌴 Tulum Trip Planner

Plan your Tulum trip with an interactive map, flight lookup, travel time calculations, and day-by-day itinerary.

## Features

- **Interactive Map** — Leaflet map with numbered stop markers, route lines, Tulum & CUN airport pins
- **Address Geocoding** — Type any address, auto-resolves to coordinates via Nominatim
- **Travel Time Calculation** — Auto-calculates travel time between stops via OSRM routing (walk, bike, car, taxi, scooter, colectivo)
- **Flight Lookup** — Enter airline + flight number, auto-populates route, times, airports (requires Anthropic API key)
- **Trip Variations** — Create multiple trip versions, duplicate and compare
- **Drag-to-Reorder** — Reorder stops within a day, map updates to reflect sequence
- **Persistent Storage** — Data saved to localStorage

## Quick Start

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173)

## Deploy to Vercel

1. Push to GitHub
2. Import in [vercel.com](https://vercel.com)
3. Add environment variable: `ANTHROPIC_API_KEY` = your key
4. Deploy

The flight lookup uses a Vercel serverless function (`/api/flight-lookup.js`) that proxies to the Anthropic API. Without the API key, flight lookup won't work but everything else will.

## Project Structure

```
├── api/
│   └── flight-lookup.js    # Vercel serverless function for flight API
├── src/
│   ├── App.jsx             # Main app component
│   └── main.jsx            # React entry point
├── index.html
├── package.json
└── vite.config.js
```

## Tech Stack

- React 18 + Vite
- Leaflet (map)
- Nominatim (geocoding)
- OSRM (routing / travel time)
- Anthropic Claude API (flight lookup)
