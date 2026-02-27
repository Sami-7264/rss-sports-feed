import express from 'express';
import { config } from './config';
import { ImageCache } from './utils/cache';
import { LogoCache } from './utils/logoCache';
import { MockProvider } from './dataProviders/mockProvider';
import { ApiProvider } from './dataProviders/apiProvider';
import { renderTickerImage } from './render/renderTicker';
import { generateRss } from './rss/generateRss';
import { FeedAggregator } from './feed/feedAggregator';
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
const feedAggregator = new FeedAggregator();

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

// Wide-format feed endpoint — /wide.html fetches this every 60s
app.get('/api/feed', async (_req, res) => {
  try {
    const data = await feedAggregator.getItems();
    res.set({
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=20, s-maxage=20, stale-while-revalidate=60',
      'Access-Control-Allow-Origin': '*',
    });
    res.json(data);
  } catch (err) {
    console.error('[/api/feed] Error:', err);
    res.status(500).json({ error: 'Failed to fetch feed' });
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
//  WIDE-FORMAT TICKER — 3840x270 scrolling marquee (NBA + NHL + PGA)
//
//  Loads ONCE, fetches /api/feed every 60s, CSS-animated scroll.
//  GPU-accelerated translate3d, hot-updates scores without restarting animation.
// ═══════════════════════════════════════════════════════════════════════
app.get('/wide.html', (_req, res) => {
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=3840,height=270,initial-scale=1,user-scalable=no"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap" rel="stylesheet"/>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:3840px;height:270px;overflow:hidden;background:#0a0a0f;
  font-family:'Inter',-apple-system,'Segoe UI',Roboto,Arial,sans-serif}

/* ── Marquee container ── */
.marquee{width:3840px;height:270px;overflow:hidden;position:relative}
.track{display:flex;align-items:center;height:270px;padding:0 16px;
  will-change:transform;animation:scroll var(--dur,60s) linear infinite}
@keyframes scroll{
  from{transform:translate3d(0,0,0)}
  to{transform:translate3d(-50%,0,0)}
}

/* ── Sport separator chip ── */
.sport-chip{display:flex;align-items:center;justify-content:center;
  width:52px;height:230px;margin:0 10px;flex-shrink:0}
.sport-chip span{writing-mode:vertical-rl;text-orientation:mixed;
  font-size:14px;font-weight:800;letter-spacing:2px;
  padding:12px 6px;border-radius:8px;color:#fff}
.chip-nba{background:linear-gradient(180deg,#1d428a,#c8102e)}
.chip-nhl{background:linear-gradient(180deg,#003087,#00847e)}
.chip-pga{background:linear-gradient(180deg,#006747,#2d6b3f)}

/* ── Game tile ── */
.game-tile{width:380px;height:240px;background:#111118;border-radius:12px;
  margin:0 10px;flex-shrink:0;overflow:hidden;display:flex;flex-direction:column;
  border:1px solid rgba(255,255,255,0.06)}

/* ── Team row ── */
.team-row{display:flex;align-items:center;height:90px;padding:0 14px;
  position:relative;overflow:hidden}
.team-row::after{content:'';position:absolute;inset:0;
  background:linear-gradient(180deg,rgba(255,255,255,0.08) 0%,transparent 50%,rgba(0,0,0,0.15) 100%);
  pointer-events:none}

/* ── Logo ── */
.team-logo{width:52px;height:52px;min-width:52px;border-radius:50%;overflow:hidden;
  background:rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;
  position:relative;z-index:1}
.team-logo img{width:100%;height:100%;object-fit:cover;display:block}
.team-logo .fb{font-size:18px;font-weight:900;color:#fff;display:none}
.team-logo.no-img img{display:none}
.team-logo.no-img .fb{display:block}
.team-logo.no-img{border:2px solid rgba(255,255,255,0.2);background:rgba(0,0,0,0.4)}

/* ── Team text ── */
.team-info{flex:1;margin-left:10px;position:relative;z-index:1;overflow:hidden}
.team-abbr{font-size:24px;font-weight:900;color:#fff;line-height:1.1;
  text-shadow:0 1px 2px rgba(0,0,0,0.4)}
.team-rec{font-size:11px;color:rgba(255,255,255,0.5);margin-top:1px}

/* ── Score ── */
.team-score{font-size:40px;font-weight:900;color:#fff;min-width:60px;
  text-align:right;position:relative;z-index:1;
  text-shadow:1px 2px 4px rgba(0,0,0,0.6)}
.team-score.dash{font-size:28px;color:#444}

/* ── Tile divider ── */
.tile-divider{height:1px;background:rgba(255,255,255,0.08);margin:0 14px}

/* ── Status bar ── */
.tile-status{flex:1;display:flex;align-items:center;padding:0 14px;
  background:#0a0a10;border-top:1px solid rgba(255,255,255,0.06)}
.tile-sport{font-size:11px;font-weight:700;color:#666;min-width:32px}
.tile-clock{flex:1;text-align:center;font-size:15px;font-weight:700;color:#fff}
.tile-clock.final{color:#888}
.tile-clock.pre{color:#4499ff}
.tile-live{display:flex;align-items:center;gap:5px;font-size:11px;
  font-weight:700;color:#ff3333}
.tile-live-dot{width:7px;height:7px;border-radius:50%;background:#ff3333;
  animation:pulse 2s ease-in-out infinite}
.tile-live.hidden{visibility:hidden}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}

/* ── PGA tile ── */
.pga-tile{width:420px;height:240px;background:#111118;border-radius:12px;
  margin:0 10px;flex-shrink:0;overflow:hidden;display:flex;flex-direction:column;
  border:1px solid rgba(255,255,255,0.06)}
.pga-header{padding:10px 14px 6px;
  background:linear-gradient(135deg,#006747 0%,#1a5c35 100%)}
.pga-tourney{font-size:16px;font-weight:900;color:#fff;
  text-shadow:0 1px 2px rgba(0,0,0,0.4)}
.pga-round{font-size:11px;color:rgba(255,255,255,0.7);margin-top:1px}
.pga-board{flex:1;padding:4px 10px;overflow:hidden}
.pga-row{display:flex;align-items:center;height:28px;font-size:12px;
  border-bottom:1px solid rgba(255,255,255,0.04)}
.pga-rank{width:24px;font-weight:700;color:#888;text-align:center}
.pga-name{flex:1;font-weight:600;color:#fff;padding-left:6px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pga-score{width:42px;text-align:right;font-weight:800;color:#4caf50}
.pga-today{width:36px;text-align:right;color:#aaa}
.pga-thru{width:30px;text-align:right;color:#666;font-size:11px}
.pga-status{height:34px;display:flex;align-items:center;padding:0 14px;
  background:#0a0a10;border-top:1px solid rgba(255,255,255,0.06)}
.pga-status-text{flex:1;text-align:center;font-size:12px;font-weight:700;color:#fff}
.pga-live{display:flex;align-items:center;gap:5px;font-size:11px;
  font-weight:700;color:#ff3333}
.pga-live-dot{width:7px;height:7px;border-radius:50%;background:#ff3333;
  animation:pulse 2s ease-in-out infinite}
</style>
</head>
<body>
<div class="marquee">
  <div class="track" id="track"></div>
</div>
<script>
(function(){
var track=document.getElementById('track');
var items=[];
var lastIds='';

function fetchFeed(){
  var x=new XMLHttpRequest();
  x.open('GET','/api/feed',true);
  x.timeout=15000;
  x.onload=function(){
    if(x.status!==200)return;
    try{
      var d=JSON.parse(x.responseText);
      if(d.items&&d.items.length>0)update(d.items);
    }catch(e){}
  };
  x.send();
}

function update(ni){
  var newIds=ni.map(function(i){return i.id}).join(',');
  if(newIds!==lastIds){
    items=ni;lastIds=newIds;rebuild();
  }else{
    items=ni;hotUpdate();
  }
}

function rebuild(){
  var html=buildTiles();
  track.innerHTML=html+html;
  requestAnimationFrame(function(){
    var oneSet=track.scrollWidth/2;
    var speed=80;
    var dur=oneSet/speed;
    track.style.setProperty('--dur',dur+'s');
    track.style.animationDuration=dur+'s';
  });
}

function hotUpdate(){
  for(var i=0;i<items.length;i++){
    var item=items[i];
    var els=track.querySelectorAll('[data-item-id="'+item.id+'"]');
    for(var j=0;j<els.length;j++)updateTile(els[j],item);
  }
}

function updateTile(el,item){
  if(item.type==='game'){
    var scores=el.querySelectorAll('.team-score');
    if(item.state==='pre'){
      if(scores[0]){scores[0].textContent='\\u2013';scores[0].className='team-score dash';}
      if(scores[1]){scores[1].textContent='\\u2013';scores[1].className='team-score dash';}
    }else{
      if(scores[0]){scores[0].textContent=item.awayScore;scores[0].className='team-score';}
      if(scores[1]){scores[1].textContent=item.homeScore;scores[1].className='team-score';}
    }
    var clock=el.querySelector('.tile-clock');
    var lv=el.querySelector('.tile-live');
    if(item.state==='live'){
      clock.textContent=item.statusText;clock.className='tile-clock';
      lv.className='tile-live';
    }else if(item.state==='final'){
      clock.textContent='FINAL';clock.className='tile-clock final';
      lv.className='tile-live hidden';
    }else{
      clock.textContent=item.statusText;clock.className='tile-clock pre';
      lv.className='tile-live hidden';
    }
  }else if(item.type==='pga'){
    var rows=el.querySelectorAll('.pga-row');
    for(var k=0;k<item.players.length&&k<rows.length;k++){
      var p=item.players[k];
      var rk=rows[k].querySelector('.pga-rank');
      var nm=rows[k].querySelector('.pga-name');
      var sc=rows[k].querySelector('.pga-score');
      var td=rows[k].querySelector('.pga-today');
      var th=rows[k].querySelector('.pga-thru');
      if(rk)rk.textContent=p.rank;
      if(nm)nm.textContent=p.name;
      if(sc)sc.textContent=p.score;
      if(td)td.textContent=p.today;
      if(th)th.textContent=p.thru;
    }
    var st=el.querySelector('.pga-status-text');
    if(st)st.textContent=item.statusText;
  }
}

function buildTiles(){
  var html='';var curSport='';
  for(var i=0;i<items.length;i++){
    var item=items[i];
    if(item.sport!==curSport){
      curSport=item.sport;
      var cc='chip-'+curSport.toLowerCase();
      html+='<div class="sport-chip"><span class="'+cc+'">'+esc(curSport)+'</span></div>';
    }
    if(item.type==='game')html+=buildGameTile(item);
    else if(item.type==='pga')html+=buildPgaTile(item);
  }
  return html;
}

function buildGameTile(g){
  var isPre=g.state==='pre',isFinal=g.state==='final',isLive=g.state==='live';
  var as=isPre?'\\u2013':g.awayScore,hs=isPre?'\\u2013':g.homeScore;
  var sc1=isPre?'team-score dash':'team-score';
  var clockText=g.statusText||'';
  var clockCls='tile-clock';
  if(isFinal)clockCls='tile-clock final';
  else if(isPre)clockCls='tile-clock pre';
  return '<div class="game-tile" data-item-id="'+esc(g.id)+'">'+
    tRow(g.away,as,sc1)+
    '<div class="tile-divider"></div>'+
    tRow(g.home,hs,sc1)+
    '<div class="tile-status">'+
      '<span class="tile-sport">'+esc(g.sport)+'</span>'+
      '<span class="'+clockCls+'">'+esc(clockText)+'</span>'+
      '<span class="tile-live'+(isLive?'':' hidden')+'"><span class="tile-live-dot"></span>LIVE</span>'+
    '</div>'+
  '</div>';
}

function tRow(team,score,sc){
  return '<div class="team-row" style="background:'+team.color+'">'+
    lHtml(team)+
    '<div class="team-info">'+
      '<div class="team-abbr">'+esc(team.abbr)+'</div>'+
      (team.record?'<div class="team-rec">'+esc(team.record)+'</div>':'')+
    '</div>'+
    '<span class="'+sc+'">'+esc(String(score))+'</span>'+
  '</div>';
}

function lHtml(team){
  if(!team.logoUrl)
    return '<div class="team-logo no-img"><img src=""/><span class="fb">'+esc(team.abbr)+'</span></div>';
  return '<div class="team-logo">'+
    '<img src="'+esc(team.logoUrl)+'" onerror="this.parentElement.className=\\'team-logo no-img\\'"/>'+
    '<span class="fb">'+esc(team.abbr)+'</span>'+
  '</div>';
}

function buildPgaTile(g){
  var isLive=g.state==='live';
  var rows='';
  for(var i=0;i<g.players.length;i++){
    var p=g.players[i];
    rows+='<div class="pga-row">'+
      '<span class="pga-rank">'+p.rank+'</span>'+
      '<span class="pga-name">'+esc(p.name)+'</span>'+
      '<span class="pga-score">'+esc(p.score)+'</span>'+
      '<span class="pga-today">'+esc(p.today)+'</span>'+
      '<span class="pga-thru">'+esc(p.thru)+'</span>'+
    '</div>';
  }
  return '<div class="pga-tile" data-item-id="'+esc(g.id)+'">'+
    '<div class="pga-header">'+
      '<div class="pga-tourney">'+esc(g.tournament)+'</div>'+
      '<div class="pga-round">'+esc(g.course)+' \\u2022 '+esc(g.round)+'</div>'+
    '</div>'+
    '<div class="pga-board">'+rows+'</div>'+
    '<div class="pga-status">'+
      '<span class="pga-status-text">'+esc(g.statusText)+'</span>'+
      (isLive?'<span class="pga-live"><span class="pga-live-dot"></span>LIVE</span>':'')+
    '</div>'+
  '</div>';
}

function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

fetchFeed();
setInterval(fetchFeed,60000);
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
    <label>Wide Ticker (3840x270):</label>
    <input type="text" value="${config.server.baseUrl}/wide.html" readonly onclick="this.select()" />
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
      console.log(`  Wide:      ${config.server.baseUrl}/wide.html`);
      console.log(`  RSS Feed:  ${config.server.baseUrl}/rss.xml`);
      console.log(`  Preview:   ${config.server.baseUrl}/preview`);
      console.log(`  Games API: ${config.server.baseUrl}/api/games`);
      console.log(`  Feed API:  ${config.server.baseUrl}/api/feed`);
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
