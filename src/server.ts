import express from 'express';
import { config } from './config';
import { ImageCache } from './utils/cache';
import { LogoCache } from './utils/logoCache';
import { MockProvider } from './dataProviders/mockProvider';
import { ApiProvider } from './dataProviders/apiProvider';
import { renderTickerImage } from './render/renderTicker';
import { generateRss } from './rss/generateRss';
import { Game, DataProvider } from './types';

// ── State ──────────────────────────────────────────────────────────────
let currentGames: Game[] = [];
let lastUpdate = new Date();
let refreshCount = 0;

const imageCache = new ImageCache(config.storage.imagesDir, config.cache.imageTtlMs);
const logoCache = new LogoCache(config.storage.logosDir);

function createProvider(): DataProvider {
  if (config.dataProvider === 'api') {
    return new ApiProvider();
  }
  return new MockProvider();
}

const provider = createProvider();

// ── Data refresh logic ─────────────────────────────────────────────────
async function refreshData(): Promise<void> {
  try {
    const games = await provider.fetchGames();
    let regenerated = 0;

    for (const game of games) {
      const dataHash = game.updatedAt;
      if (imageCache.isStale(game.id, dataHash)) {
        const buffer = await renderTickerImage(game, logoCache);
        await imageCache.set(game.id, buffer, dataHash);
        regenerated++;
      }
    }

    currentGames = games;
    lastUpdate = new Date();
    refreshCount++;

    if (regenerated > 0) {
      console.log(
        `[Refresh #${refreshCount}] Regenerated ${regenerated}/${games.length} images at ${lastUpdate.toISOString()}`
      );
    } else {
      console.log(
        `[Refresh #${refreshCount}] ${games.length} games up-to-date at ${lastUpdate.toISOString()}`
      );
    }
  } catch (err) {
    console.error('[Refresh] Failed to refresh data:', err);
  }
}

// ── Lazy initialization (for serverless cold starts) ───────────────────
let initialized = false;

async function ensureInitialized(): Promise<void> {
  if (initialized) return;
  console.log('Initializing RSS Sports Ticker...');
  console.log(`  Provider:    ${config.dataProvider}`);
  console.log(`  Resolution:  ${config.display.width}x${config.display.height} (${config.display.scaleFactor}x render)`);
  console.log(`  Environment: ${config.isVercel ? 'Vercel (serverless)' : 'local'}`);
  await imageCache.initialize();
  await logoCache.initialize();
  await refreshData();
  initialized = true;
}

// ── Express app ────────────────────────────────────────────────────────
const app = express();

// Init middleware — ensures data/images are ready before handling requests
app.use(async (_req, _res, next) => {
  try {
    await ensureInitialized();
  } catch (err) {
    console.error('[Init] Failed:', err);
  }
  next();
});

// RSS feed
app.get('/rss.xml', (req, res) => {
  // Use the actual request host so image URLs work regardless of VERCEL_URL
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const requestBaseUrl = `${protocol}://${host}`;
  const xml = generateRss(currentGames, requestBaseUrl);
  res.set({
    'Content-Type': 'application/rss+xml; charset=utf-8',
    'Cache-Control': 'public, max-age=30',
  });
  res.send(xml);
});

// Ticker images (cached path — used by preview page)
app.get('/images/:id.png', async (req, res) => {
  const id = req.params.id;
  const buffer = imageCache.get(id);
  if (buffer) {
    res.set({
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=30',
    });
    res.send(buffer);
    return;
  }

  // Try disk fallback
  const diskBuffer = await imageCache.loadFromDisk(id);
  if (diskBuffer) {
    res.set({ 'Content-Type': 'image/png' });
    res.send(diskBuffer);
    return;
  }

  res.status(404).json({ error: 'Image not found', id });
});

// On-demand image endpoint — renders fresh, no cache dependency
// This is what the RSS feed points to, so NovaStar always gets a valid PNG
app.get('/api/image', async (req, res) => {
  const id = req.query.id as string;
  if (!id) {
    res.status(400).set('Content-Type', 'text/plain').send('Missing id parameter');
    return;
  }

  // Try in-memory cache first (fast path)
  const cached = imageCache.get(id);
  if (cached) {
    res.set({
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=30',
    });
    res.send(cached);
    return;
  }

  // Render on-demand — find the game and generate the image
  const game = currentGames.find((g) => g.id === id);
  if (!game) {
    res.status(404).set('Content-Type', 'text/plain').send('Game not found');
    return;
  }

  try {
    const buffer = await renderTickerImage(game, logoCache);
    // Cache it for subsequent requests
    await imageCache.set(game.id, buffer, game.updatedAt);
    res.set({
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=30',
    });
    res.send(buffer);
  } catch (err) {
    console.error(`[Image] Failed to render ${id}:`, err);
    res.status(500).set('Content-Type', 'text/plain').send('Failed to render image');
  }
});

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    lastUpdate: lastUpdate.toISOString(),
    gamesCount: currentGames.length,
    refreshCount,
    config: {
      display: `${config.display.width}x${config.display.height}`,
      scaleFactor: config.display.scaleFactor,
      provider: config.dataProvider,
      refreshIntervalMs: config.cache.refreshIntervalMs,
    },
  });
});

