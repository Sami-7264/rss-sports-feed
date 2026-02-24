import * as fs from 'fs';
import * as path from 'path';
import { DataProvider, Game } from '../types';

export class MockProvider implements DataProvider {
  private filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath || path.resolve(process.cwd(), 'data/mockGames.json');
  }

  async fetchGames(): Promise<Game[]> {
    const raw = fs.readFileSync(this.filePath, 'utf-8');
    const games: Game[] = JSON.parse(raw);
    return games;
  }
}
