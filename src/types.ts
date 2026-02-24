export interface Team {
  name: string;
  abbr: string;
  color: string;
  record?: string;
  logoUrl?: string;
}

export interface GameScore {
  home: number;
  away: number;
}

export interface GameStatus {
  state: 'pre' | 'in_progress' | 'final';
  period?: number;
  clock?: string;
  detail?: string;
}

export interface Game {
  id: string;
  league: string;
  home: Team;
  away: Team;
  score: GameScore;
  status: GameStatus;
  updatedAt: string;
}

export interface DataProvider {
  fetchGames(): Promise<Game[]>;
}