// Preview page — HTML with rendered ticker images at 1x and 2x zoom
app.get('/preview', (_req, res) => {
  const { width, height, scaleFactor } = config.display;
  const rssUrl = `${config.server.baseUrl}/rss.xml`;

  const gameCards = currentGames
    .map(
      (g) => `
      <div class="ticker-group">
        <div class="ticker-label">
          <span class="id">${g.id}</span>
          <span class="badge ${g.status.state}">${g.status.state.replace('_', ' ').toUpperCase()}</span>
        </div>
        <div class="preview-row">
          <div class="preview-col">
            <label>1&times; Actual LED size (${width}&times;${height})</label>
            <img src="/images/${g.id}.png?t=${Date.now()}"
                 width="${width}" height="${height}"
                 alt="${g.away.abbr} vs ${g.home.abbr}" />
          </div>
          <div class="preview-col">
            <label>2&times; Zoom (inspect detail)</label>
            <img src="/images/${g.id}.png?t=${Date.now()}"
                 width="${width * 2}" height="${height * 2}"
                 alt="${g.away.abbr} vs ${g.home.abbr}"
                 style="image-rendering: pixelated;" />
          </div>
        </div>
      </div>`
    )
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="refresh" content="30" />
  <title>Sports Ticker Preview</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0a0a0a;color:#eee;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;padding:24px;max-width:1100px;margin:0 auto}
    h1{font-size:20px;margin-bottom:4px}
    .subtitle{color:#666;font-size:12px;margin-bottom:20px}

    /* RSS URL box */
    .rss-box{background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:12px 16px;margin-bottom:24px;display:flex;align-items:center;gap:12px}
    .rss-box label{color:#888;font-size:12px;white-space:nowrap}
    .rss-box input{flex:1;background:#111;border:1px solid #444;color:#4af;padding:8px 12px;border-radius:4px;font-size:14px;font-family:monospace}
    .rss-box button{background:#4af;color:#000;border:none;padding:8px 16px;border-radius:4px;cursor:pointer;font-weight:bold;font-size:13px}
    .rss-box button:hover{background:#5bf}
    .rss-box .copied{color:#4f4;font-size:12px;display:none}

    /* Ticker groups */
    .ticker-group{margin-bottom:32px}
    .ticker-label{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
    .ticker-label .id{color:#555;font-size:11px;font-family:monospace}
    .badge{font-size:10px;padding:2px 8px;border-radius:3px;font-weight:bold;text-transform:uppercase;letter-spacing:.5px}
    .badge.in_progress{background:#ff3333;color:#fff}
    .badge.final{background:#333;color:#aaa}
    .badge.pre{background:#1a3a5c;color:#4af}

    .preview-row{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}
    .preview-col label{display:block;color:#555;font-size:10px;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px}
    .preview-col img{display:block;border:1px solid #333;background:#000}

    /* Info box */
    .info{background:#111;border:1px solid #333;border-radius:6px;padding:16px;margin-top:32px;font-size:13px;color:#888;line-height:1.7}
    .info h3{color:#ccc;margin-bottom:8px;font-size:14px}
    .info code{background:#1a1a1a;padding:2px 6px;border-radius:3px;color:#4af;font-size:12px}
    .info pre{background:#1a1a1a;padding:10px;border-radius:4px;margin:8px 0;overflow-x:auto;font-size:12px;color:#ccc}
  </style>
</head> 
<body>
  <h1>Sports Ticker Preview</h1>
  <p class="subtitle">
    ${currentGames.length} games &middot; Last updated ${lastUpdate.toLocaleTimeString()} &middot;
    Auto-refreshes every 30s &middot;
    Output: ${width}&times;${height} (rendered at ${width * scaleFactor}&times;${height * scaleFactor} then downscaled)
  </p>

  <div class="rss-box">
    <label>RSS Feed URL:</label>
    <input type="text" id="rssUrl" value="${rssUrl}" readonly onclick="this.select()" />
    <button onclick="copyRss()">Copy URL</button>
    <span class="copied" id="copiedMsg">Copied!</span>
  </div>

  ${gameCards}

  <script>
    function copyRss(){
      const el=document.getElementById('rssUrl');
      el.select();
      navigator.clipboard.writeText(el.value).then(()=>{
        const msg=document.getElementById('copiedMsg');
        msg.style.display='inline';
        setTimeout(()=>msg.style.display='none',2000);
      });
    }
  </script>
</body>
</html>`;

  res.set({ 'Content-Type': 'text/html; charset=utf-8' });
  res.send(html);
});

// ── NovaStar-compatible endpoints ──────────────────────────────────────
// NovaStar RSS mode is TEXT ONLY. These endpoints bypass RSS entirely.

// Option 1: Single rotating image — use in NovaStar "Image URL" or "Web Image" mode
// Each request returns the next game's ticker as a raw PNG.
// NovaStar fetches this URL on an interval and always gets a fresh image.
let rotationIndex = 0;
app.get('/ticker.png', async (_req, res) => {
  if (currentGames.length === 0) {
    res.status(503).set('Content-Type', 'text/plain').send('No games available');
    return;
  }

  const game = currentGames[rotationIndex % currentGames.length];
  rotationIndex++;

  // Try cache first
  const cached = imageCache.get(game.id);
  if (cached) {
    res.set({
      'Content-Type': 'image/png',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.send(cached);
    return;
  }

  try {
    const buffer = await renderTickerImage(game, logoCache);
    await imageCache.set(game.id, buffer, game.updatedAt);
    res.set({
      'Content-Type': 'image/png',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.send(buffer);
  } catch (err) {
    console.error('[ticker.png] render error:', err);
    res.status(500).set('Content-Type', 'text/plain').send('Render failed');
  }
});

// Option 2: Fullscreen HTML page — use in NovaStar "Web Page" / "URL" widget mode
// Auto-rotates through all games with a crossfade transition. Self-contained, no JS deps.
app.get('/ticker.html', (_req, res) => {
  const { width, height } = config.display;

  const imageUrls = currentGames.map(
    (g) => `/api/image?id=${encodeURIComponent(g.id)}`
  );

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=${width},height=${height},initial-scale=1"/>
<style>
*{margin:0;padding:0}
html,body{width:${width}px;height:${height}px;overflow:hidden;background:#000}
img{position:absolute;top:0;left:0;width:${width}px;height:${height}px;opacity:0;transition:opacity 0.5s ease}
img.active{opacity:1}
</style>
</head>
<body>
${imageUrls.map((url, i) => `<img id="s${i}" src="${url}" ${i === 0 ? 'class="active"' : ''}/>`).join('\n')}
<script>
var imgs=${JSON.stringify(imageUrls)};
var cur=0;
var total=imgs.length;
if(total>1){
  setInterval(function(){
    document.getElementById('s'+cur).className='';
    cur=(cur+1)%total;
    document.getElementById('s'+cur).className='active';
    // Preload next with cache-bust to get fresh scores
    var next=(cur+1)%total;
    var el=document.getElementById('s'+next);
    el.src=imgs[next]+'&t='+Date.now();
  },8000);
}
// Refresh all images every 60s to pick up score changes
setInterval(function(){
  for(var i=0;i<total;i++){
    var el=document.getElementById('s'+i);
    el.src=imgs[i]+'&t='+Date.now();
  }
},60000);
</script>
</body>
</html>`;

  res.set({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.send(html);
});

// Option 3: JSON playlist of all image URLs (for custom integrations)
app.get('/playlist.json', (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const base = `${protocol}://${host}`;

  const playlist = currentGames.map((g) => ({
    id: g.id,
    title: `${g.away.abbr} vs ${g.home.abbr}`,
    imageUrl: `${base}/api/image?id=${encodeURIComponent(g.id)}`,
    state: g.status.state,
  }));

  res.set({ 'Cache-Control': 'public, max-age=30' });
  res.json({ games: playlist, count: playlist.length, updated: lastUpdate.toISOString() });
});

// Root redirect
app.get('/', (_req, res) => {
  res.redirect('/preview');
});

// ── Local dev: start server with listen + background refresh ───────────
if (!config.isVercel) {
  (async () => {
    await ensureInitialized();

    // Background refresh only makes sense with a persistent server
    setInterval(() => {
      refreshData();
    }, config.cache.refreshIntervalMs);

    app.listen(config.server.port, config.server.host, () => {
      console.log('');
      console.log(`Server running at ${config.server.baseUrl}`);
      console.log(`  RSS Feed:  ${config.server.baseUrl}/rss.xml`);
      console.log(`  Preview:   ${config.server.baseUrl}/preview`);
      console.log(`  Health:    ${config.server.baseUrl}/health`);
      console.log('');
    });
  })().catch((err) => {
    console.error('Fatal startup error:', err);
    process.exit(1);
  });
}

// ── Export for Vercel serverless ────────────────────────────────────────
export default app;
