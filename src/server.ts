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

// ═══════════════════════════════════════════════════════════════════════
//  CORE API ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════

// Lightweight JSON endpoint — ticker.html fetches this every 60s
// Returns game data + stable image URLs (no cache-busting params)
app.get('/api/games', (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const base = `${protocol}://${host}`;

  const games = currentGames.map((g) => ({
    id: g.id,
    league: g.league,
    away: { abbr: g.away.abbr, name: g.away.name, color: g.away.color, record: g.away.record, logoUrl: g.away.logoUrl || '' },
    home: { abbr: g.home.abbr, name: g.home.name, color: g.home.color, record: g.home.record, logoUrl: g.home.logoUrl || '' },
    score: g.score,
    status: g.status,
    // Stable image URL — same URL per game, no cache-busting params
    imageUrl: `${base}/api/image?id=${encodeURIComponent(g.id)}`,
  }));

  res.set({
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=20, s-maxage=20, stale-while-revalidate=60',
    'Access-Control-Allow-Origin': '*',
  });
  res.json({ games, updated: lastUpdate.toISOString() });
});

// On-demand image endpoint — returns cached PNG or renders fresh
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
      'Cache-Control': 'public, max-age=30, s-maxage=30, stale-while-revalidate=60',
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
    await imageCache.set(game.id, buffer, game.updatedAt);
    res.set({
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=30, s-maxage=30, stale-while-revalidate=60',
    });
    res.send(buffer);
  } catch (err) {
    console.error(`[Image] Failed to render ${id}:`, err);
    res.status(500).set('Content-Type', 'text/plain').send('Failed to render image');
  }
});

