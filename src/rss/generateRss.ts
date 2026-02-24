import { Game } from '../types';
import { config } from '../config';

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatTitle(game: Game): string {
  if (game.status.state === 'pre') {
    return `${game.away.abbr} vs ${game.home.abbr} (${game.status.detail || 'Upcoming'})`;
  }
  const statusStr =
    game.status.state === 'final'
      ? 'Final'
      : `Q${game.status.period || '?'} ${game.status.clock || ''}`.trim();
  return `${game.away.abbr} ${game.score.away} - ${game.home.abbr} ${game.score.home} (${statusStr})`;
}

function formatDescription(game: Game): string {
  if (game.status.state === 'pre') {
    return `${game.away.name} vs ${game.home.name} — ${game.status.detail || 'Upcoming'}`;
  }
  const statusStr =
    game.status.state === 'final'
      ? 'Final'
      : `Q${game.status.period || '?'} ${game.status.clock || ''}`.trim();
  return `${game.away.name} ${game.score.away}, ${game.home.name} ${game.score.home} — ${statusStr}`;
}

export function generateRss(games: Game[]): string {
  const baseUrl = config.server.baseUrl;
  const now = new Date().toUTCString();

  const items = games
    .map((game) => {
      const title = escapeXml(formatTitle(game));
      const description = escapeXml(formatDescription(game));
      const imageUrl = `${baseUrl}/images/${game.id}.png`;
      const pubDate = new Date(game.updatedAt).toUTCString();

      return `    <item>
      <title>${title}</title>
      <description>${description}</description>
      <guid isPermaLink="false">${escapeXml(game.id)}</guid>
      <pubDate>${pubDate}</pubDate>
      <enclosure url="${escapeXml(imageUrl)}" type="image/png" length="0"/>
    </item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Sports Ticker Feed</title>
    <link>${escapeXml(baseUrl)}</link>
    <description>Live sports scores ticker with high-resolution images for LED displays</description>
    <lastBuildDate>${now}</lastBuildDate>
    <ttl>1</ttl>
    <atom:link href="${escapeXml(baseUrl)}/rss.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>`;
}
