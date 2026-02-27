// NHL team abbreviation → ESPN CDN logo URL mapping
// Source: https://a.espncdn.com/i/teamlogos/nhl/500/{code}.png

const NHL_CODES: Record<string, string> = {
  ANA: 'ana', ARI: 'ari', BOS: 'bos', BUF: 'buf', CAR: 'car',
  CBJ: 'cbj', CGY: 'cgy', CHI: 'chi', COL: 'col', DAL: 'dal',
  DET: 'det', EDM: 'edm', FLA: 'fla', LAK: 'la',  MIN: 'min',
  MTL: 'mtl', NJD: 'njd', NSH: 'nsh', NYI: 'nyi', NYR: 'nyr',
  OTT: 'ott', PHI: 'phi', PIT: 'pit', SEA: 'sea', SJS: 'sj',
  STL: 'stl', TBL: 'tb',  TOR: 'tor', UTA: 'utah', VAN: 'van',
  VGK: 'vgk', WPG: 'wpg', WSH: 'wsh',
};

export function getNhlLogoUrl(abbr: string): string {
  const code = NHL_CODES[abbr.toUpperCase()];
  if (!code) return '';
  return `https://a.espncdn.com/i/teamlogos/nhl/500/${code}.png`;
}
