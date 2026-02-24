import { DataProvider, Game } from '../types';
import { MockProvider } from './mockProvider';

/**
 * API-based data provider for live sports data.
 *
 * To integrate a real sports API (ESPN, SportsData.io, etc.):
 * 1. Add your API key to .env as SPORTS_API_KEY
 * 2. Implement the fetch logic in fetchGames()
 * 3. Map the API response to the Game[] interface
 * 4. Set DATA_PROVIDER=api in your environment
 *
 * For now this delegates to the mock provider so the app runs
 * without an API key configured.
 */
export class ApiProvider implements DataProvider {
  private apiKey: string;
  private fallback: MockProvider;

  constructor() {
    this.apiKey = process.env.SPORTS_API_KEY || '';
    this.fallback = new MockProvider();

    if (!this.apiKey) {
      console.warn(
        '[ApiProvider] No SPORTS_API_KEY set — falling back to mock data. ' +
        'Set DATA_PROVIDER=mock or provide an API key.'
      );
    }
  }

  async fetchGames(): Promise<Game[]> {
    if (!this.apiKey) {
      return this.fallback.fetchGames();
    }

    // ---------------------------------------------------------------
    // Replace the block below with your real API call, for example:
    //
    //   const res = await fetch('https://api.sportsdata.io/v3/nba/scores/json/GamesByDate/2026-FEB-24', {
    //     headers: { 'Ocp-Apim-Subscription-Key': this.apiKey },
    //   });
    //   const data = await res.json();
    //   return data.map(mapApiGameToGame);
    //
    // ---------------------------------------------------------------

    console.log('[ApiProvider] Fetching live data from sports API...');
    return this.fallback.fetchGames();
  }
}
