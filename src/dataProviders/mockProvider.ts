import * as fs from 'fs';
import * as path from 'path';
import { DataProvider, Game } from '../types';

export class MockProvider implements DataProvider {
  private filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath || MockProvider.findDataFile();
  }

  async fetchGames(): Promise<Game[]> {
    const raw = fs.readFileSync(this.filePath, 'utf-8');
    const games: Game[] = JSON.parse(raw);
    return games;
  }

  private static findDataFile(): string {
    // Try multiple locations to handle local dev, compiled dist/, and Vercel bundling
    const candidates = [
      path.resolve(process.cwd(), 'data/mockGames.json'),
      path.join(__dirname, '..', '..', 'data', 'mockGames.json'),
      path.join(__dirname, '..', 'data', 'mockGames.json'),
      path.join(__dirname, 'data', 'mockGames.json'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    // Fallback to cwd-based path (will error on read if missing)
    return candidates[0];
  }
}
