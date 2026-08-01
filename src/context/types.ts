// Core types for context indexing system

export interface CodeChunk {
  uri: string; // VS Code URI
  startLine: number;
  endLine: number;
  content: string;
  language: string;
  type: 'symbol' | 'tree' | 'window'; // how it was chunked
  lastModified?: number; // timestamp
}

export interface EmbeddedChunk extends CodeChunk {
  embedding: Float32Array; // 1536-dim vector
  contentHash: string; // for change detection
}

export interface ScoredChunk {
  chunk: CodeChunk;
  score: number; // 0-1, higher is more relevant
  signals: {
    embeddingScore: number;
    importDistance: number; // 0-1, lower is closer
    pathProximity: number; // 0-1, higher is closer
    recencyScore: number; // 0-1, higher is more recent
  };
}

export interface IndexStatus {
  state: 'idle' | 'indexing' | 'error';
  filesIndexed: number;
  totalFiles: number;
  progress: number; // 0-100
  error?: string;
  lastUpdated?: number;
  sizeBytes?: number; // on-disk size of the embedding database
  sizeCapped?: boolean; // true if the background sweep stopped early due to the size cap
}
