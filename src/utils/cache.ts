import * as fs from 'fs/promises';
import * as path from 'path';

interface CacheEntry {
  buffer: Buffer;
  generatedAt: number;
  dataHash: string;
}

export class ImageCache {
  private cache = new Map<string, CacheEntry>();
  private dir: string;
  private ttlMs: number;

  constructor(dir: string, ttlMs: number) {
    this.dir = dir;
    this.ttlMs = ttlMs;
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  get(id: string): Buffer | null {
    const entry = this.cache.get(id);
    if (!entry) return null;
    return entry.buffer;
  }

  isStale(id: string, dataHash: string): boolean {
    const entry = this.cache.get(id);
    if (!entry) return true;
    if (entry.dataHash !== dataHash) return true;
    if (Date.now() - entry.generatedAt > this.ttlMs) return true;
    return false;
  }

  async set(id: string, buffer: Buffer, dataHash: string): Promise<void> {
    this.cache.set(id, {
      buffer,
      generatedAt: Date.now(),
      dataHash,
    });
    const filePath = path.join(this.dir, `${id}.png`);
    await fs.writeFile(filePath, buffer);
  }

  async loadFromDisk(id: string): Promise<Buffer | null> {
    try {
      const filePath = path.join(this.dir, `${id}.png`);
      return await fs.readFile(filePath);
    } catch {
      return null;
    }
  }

  getAll(): Map<string, CacheEntry> {
    return this.cache;
  }

  clear(): void {
    this.cache.clear();
  }
}
