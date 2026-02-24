import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Game, Team } from '../types';
import { config } from '../config';
import { LogoCache } from '../utils/logoCache';

// ═══════════════════════════════════════════════════════════════════════
//  Broadcast-style scoreboard ticker renderer
//
//  Layout (384 x 192 at 1x):
//  ┌──────────────────────────────┬───────────┐
//  │  [LOGO 70]  TEAM   record   │   SCORE   │  Row 1: Away (80px)
//  │  (team color background)     │  (dark)   │
//  ├──────────────────────────────┼───────────┤  1px divider
//  │  [LOGO 70]  TEAM   record   │   SCORE   │  Row 2: Home (80px)
//  │  (team color background)     │  (dark)   │
//  ├──────────────────────────────┴───────────┤
//  │  NBA        Q4 · 3:52            ● LIVE  │  Status bar (31px)
//  └──────────────────────────────────────────┘
// ═══════════════════════════════════════════════════════════════════════

export async function renderTickerImage(game: Game, logoCache: LogoCache): Promise<Buffer> {
  const { width: W, height: H, scaleFactor } = config.display;

  const canvas = createCanvas(W * scaleFactor, H * scaleFactor);
  const ctx = canvas.getContext('2d');
  ctx.scale(scaleFactor, scaleFactor); 

  // ── Layout geometry ────────────────────────────────────────────────
  const t = config.ticker;
  const rowH       = t.teamRowHeight;       // 80
  const scorePanW  = t.scorePanelWidth;     // 114
  const scorePanX  = W - scorePanW;         // 270
  const logoSz     = t.logoSize;            // 70
  const logoPad    = t.logoPadding;         // 6

  const row1Y      = 0;
  const dividerY   = rowH;                  // 80
  const row2Y      = rowH + 1;             // 81
  const statusY    = rowH * 2 + 1;         // 161
  const statusH    = H - statusY;           // 31

  // ── Black base ─────────────────────────────────────────────────────
  ctx.fillStyle = config.colors.background;
  ctx.fillRect(0, 0, W, H);

  // ── Row 1: Away team ───────────────────────────────────────────────
  await drawTeamRow(
    ctx, game.away, game.score.away,
    row1Y, rowH, W, scorePanX, scorePanW,
    logoSz, logoPad, logoCache, game.status.state, game
  );

  // ── Horizontal divider ─────────────────────────────────────────────
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, dividerY, W, 1);

  // ── Row 2: Home team ───────────────────────────────────────────────
  await drawTeamRow(
    ctx, game.home, game.score.home,
    row2Y, rowH, W, scorePanX, scorePanW,
    logoSz, logoPad, logoCache, game.status.state, game
  );

  // ── Status bar ─────────────────────────────────────────────────────
  drawStatusBar(ctx, game, statusY, statusH, W);

  // ── Outer border (subtle, helps define edges on LED) ───────────────
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);

  // ── Downscale for LED sharpness ────────────────────────────────────
  if (scaleFactor > 1) {
    const output = createCanvas(W, H);
    const outCtx = output.getContext('2d');
    outCtx.drawImage(canvas, 0, 0, W, H);
    return output.toBuffer('image/png');
  }

  return canvas.toBuffer('image/png');
}