// ═══════════════════════════════════════════════════════════════════════
//  NOVASTAR TICKER PAGE — CSS-rendered broadcast scoreboard
//
//  Loads ONCE, fetches /api/games every 60s, renders with CSS locally.
//  Rotates every 8s with crossfade. Animated LIVE pulse.
//  ~1 JSON request/min + logo images cached by browser.
// ═══════════════════════════════════════════════════════════════════════
app.get('/ticker.html', (_req, res) => {
  const W = config.display.width;   // 384
  const H = config.display.height;  // 192
  const ROW_H = 80;
  const STATUS_H = H - ROW_H * 2 - 1; // 31
  const SCORE_W = 114;
  const INFO_W = W - SCORE_W;       // 270
  const LOGO_SZ = 70;

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=${W},height=${H},initial-scale=1,user-scalable=no"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700;800;900&display=swap" rel="stylesheet"/>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${W}px;height:${H}px;overflow:hidden;background:#000;
  font-family:'Inter',-apple-system,'Segoe UI',Roboto,Arial,sans-serif}

/* ── Game slides ── */
.game{position:absolute;top:0;left:0;width:${W}px;height:${H}px;
  opacity:0;transition:opacity 0.8s ease;pointer-events:none}
.game.active{opacity:1}

/* ── Team row ── */
.row{display:flex;width:${W}px;height:${ROW_H}px;position:relative}
.row-info{display:flex;align-items:center;width:${INFO_W}px;height:${ROW_H}px;
  padding-left:6px;position:relative;overflow:hidden}
.row-info::after{content:'';position:absolute;inset:0;
  background:linear-gradient(180deg,rgba(255,255,255,0.10) 0%,transparent 50%,rgba(0,0,0,0.22) 100%);
  pointer-events:none}

/* ── Score panel ── */
.score-panel{width:${SCORE_W}px;height:${ROW_H}px;background:#141414;
  display:flex;align-items:center;justify-content:center;border-left:2px solid #000}
.score-val{font-size:46px;font-weight:900;color:#fff;
  text-shadow:1px 2px 4px rgba(0,0,0,0.7)}
.score-dash{font-size:26px;font-weight:700;color:#444}

/* ── Logo ── */
.logo-wrap{width:${LOGO_SZ}px;height:${LOGO_SZ}px;min-width:${LOGO_SZ}px;
  border-radius:50%;overflow:hidden;position:relative;z-index:1;
  background:rgba(0,0,0,0.25);display:flex;align-items:center;justify-content:center}
.logo-wrap img{width:100%;height:100%;object-fit:cover;display:block}
.logo-fb{font-size:25px;font-weight:900;color:#fff;display:none}
.logo-wrap.no-img .logo-fb{display:flex}
.logo-wrap.no-img img{display:none}
.logo-wrap.no-img{border:2px solid rgba(255,255,255,0.25);background:rgba(0,0,0,0.35)}

/* ── Team text ── */
.t-text{margin-left:10px;position:relative;z-index:1;overflow:hidden}
.t-abbr{font-size:28px;font-weight:900;color:#fff;line-height:1.1;
  text-shadow:0 1px 2px rgba(0,0,0,0.4)}
.t-rec{font-size:13px;font-weight:400;color:rgba(255,255,255,0.55);margin-top:1px}

/* ── Divider ── */
.divider{width:${W}px;height:1px;background:#000}

/* ── Winner accent bar ── */
.winner-bar{position:absolute;bottom:0;right:0;width:${SCORE_W - 40}px;height:3px;
  margin-right:20px;border-radius:1px}

/* ── Status bar ── */
.status{display:flex;align-items:center;width:${W}px;height:${STATUS_H}px;
  background:#0c0c0c;border-top:1px solid #333;padding:0 8px}
.s-league{font-size:12px;font-weight:700;color:#888;min-width:36px}
.s-clock{flex:1;text-align:center;font-size:14px;font-weight:700;color:#fff}
.s-clock.final{color:#999}
.s-clock.pre{color:#4499ff}
.s-live{display:flex;align-items:center;gap:5px;font-size:12px;font-weight:700;color:#ff3333;min-width:50px;justify-content:flex-end}
.s-live-dot{width:8px;height:8px;border-radius:50%;background:#ff3333;
  animation:pulse 2s ease-in-out infinite}
.s-live.hidden{visibility:hidden}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
</style>
</head>
<body>
<div id="ct"></div>
<script>
(function(){
var ct=document.getElementById('ct');
var games=[],slides=[],cur=0,timer=null;

function fetchGames(){
  var x=new XMLHttpRequest();
  x.open('GET','/api/games',true);
  x.timeout=15000;
  x.onload=function(){
    if(x.status!==200)return;
    try{
      var d=JSON.parse(x.responseText);
      if(d.games&&d.games.length>0)update(d.games);
    }catch(e){}
  };
  x.send();
}

function update(ng){
  var changed=ng.length!==games.length;
  if(!changed){
    for(var i=0;i<ng.length;i++){
      if(ng[i].id!==games[i].id){changed=true;break;}
    }
  }
  games=ng;
  if(changed){rebuild();}
  else{refreshData();}
}

function rebuild(){
  if(timer){clearInterval(timer);timer=null;}
  cur=0;
  ct.innerHTML='';
  slides=[];
  for(var i=0;i<games.length;i++){
    var el=buildGame(games[i]);
    if(i===0)el.className='game active';
    ct.appendChild(el);
    slides.push(el);
  }
  if(games.length>1)timer=setInterval(rotate,8000);
}

function refreshData(){
  for(var i=0;i<games.length;i++){
    var g=games[i];
    var s=slides[i];
    if(!s)continue;
    // Update scores
    var sv=s.querySelectorAll('.score-val');
    if(g.status.state==='pre'){
      if(sv[0])sv[0].textContent='\\u2013';
      if(sv[1])sv[1].textContent='\\u2013';
      if(sv[0])sv[0].className='score-val score-dash';
      if(sv[1])sv[1].className='score-val score-dash';
    }else{
      if(sv[0]){sv[0].textContent=g.score.away;sv[0].className='score-val';}
      if(sv[1]){sv[1].textContent=g.score.home;sv[1].className='score-val';}
    }
    // Update status
    var cl=s.querySelector('.s-clock');
    var lv=s.querySelector('.s-live');
    if(g.status.state==='in_progress'){
      cl.textContent='Q'+(g.status.period||'?')+' \\u00B7 '+(g.status.clock||'');
      cl.className='s-clock';
      lv.className='s-live';
    }else if(g.status.state==='final'){
      cl.textContent='FINAL';
      cl.className='s-clock final';
      lv.className='s-live hidden';
    }else{
      cl.textContent=g.status.detail||'UPCOMING';
      cl.className='s-clock pre';
      lv.className='s-live hidden';
    }
    // Update winner bars
    var wb=s.querySelectorAll('.winner-bar');
    if(g.status.state==='final'){
      var aw=g.score.away>g.score.home;
      if(wb[0])wb[0].style.background=aw?g.away.color:'transparent';
      if(wb[1])wb[1].style.background=(!aw)?g.home.color:'transparent';
    }else{
      if(wb[0])wb[0].style.background='transparent';
      if(wb[1])wb[1].style.background='transparent';
    }
  }
}

function buildGame(g){
  var d=document.createElement('div');
  d.className='game';

  var isPre=g.status.state==='pre';
  var isFinal=g.status.state==='final';
  var isLive=g.status.state==='in_progress';
  var awayWin=isFinal&&g.score.away>g.score.home;
  var homeWin=isFinal&&g.score.home>g.score.away;

  // Status text
  var clockText='',clockClass='s-clock';
  if(isLive){
    clockText='Q'+(g.status.period||'?')+' \\u00B7 '+(g.status.clock||'');
  }else if(isFinal){
    clockText='FINAL';clockClass='s-clock final';
  }else{
    clockText=g.status.detail||'UPCOMING';clockClass='s-clock pre';
  }

  d.innerHTML=
    teamRow(g.away,isPre?'\\u2013':g.score.away,isPre,awayWin)+
    '<div class="divider"></div>'+
    teamRow(g.home,isPre?'\\u2013':g.score.home,isPre,homeWin)+
    '<div class="status">'+
      '<span class="s-league">'+esc(g.league)+'</span>'+
      '<span class="'+clockClass+'">'+esc(clockText)+'</span>'+
      '<span class="s-live'+(isLive?'':' hidden')+'"><span class="s-live-dot"></span>LIVE</span>'+
    '</div>';

  return d;
}

function teamRow(team,score,isPre,isWinner){
  var scoreClass=isPre?'score-val score-dash':'score-val';
  return '<div class="row">'+
    '<div class="row-info" style="background:'+team.color+'">'+
      logoHtml(team)+
      '<div class="t-text">'+
        '<div class="t-abbr">'+esc(team.abbr)+'</div>'+
        (team.record?'<div class="t-rec">'+esc(team.record)+'</div>':'')+
      '</div>'+
    '</div>'+
    '<div class="score-panel">'+
      '<span class="'+scoreClass+'">'+esc(String(score))+'</span>'+
      (isWinner?'<div class="winner-bar" style="background:'+team.color+'"></div>':
                '<div class="winner-bar"></div>')+
    '</div>'+
  '</div>';
}

function logoHtml(team){
  if(!team.logoUrl){
    return '<div class="logo-wrap no-img"><span class="logo-fb">'+esc(team.abbr)+'</span></div>';
  }
  return '<div class="logo-wrap" id="lw-'+esc(team.abbr)+'">'+
    '<img src="'+esc(team.logoUrl)+'" onerror="this.parentElement.className=\\'logo-wrap no-img\\'"/>'+
    '<span class="logo-fb">'+esc(team.abbr)+'</span>'+
  '</div>';
}

function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

function rotate(){
  if(slides.length===0)return;
  slides[cur].className='game';
  cur=(cur+1)%slides.length;
  slides[cur].className='game active';
}

fetchGames();
setInterval(fetchGames,60000);
})();
</script>
</body>
</html>`;

  res.set({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'public, max-age=300, s-maxage=300',
  });
  res.send(html);
});

// ═══════════════════════════════════════════════════════════════════════
//  RSS FEED (kept for non-NovaStar consumers)
// ═══════════════════════════════════════════════════════════════════════
app.get('/rss.xml', (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const requestBaseUrl = `${protocol}://${host}`;
  const xml = generateRss(currentGames, requestBaseUrl);
  res.set({
    'Content-Type': 'application/rss+xml; charset=utf-8',
    'Cache-Control': 'public, max-age=30, s-maxage=30, stale-while-revalidate=60',
  });
  res.send(xml);
});

// ═══════════════════════════════════════════════════════════════════════
//  LEGACY / UTILITY ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════

// Ticker images (cached path — used by preview page)
app.get('/images/:id.png', async (req, res) => {
  const id = req.params.id;
  const buffer = imageCache.get(id);
  if (buffer) {
    res.set({
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=30, s-maxage=30, stale-while-revalidate=60',
    });
    res.send(buffer);
    return;
  }

  const diskBuffer = await imageCache.loadFromDisk(id);
  if (diskBuffer) {
    res.set({
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=30',
    });
    res.send(diskBuffer);
    return;
  }

  res.status(404).json({ error: 'Image not found', id });
});

// Single rotating image — for NovaStar "Image URL" mode
let rotationIndex = 0;
app.get('/ticker.png', async (_req, res) => {
  if (currentGames.length === 0) {
    res.status(503).set('Content-Type', 'text/plain').send('No games available');
    return;
  }

  const game = currentGames[rotationIndex % currentGames.length];
  rotationIndex++;

  const cached = imageCache.get(game.id);
  if (cached) {
    res.set({
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=5, s-maxage=5, stale-while-revalidate=30',
    });
    res.send(cached);
    return;
  }

  try {
    const buffer = await renderTickerImage(game, logoCache);
    await imageCache.set(game.id, buffer, game.updatedAt);
    res.set({
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=5, s-maxage=5, stale-while-revalidate=30',
    });
    res.send(buffer);
  } catch (err) {
    console.error('[ticker.png] render error:', err);
    res.status(500).set('Content-Type', 'text/plain').send('Render failed');
  }
});

// JSON playlist
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

  res.set({ 'Cache-Control': 'public, max-age=30, s-maxage=30' });
  res.json({ games: playlist, count: playlist.length, updated: lastUpdate.toISOString() });
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

// Preview page
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
            <img src="/api/image?id=${encodeURIComponent(g.id)}"
                 width="${width}" height="${height}"
                 alt="${g.away.abbr} vs ${g.home.abbr}" />
          </div>
          <div class="preview-col">
            <label>2&times; Zoom (inspect detail)</label>
            <img src="/api/image?id=${encodeURIComponent(g.id)}"
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
    .url-box{background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:12px 16px;margin-bottom:12px;display:flex;align-items:center;gap:12px}
    .url-box label{color:#888;font-size:12px;white-space:nowrap;min-width:120px}
    .url-box input{flex:1;background:#111;border:1px solid #444;color:#4af;padding:8px 12px;border-radius:4px;font-size:13px;font-family:monospace}
    .url-box button{background:#4af;color:#000;border:none;padding:8px 16px;border-radius:4px;cursor:pointer;font-weight:bold;font-size:13px}
    .url-box button:hover{background:#5bf}
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
  </style>
</head>
<body>
  <h1>Sports Ticker Preview</h1>
  <p class="subtitle">
    ${currentGames.length} games &middot; Last updated ${lastUpdate.toLocaleTimeString()} &middot;
    Auto-refreshes every 30s &middot;
    Output: ${width}&times;${height} (rendered at ${width * scaleFactor}&times;${height * scaleFactor} then downscaled)
  </p>

  <div class="url-box">
    <label>NovaStar URL:</label>
    <input type="text" value="${config.server.baseUrl}/ticker.html" readonly onclick="this.select()" />
    <button onclick="copy(this)">Copy</button>
  </div>
  <div class="url-box">
    <label>RSS Feed:</label>
    <input type="text" value="${rssUrl}" readonly onclick="this.select()" />
    <button onclick="copy(this)">Copy</button>
  </div>

  ${gameCards}

  <script>
    function copy(btn){
      var inp=btn.parentElement.querySelector('input');
      inp.select();
      navigator.clipboard.writeText(inp.value);
      btn.textContent='Copied!';
      setTimeout(function(){btn.textContent='Copy'},2000);
    }
  </script>
</body>
</html>`;

  res.set({ 'Content-Type': 'text/html; charset=utf-8' });
  res.send(html);
});

// Root redirect
app.get('/', (_req, res) => {
  res.redirect('/preview');
});

// ── Local dev: start server with listen + background refresh ───────────
if (!config.isVercel) {
  (async () => {
    await ensureInitialized();

    setInterval(() => {
      refreshData();
    }, config.cache.refreshIntervalMs);

    app.listen(config.server.port, config.server.host, () => {
      console.log('');
      console.log(`Server running at ${config.server.baseUrl}`);
      console.log(`  Ticker:    ${config.server.baseUrl}/ticker.html`);
      console.log(`  RSS Feed:  ${config.server.baseUrl}/rss.xml`);
      console.log(`  Preview:   ${config.server.baseUrl}/preview`);
      console.log(`  Games API: ${config.server.baseUrl}/api/games`);
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
