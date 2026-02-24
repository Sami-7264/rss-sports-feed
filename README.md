# RSS Sports Ticker

High-resolution RSS sports ticker with PNG images, designed for **NovaStar media players** and LED displays.

Each game is rendered as a broadcast-style ticker image and served via an RSS 2.0 feed with `<enclosure>` tags pointing to the PNG URLs.

## Quick Start

```bash
npm install
npm run dev
```

Open in your browser:

| Endpoint | URL |
|---|---|
| **Preview page** | http://localhost:3000/preview |
| **RSS feed** | http://localhost:3000/rss.xml |
| **Health check** | http://localhost:3000/health |
| **Single image** | http://localhost:3000/images/nba-phi-chi-20260224.png |

## Prerequisites

- **Node.js** >= 18
- **npm** >= 9
- **canvas** system dependencies (usually pre-built binaries work out of the box):
  - macOS: `brew install pkg-config cairo pango libpng jpeg giflib librsvg pixman`
  - Ubuntu/Debian: `sudo apt-get install build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev`
  - Windows: See [node-canvas wiki](https://github.com/Automattic/node-canvas/wiki/Installation:-Windows)

## Configuration

All settings are in [`src/config.ts`](src/config.ts).

### Change Resolution

Edit the `display` section:

```ts
display: {
  width: 384,      // target output width in pixels
  height: 192,     // target output height in pixels
  scaleFactor: 2,  // render at 2x then downscale (sharper on LED)
}
```

For a 5ft/6ft LED display, increase to `768x384` or higher:

```ts
display: {
  width: 768,
  height: 384,
  scaleFactor: 2,  // renders at 1536x768, outputs 768x384
}
```

Adjust font sizes proportionally in the `fonts` section when changing resolution.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` | Bind address |
| `BASE_URL` | `http://localhost:3000` | Public URL for RSS enclosure links |
| `DATA_PROVIDER` | `mock` | `mock` or `api` |
| `SPORTS_API_KEY` | _(empty)_ | API key for live sports data |

## Adding Teams / Logos / Colors

Edit [`data/mockGames.json`](data/mockGames.json):

```json
{
  "id": "nba-phi-chi-20260224",
  "league": "NBA",
  "home": {
    "name": "Chicago Bulls",
    "abbr": "CHI",
    "color": "#CE1141",
    "record": "5-3",
    "logoUrl": "https://example.com/chi-logo.png"
  },
  "away": { ... },
  "score": { "home": 113, "away": 111 },
  "status": { "state": "in_progress", "period": 4, "clock": "3:52" },
  "updatedAt": "2026-02-24T20:30:00Z"
}
```

- **`color`**: hex color for the team (used for name text and accent bars)
- **`logoUrl`**: URL to a PNG/JPG logo image. Leave empty `""` for a fallback circle with the team abbreviation.
- **`record`**: optional win-loss record shown below the team abbreviation
- Logos are cached to `./storage/logos/` after first download.

### Game Status States

| `state` | Meaning | Display |
|---|---|---|
| `pre` | Pre-game / scheduled | Shows "VS" and scheduled time |
| `in_progress` | Live | Shows scores, period, clock, "LIVE" badge |
| `final` | Completed | Shows final scores, "FINAL" badge |

## Switching to a Real Sports API

1. Set `DATA_PROVIDER=api` in your environment (or edit `config.ts`)
2. Set `SPORTS_API_KEY=your_key`
3. Edit [`src/dataProviders/apiProvider.ts`](src/dataProviders/apiProvider.ts):
   - Implement the `fetchGames()` method to call your API
   - Map the API response to the `Game[]` interface defined in `src/types.ts`
4. The rest of the pipeline (rendering, RSS, caching) works automatically

Compatible APIs include ESPN, SportsData.io, The Sports DB, or any source you can map to the `Game` interface.

## How to Share a Test Link with Client

To let a client test the RSS feed on their NovaStar LED player remotely, expose your local server via a tunnel:

### Option A: ngrok (recommended)

```bash
# Install (once)
npm install -g ngrok
# Or: brew install ngrok

# Start the tunnel (while your dev server is running)
ngrok http 3000
```

ngrok will print a public URL like `https://a1b2c3d4.ngrok-free.app`. Give the client:

```
RSS Feed:  https://a1b2c3d4.ngrok-free.app/rss.xml
Preview:   https://a1b2c3d4.ngrok-free.app/preview
```

**Important:** Update `BASE_URL` so the RSS enclosure image URLs point to the public address:

```bash
BASE_URL=https://a1b2c3d4.ngrok-free.app npm run dev
```

### Option B: Cloudflare Tunnel

```bash
# Install (once)
brew install cloudflared

# Start the tunnel
cloudflared tunnel --url http://localhost:3000
```

Same idea — use the printed URL as `BASE_URL` and give it to the client.

### Option C: Local network

If the client's NovaStar player is on the same LAN:

```bash
# Find your local IP
ifconfig | grep "inet " | grep -v 127.0.0.1

# Start with that as the base URL
BASE_URL=http://192.168.1.100:3000 npm run dev
```

Give the client: `http://192.168.1.100:3000/rss.xml`

## NovaStar Integration

1. Run the server on a machine accessible to the NovaStar player
2. Set `BASE_URL` to the server's network address (e.g., `http://192.168.1.100:3000`)
3. In NovaStar software, add an RSS media source pointing to `http://<server>:3000/rss.xml`
4. The player will fetch the feed and display the `<enclosure>` PNG images

## Project Structure

```
rss-sports-feed/
├── src/
│   ├── server.ts                 # Express server + orchestration
│   ├── config.ts                 # All configurable settings
│   ├── types.ts                  # TypeScript interfaces
│   ├── dataProviders/
│   │   ├── mockProvider.ts       # Reads from mockGames.json
│   │   └── apiProvider.ts        # Live API provider (stub)
│   ├── render/
│   │   └── renderTicker.ts       # Canvas-based image renderer
│   ├── rss/
│   │   └── generateRss.ts        # RSS 2.0 XML generator
│   └── utils/
│       ├── cache.ts              # Image cache (memory + disk)
│       └── logoCache.ts          # Team logo downloader/cache
├── data/
│   └── mockGames.json            # Sample game data (3 games)
├── storage/
│   ├── images/                   # Generated PNG cache
│   └── logos/                    # Downloaded logo cache
├── package.json
├── tsconfig.json
└── README.md
```

## How It Works

1. **Data fetch**: The configured provider (mock or API) returns a `Game[]` array
2. **Rendering**: Each game is drawn onto a `node-canvas` surface as a broadcast-style ticker
3. **Caching**: Generated PNGs are cached in memory and on disk; only regenerated when data changes
4. **RSS feed**: An RSS 2.0 XML document is generated with `<enclosure>` tags pointing to each image URL
5. **Auto-refresh**: A background interval re-fetches data and regenerates stale images every 60 seconds

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start with auto-reload (tsx watch) |
| `npm start` | Start without auto-reload |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run serve` | Run compiled JS from `dist/` |
