# 🌴 Tulum Trip Planner

Collaborative trip planner with real-time sync via Firebase. Share a link — everyone sees the same trip, live.

## Setup

```bash
npm install
npm run dev
```

## Deploy to Vercel

1. Push to GitHub
2. Import in [vercel.com](https://vercel.com)
3. (Optional) Add `ANTHROPIC_API_KEY` env var for flight auto-lookup
4. Deploy

## Firebase Setup (already configured)

- Firestore database in production mode
- Rules set to allow all reads/writes (fun app, no auth)
- Config is in `src/firebase.js`

## How Sharing Works

1. Create a trip on the home page
2. Copy the URL from your browser (or click "Copy link")
3. Send to friends — they open it and can edit the same trip
4. Changes sync in real-time via Firestore `onSnapshot`

## Features

- 🗺️ Interactive Leaflet map with numbered stops + route lines
- 📍 Address auto-geocoding (Nominatim)
- ⏱️ Auto travel time calculation (OSRM routing — walk/bike/car/taxi/scooter/colectivo)
- ✈️ Flight lookup via Anthropic API + web search
- 🔀 Drag-to-reorder stops
- 🏠 Homebase with check-in/out dates + times
- 🔗 Real-time collaborative editing via Firebase
