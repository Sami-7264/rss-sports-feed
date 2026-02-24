import * as fs from 'fs/promises';
import * as path from 'path';
import https from 'https';
import http from 'http';

export class LogoCache {
  private dir: string;
  private memCache = new Map<string, Buffer>();

  constructor(dir: string) {
    this.dir = dir;
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  async getLogo(url: string | undefined): Promise<Buffer | null> {
    if (!url || url.trim() === '') return null;

    // Check memory cache
    if (this.memCache.has(url)) {
      return this.memCache.get(url)!;
    }

    // Check disk cache
    const filename = this.urlToFilename(url);
    const filepath = path.join(this.dir, filename);
    try {
      const buffer = await fs.readFile(filepath);
      this.memCache.set(url, buffer);
      return buffer;
    } catch {
      // Not cached on disk, continue to download
    }

    // Download
    try {
      const buffer = await this.download(url);
      await fs.writeFile(filepath, buffer);
      this.memCache.set(url, buffer);
      return buffer;
    } catch (err) {
      console.warn(`[LogoCache] Failed to download logo: ${url}`, (err as Error).message);
      return null;
    }
  }

  private urlToFilename(url: string): string {
    const safe = url.replace(/[^a-zA-Z0-9._-]/g, '_');
    // Keep it reasonable length and add extension
    const trimmed = safe.slice(-120);
    return trimmed.endsWith('.png') || trimmed.endsWith('.svg') || trimmed.endsWith('.jpg')
      ? trimmed
      : trimmed + '.png';
  }

  private download(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;
      const req = client.get(url, { timeout: 10_000 }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const redirect = res.headers.location;
          if (redirect) {
            this.download(redirect).then(resolve).catch(reject);
            return;
          }
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Download timeout'));
      });
    });
  }
}
