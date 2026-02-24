const isVercel = !!process.env.VERCEL;

export const config = {
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    host: process.env.HOST || '0.0.0.0',
    baseUrl: process.env.BASE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000'),
  },

  display: {
    width: 384,
    height: 192,
    scaleFactor: 2,       // render at 2x then downscale for LED sharpness
  },

  // ── Ticker bar layout ────────────────────────────────────────────────
  ticker: {
    teamRowHeight: 80,      // px height of each team row (away / home)
    scorePanelWidth: 114,   // px width of the dark score panel on the right
    logoSize: 70,           // logo diameter (px)
    logoPadding: 6,         // left margin before logo
  },

  fonts: {
    family: 'Arial, Helvetica, sans-serif',
    score:         { size: 46, weight: 'bold'   as const },
    teamAbbr:      { size: 28, weight: 'bold'   as const },
    record:        { size: 13, weight: 'normal' as const },
    status:        { size: 14, weight: 'bold'   as const },
    league:        { size: 12, weight: 'bold'   as const },
    liveIndicator: { size: 12, weight: 'bold'   as const },
  },

  colors: {
    background:   '#000000',
    scorePanelBg: '#141414',
    statusBarBg:  '#0c0c0c',
    divider:      '#333333',
    text:         '#ffffff',
    dimText:      '#888888',
    live:         '#ff3333',
    final:        '#999999',
    pre:          '#4499ff',
  },

  logo: {
    size: 70,               // kept in sync with ticker.logoSize
    fallbackText: '#ffffff',
  },

  cache: {
    imageTtlMs: 60_000,          // 60 seconds
    refreshIntervalMs: 60_000,   // data refresh every 60s
  },

  // Vercel has read-only filesystem — use /tmp for generated files
  storage: {
    imagesDir: isVercel ? '/tmp/storage/images' : './storage/images',
    logosDir:  isVercel ? '/tmp/storage/logos'  : './storage/logos',
  },

  isVercel,

  dataProvider: (process.env.DATA_PROVIDER || 'mock') as 'mock' | 'api',
};
