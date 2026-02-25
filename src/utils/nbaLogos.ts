// NBA team abbreviation → ESPN CDN logo URL mapping
// Source: https://a.espncdn.com/i/teamlogos/nba/500/{code}.png

const NBA_CODES: Record<string, string> = {
  ATL: 'atl', BOS: 'bos', BKN: 'bkn', CHA: 'cha', CHI: 'chi',
  CLE: 'cle', DAL: 'dal', DEN: 'den', DET: 'det', GSW: 'gs',
  HOU: 'hou', IND: 'ind', LAC: 'lac', LAL: 'lal', MEM: 'mem',
  MIA: 'mia', MIL: 'mil', MIN: 'min', NOP: 'no',  NYK: 'ny',
  OKC: 'okc', ORL: 'orl', PHI: 'phi', PHX: 'phx', POR: 'por',
  SAC: 'sac', SAS: 'sa',  TOR: 'tor', UTA: 'uta', WAS: 'wsh',
};

export function getNbaLogoUrl(abbr: string): string {
  const code = NBA_CODES[abbr.toUpperCase()];
  if (!code) return '';
  return `https://a.espncdn.com/i/teamlogos/nba/500/${code}.png`;
}
