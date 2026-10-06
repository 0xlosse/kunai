# KUNAI

A shinobi card game with bluffing, character skills, bots and online rooms.

## Run locally

```bash
npm install
npm start          # http://localhost:3000
```

## Deploy on Railway

1. railway.com/new → **Deploy from GitHub repo** → pick this repo.
2. Railway detects Node and runs `npm start`. No variables needed (`PORT` is set by Railway).
3. Settings → Networking → **Generate Domain**. Open it and play.

## How it works

- `server.js` serves the game and runs every online room. The server holds the deck and all hands, checks every move and only sends each player their own cards.
- `shared/engine.js` holds the rules, bots and skills. The server and the browser use the same file.
- `public/index.html` is the game client. Solo games against bots run fully in the browser.
- Rooms use a 4-letter code and an invite link (`/?room=ABCD`). A player who drops has 45 seconds to come back before a bot takes the seat; reopening the link reclaims it.
