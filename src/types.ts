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

// ── Wide-format feed types ────────────────────────────────────────────

export type SportType = 'NBA' | 'NHL' | 'PGA';

export interface GameFeedItem {
  type: 'game';
  id: string;
  sport: SportType;
  away: { abbr: string; name: string; color: string; logoUrl: string; record?: string };
  home: { abbr: string; name: string; color: string; logoUrl: string; record?: string };
  awayScore: number;
  homeScore: number;
  state: 'pre' | 'live' | 'final';
  statusText: string;
  periodLabel?: string;
}

export interface PgaPlayer {
  rank: number;
  name: string;
  score: string;
  today: string;
  thru: string;
}

export interface PgaFeedItem {
  type: 'pga';
  id: string;
  sport: 'PGA';
  tournament: string;
  course: string;
  round: string;
  players: PgaPlayer[];
  state: 'live' | 'final';
  statusText: string;
}

export type FeedItem = GameFeedItem | PgaFeedItem;

export interface FeedResponse {
  items: FeedItem[];
  updated: string;
}

export interface WideFeedProvider {
  getSport(): SportType;
  fetchItems(): Promise<FeedItem[]>;
}
