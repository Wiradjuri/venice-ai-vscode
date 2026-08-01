import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { CodeChunk, EmbeddedChunk, ScoredChunk } from './types';

interface EmbeddingModel {
  embed(text: string): Promise<Float32Array>;
}

export class EmbeddingStore {
  private db: Database.Database;
  private dbPath: string;
  private model: EmbeddingModel | null = null;
  private modelLoaded = false;

  constructor(storagePath: string) {
    this.dbPath = path.join(storagePath, 'venice-index.db');
    this.db = new Database(this.dbPath);
    this.initSchema();
  }

  /** On-disk size of the index database in bytes (0 if it hasn't been created yet). */
  getDatabaseSizeBytes(): number {
    try {
      return fs.statSync(this.dbPath).size;
    } catch {
      return 0;
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uri TEXT NOT NULL,
        startLine INTEGER NOT NULL,
        endLine INTEGER NOT NULL,
        content TEXT NOT NULL,
        language TEXT,
        type TEXT NOT NULL,
        contentHash TEXT UNIQUE NOT NULL,
        embedding BLOB NOT NULL,
        lastModified INTEGER,
        UNIQUE(uri, startLine, endLine)
      );

      CREATE INDEX IF NOT EXISTS idx_uri ON chunks(uri);
      CREATE INDEX IF NOT EXISTS idx_language ON chunks(language);
      CREATE INDEX IF NOT EXISTS idx_contentHash ON chunks(contentHash);
    `);
  }

  async loadModel(): Promise<void> {
    if (this.modelLoaded) {
      return;
    }

    try {
      // Lazy load @xenova/transformers to avoid blocking initialization
      const { pipeline } = await import('@xenova/transformers');
      const embeddingPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');

      this.model = {
        embed: async (text: string) => {
          const result = await embeddingPipeline(text, {
            pooling: 'mean',
            normalize: true,
          });
          // Convert to Float32Array
          const data = result.data as unknown;
          if (data instanceof Float32Array) {
            return data;
          }
          // Fallback: create Float32Array from array-like
          return new Float32Array(data as ArrayLike<number>);
        },
      };

      this.modelLoaded = true;
    } catch (error) {
      console.error('Failed to load embedding model:', error);
      throw new Error('Embedding model initialization failed');
    }
  }

  async upsert(chunk: CodeChunk): Promise<void> {
    if (!this.model || !this.modelLoaded) {
      throw new Error('Model not loaded. Call loadModel() first.');
    }

    // Check if content changed
    const existing = this.db
      .prepare('SELECT contentHash FROM chunks WHERE uri = ? AND startLine = ? AND endLine = ?')
      .get(chunk.uri, chunk.startLine, chunk.endLine) as { contentHash: string } | undefined;

    const hash = this.hashContent(chunk.content);

    // Skip if unchanged
    if (existing && existing.contentHash === hash) {
      return;
    }

    // Embed the content
    const embedding = await this.model.embed(chunk.content);

    // Store as binary blob (float32 array)
    const embeddingBlob = Buffer.from(embedding.buffer);

    const stmt = this.db.prepare(`
      INSERT INTO chunks (uri, startLine, endLine, content, language, type, contentHash, embedding, lastModified)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(contentHash) DO UPDATE SET
        embedding = excluded.embedding,
        lastModified = excluded.lastModified
    `);

    stmt.run(
      chunk.uri,
      chunk.startLine,
      chunk.endLine,
      chunk.content,
      chunk.language,
      chunk.type,
      hash,
      embeddingBlob,
      Date.now()
    );
  }

  async query(queryText: string, k: number = 10): Promise<ScoredChunk[]> {
    if (!this.model || !this.modelLoaded) {
      throw new Error('Model not loaded. Call loadModel() first.');
    }

    // Embed the query
    const queryVector = await this.model.embed(queryText);

    // Retrieve all chunks with embeddings
    const rows = this.db
      .prepare('SELECT id, uri, startLine, endLine, content, language, type, embedding FROM chunks')
      .all() as Array<{
      id: number;
      uri: string;
      startLine: number;
      endLine: number;
      content: string;
      language: string;
      type: string;
      embedding: Buffer;
    }>;

    // Compute cosine similarity
    const scores = rows.map(row => {
      const embedding = new Float32Array(row.embedding.buffer);
      const similarity = this.cosineSimilarity(queryVector, embedding);

      return {
        chunk: {
          uri: row.uri,
          startLine: row.startLine,
          endLine: row.endLine,
          content: row.content,
          language: row.language,
          type: row.type as 'symbol' | 'tree' | 'window',
        } as CodeChunk,
        score: similarity,
        signals: {
          embeddingScore: similarity,
          importDistance: 0, // placeholder, set by RelevanceRanker
          pathProximity: 0,
          recencyScore: 0,
        },
      } as ScoredChunk;
    });

    // Return top K by similarity
    return scores.sort((a, b) => b.score - a.score).slice(0, k);
  }

  async removeByUri(uri: string): Promise<void> {
    this.db.prepare('DELETE FROM chunks WHERE uri = ?').run(uri);
  }

  async clear(): Promise<void> {
    this.db.exec('DELETE FROM chunks');
  }

  private hashContent(content: string): string {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    let magA = 0;
    let magB = 0;

    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }

    magA = Math.sqrt(magA);
    magB = Math.sqrt(magB);

    if (magA === 0 || magB === 0) {
      return 0;
    }

    return dot / (magA * magB);
  }

  close(): void {
    this.db.close();
  }
}
