import * as fs from 'fs';
import * as path from 'path';
import { WideFeedProvider, FeedItem, GameFeedItem, SportType } from '../types';
import { getNhlLogoUrl } from '../utils/nhlLogos';

export class NhlFeedProvider implements WideFeedProvider {
  private filePath: string;

  constructor() {
    this.filePath = this.findDataFile();
  }

  getSport(): SportType { return 'NHL'; }

  async fetchItems(): Promise<FeedItem[]> {
    const raw = fs.readFileSync(this.filePath, 'utf-8');
    const games = JSON.parse(raw);
    return games.map((g: any): GameFeedItem => ({
      type: 'game',
      id: g.id,
      sport: 'NHL',
      away: {
        abbr: g.away.abbr,
        name: g.away.name,
        color: g.away.color,
        logoUrl: g.away.logoUrl || getNhlLogoUrl(g.away.abbr),
        record: g.away.record,
      },
      home: {
        abbr: g.home.abbr,
        name: g.home.name,
        color: g.home.color,
        logoUrl: g.home.logoUrl || getNhlLogoUrl(g.home.abbr),
        record: g.home.record,
      },
      awayScore: g.score.away,
      homeScore: g.score.home,
      state: g.status.state === 'in_progress' ? 'live' : g.status.state,
      statusText: this.formatStatus(g.status),
      periodLabel: g.status.period ? this.ordinal(g.status.period) : undefined,
    }));
  }

  private formatStatus(status: any): string {
    if (status.state === 'in_progress')
      return `${this.ordinal(status.period || 1)} ${status.clock || ''}`.trim();
    if (status.state === 'final') return 'FINAL';
    return status.detail || 'UPCOMING';
  }

  private ordinal(p: number): string {
    if (p === 1) return '1st';
    if (p === 2) return '2nd';
    if (p === 3) return '3rd';
    return 'OT';
  }

  private findDataFile(): string {
    const candidates = [
      path.resolve(process.cwd(), 'data/mockNhl.json'),
      path.join(__dirname, '..', '..', 'data', 'mockNhl.json'),
    ];
    for (const p of candidates) { if (fs.existsSync(p)) return p; }
    return candidates[0];
  }
}
