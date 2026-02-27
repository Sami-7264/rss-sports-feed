import * as fs from 'fs';
import * as path from 'path';
import { WideFeedProvider, FeedItem, PgaFeedItem, SportType } from '../types';

export class PgaFeedProvider implements WideFeedProvider {
  private filePath: string;

  constructor() {
    this.filePath = this.findDataFile();
  }

  getSport(): SportType { return 'PGA'; }

  async fetchItems(): Promise<FeedItem[]> {
    const raw = fs.readFileSync(this.filePath, 'utf-8');
    const t = JSON.parse(raw);
    const item: PgaFeedItem = {
      type: 'pga',
      id: t.id,
      sport: 'PGA',
      tournament: t.tournament,
      course: t.course,
      round: t.round,
      players: t.players.slice(0, 6),
      state: t.state,
      statusText: t.statusText,
    };
    return [item];
  }

  private findDataFile(): string {
    const candidates = [
      path.resolve(process.cwd(), 'data/mockPga.json'),
      path.join(__dirname, '..', '..', 'data', 'mockPga.json'),
    ];
    for (const p of candidates) { if (fs.existsSync(p)) return p; }
    return candidates[0];
  }
}
