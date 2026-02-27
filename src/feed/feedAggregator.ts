import { FeedItem, FeedResponse, WideFeedProvider } from '../types';
import { NbaFeedProvider } from '../providers/nba';
import { NhlFeedProvider } from '../providers/nhl';
import { PgaFeedProvider } from '../providers/pga';

interface FeedCache {
  items: FeedItem[];
  updatedAt: Date;
}

export class FeedAggregator {
  private providers: WideFeedProvider[];
  private cache: FeedCache | null = null;
  private ttlMs: number;

  constructor(ttlMs: number = 30_000) {
    this.providers = [
      new NbaFeedProvider(),
      new NhlFeedProvider(),
      new PgaFeedProvider(),
    ];
    this.ttlMs = ttlMs;
  }

  async getItems(): Promise<FeedResponse> {
    if (this.cache && Date.now() - this.cache.updatedAt.getTime() < this.ttlMs) {
      return {
        items: this.cache.items,
        updated: this.cache.updatedAt.toISOString(),
      };
    }
    return this.refresh();
  }

  async refresh(): Promise<FeedResponse> {
    const results = await Promise.allSettled(
      this.providers.map(p => p.fetchItems())
    );

    const items: FeedItem[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        items.push(...result.value);
      } else {
        console.error('[FeedAggregator] Provider failed:', result.reason);
      }
    }

    // Sort: live first, then pre, then final
    const stateOrder: Record<string, number> = { live: 0, pre: 1, final: 2 };
    items.sort((a, b) => (stateOrder[a.state] ?? 9) - (stateOrder[b.state] ?? 9));

    this.cache = { items, updatedAt: new Date() };

    return {
      items: this.cache.items,
      updated: this.cache.updatedAt.toISOString(),
    };
  }
}