// ─────────────────────────────────────────────────────────────────────
//  Draw one team row (colored bar + logo + name + score panel)
// ─────────────────────────────────────────────────────────────────────
async function drawTeamRow(
  ctx: any, team: Team, score: number,
  y: number, h: number, totalW: number,
  scorePanX: number, scorePanW: number,
  logoSize: number, logoPad: number,
  logoCache: LogoCache, gameState: string, game: Game
): Promise<void> {
  // ── Team color nameplate (left portion) ────────────────────────────
  ctx.fillStyle = team.color;
  ctx.fillRect(0, y, scorePanX, h);

  // Subtle gradient overlay for depth (lighter top, darker bottom)
  const grad = ctx.createLinearGradient(0, y, 0, y + h);
  grad.addColorStop(0,   'rgba(255,255,255,0.08)');
  grad.addColorStop(0.5, 'rgba(0,0,0,0)');
  grad.addColorStop(1,   'rgba(0,0,0,0.20)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, y, scorePanX, h);

  // ── Score panel (dark) ─────────────────────────────────────────────
  ctx.fillStyle = config.colors.scorePanelBg;
  ctx.fillRect(scorePanX, y, scorePanW, h);

  // Vertical separator between team bar and score panel
  ctx.fillStyle = '#000000';
  ctx.fillRect(scorePanX, y, 2, h);

  // ── Logo ───────────────────────────────────────────────────────────
  const logoX = logoPad;
  const logoY = y + (h - logoSize) / 2;
  await drawLogo(ctx, team, logoX, logoY, logoSize, logoCache);

  // ── Team abbreviation (big, white, on color bar) ───────────────────
  const textX = logoPad + logoSize + 10;
  const hasRecord = !!(team.record && team.record.length > 0);

  ctx.fillStyle = '#ffffff';
  ctx.font = `${config.fonts.teamAbbr.weight} ${config.fonts.teamAbbr.size}px ${config.fonts.family}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  // Shift up slightly when record is shown
  ctx.fillText(team.abbr, textX, y + h / 2 - (hasRecord ? 8 : 0));

  // ── Record (smaller, semi-transparent) ─────────────────────────────
  if (hasRecord) {
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = `${config.fonts.record.size}px ${config.fonts.family}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(team.record!, textX, y + h / 2 + 14);
  }

  // ── Score (large, centered in dark panel) ──────────────────────────
  const scoreCX = scorePanX + scorePanW / 2;

  if (gameState === 'pre') {
    // Pre-game: show dash
    ctx.fillStyle = '#444444';
    ctx.font = `bold ${Math.round(config.fonts.score.size * 0.55)}px ${config.fonts.family}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('–', scoreCX, y + h / 2);
  } else {
    // Drop shadow for LED pop
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 3;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;

    ctx.fillStyle = '#ffffff';
    ctx.font = `${config.fonts.score.weight} ${config.fonts.score.size}px ${config.fonts.family}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(score), scoreCX, y + h / 2);

    // Reset shadow
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    // Winning-score highlight (final games)
    if (gameState === 'final') {
      const isWinner =
        (team === game.away && game.score.away > game.score.home) ||
        (team === game.home && game.score.home > game.score.away);
      if (isWinner) {
        // Bright underline accent
        ctx.fillStyle = team.color;
        ctx.fillRect(scorePanX + 20, y + h - 4, scorePanW - 40, 3);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Status bar (league, period/clock, LIVE indicator)
// ─────────────────────────────────────────────────────────────────────
function drawStatusBar(ctx: any, game: Game, y: number, h: number, w: number): void {
  // Background
  ctx.fillStyle = config.colors.statusBarBg;
  ctx.fillRect(0, y, w, h);

  // Top border
  ctx.fillStyle = config.colors.divider;
  ctx.fillRect(0, y, w, 1);

  const cy = y + h / 2 + 1;

  // League badge (left)
  ctx.fillStyle = config.colors.dimText;
  ctx.font = `${config.fonts.league.weight} ${config.fonts.league.size}px ${config.fonts.family}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(game.league, 8, cy);

  // Status text (center)
  const centerX = w / 2;

  if (game.status.state === 'in_progress') {
    ctx.fillStyle = '#ffffff';
    ctx.font = `${config.fonts.status.weight} ${config.fonts.status.size}px ${config.fonts.family}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const period = game.status.period ? `Q${game.status.period}` : '';
    const clock = game.status.clock || '';
    ctx.fillText(`${period}  \u00B7  ${clock}`, centerX, cy);
  } else if (game.status.state === 'final') {
    ctx.fillStyle = config.colors.final;
    ctx.font = `${config.fonts.status.weight} ${config.fonts.status.size}px ${config.fonts.family}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('FINAL', centerX, cy);
  } else {
    ctx.fillStyle = config.colors.pre;
    ctx.font = `${config.fonts.status.weight} ${config.fonts.status.size}px ${config.fonts.family}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(game.status.detail || 'UPCOMING', centerX, cy);
  }

  // LIVE indicator (right side, only for in-progress)
  if (game.status.state === 'in_progress') {
    const liveRightX = w - 8;
    ctx.fillStyle = config.colors.live;

    // Pulsing red dot
    ctx.beginPath();
    ctx.arc(liveRightX - 38, cy, 4, 0, Math.PI * 2);
    ctx.fill();

    // "LIVE" text
    ctx.font = `${config.fonts.liveIndicator.weight} ${config.fonts.liveIndicator.size}px ${config.fonts.family}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('LIVE', liveRightX, cy);
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Draw team logo (image or fallback badge)
// ─────────────────────────────────────────────────────────────────────
async function drawLogo(
  ctx: any,
  team: Team,
  x: number,
  y: number,
  size: number,
  logoCache: LogoCache
): Promise<void> {
  const logoBuffer = await logoCache.getLogo(team.logoUrl);

  if (logoBuffer) {
    try {
      const img = await loadImage(logoBuffer);
      // Circular clip
      ctx.save();
      ctx.beginPath();
      ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(img, x, y, size, size);
      ctx.restore();
      return;
    } catch {
      // Fall through to fallback
    }
  }

  // Fallback: dark badge circle on the colored team background
  const cx = x + size / 2;
  const cy = y + size / 2;
  const r = size / 2 - 1;

  // Semi-transparent dark circle
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  // White ring
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  // Abbreviation text in the circle
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${Math.round(size * 0.36)}px ${config.fonts.family}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(team.abbr, cx, cy);
}
