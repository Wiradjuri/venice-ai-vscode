import * as vscode from 'vscode';
import * as path from 'path';
import { CodeChunk, ScoredChunk } from './types';

// Scoring weights
const EMBEDDING_WEIGHT = 0.5;
const IMPORT_DISTANCE_WEIGHT = 0.2;
const PATH_PROXIMITY_WEIGHT = 0.15;
const RECENCY_WEIGHT = 0.15;

// Distance constants
const SAME_DIRECTORY_DISTANCE = 0.2;
const DEPTH_MULTIPLIER = 0.3;
const PATH_DEPTH_UNIT = 30;
const RECENCY_UNKNOWN_SCORE = 0.3;
const RECENCY_DECAY_HOURS = 168; // 1 week

export class RelevanceRanker {
  private workspaceRoot: string;
  private currentFileUri: string = '';

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  setCurrentFile(uri: string): void {
    this.currentFileUri = uri;
  }

  /**
   * Re-rank scored chunks using multiple signals
   */
  async rank(scored: readonly ScoredChunk[]): Promise<ScoredChunk[]> {
    // Compute additional signals for each chunk
    const enhanced = scored.map((item: ScoredChunk) => {
      const signals = {
        embeddingScore: item.score, // already set by EmbeddingStore
        importDistance: this.computeImportDistance(item.chunk),
        pathProximity: this.computePathProximity(item.chunk),
        recencyScore: this.computeRecencyScore(item.chunk),
      };

      // Combine signals into final score
      const INVERSE_IMPORT_DISTANCE = 1 - signals.importDistance;
      const finalScore =
        signals.embeddingScore * EMBEDDING_WEIGHT + // embedding similarity is primary
        INVERSE_IMPORT_DISTANCE * IMPORT_DISTANCE_WEIGHT + // prefer nearby imports
        signals.pathProximity * PATH_PROXIMITY_WEIGHT + // prefer nearby paths
        signals.recencyScore * RECENCY_WEIGHT; // prefer recently edited

      return {
        ...item,
        score: finalScore,
        signals,
      };
    });

    return enhanced.sort((a, b) => b.score - a.score);
  }

  private computeImportDistance(chunk: CodeChunk): number {
    // Placeholder: would use LSP references to compute actual distance
    // For now, prefer chunks from same file and similar-named files
    if (chunk.uri === this.currentFileUri) {
      return 0; // same file is closest
    }

    const chunkDir = path.dirname(chunk.uri);
    const currentDir = path.dirname(this.currentFileUri);

    if (chunkDir === currentDir) {
      return 0.2; // same directory
    }

    const commonPrefix = this.commonPathPrefix(chunkDir, currentDir);
    const depth = (currentDir.length - commonPrefix.length) / 30; // rough depth estimate
    return Math.min(1, depth * 0.3);
  }

  private computePathProximity(chunk: CodeChunk): number {
    // Prefer chunks from structurally similar paths (e.g., src/components vs src/pages)
    const chunkPath = chunk.uri;
    const currentPath = this.currentFileUri;

    const chunkParts = chunkPath.split(path.sep);
    const currentParts = currentPath.split(path.sep);

    let matches = 0;
    for (let i = 0; i < Math.min(chunkParts.length, currentParts.length); i++) {
      if (chunkParts[i] === currentParts[i]) {
        matches++;
      } else {
        break;
      }
    }

    return Math.min(1, matches / Math.max(chunkParts.length, currentParts.length));
  }

  private computeRecencyScore(chunk: CodeChunk): number {
    // Prefer recently modified chunks (0 = very old, 1 = just now)
    if (!chunk.lastModified) {
      return 0.3; // unknown age gets mild boost
    }

    const ageMs = Date.now() - chunk.lastModified;
    const ageHours = ageMs / (1000 * 60 * 60);

    // Decay: recent is better, but don't overly bias toward current edits
    return Math.max(0, 1 - ageHours / 168); // 1 week decay window
  }

  private commonPathPrefix(a: string, b: string): string {
    const parts1 = a.split(path.sep);
    const parts2 = b.split(path.sep);

    let common = '';
    for (let i = 0; i < Math.min(parts1.length, parts2.length); i++) {
      if (parts1[i] === parts2[i]) {
        common += (common ? path.sep : '') + parts1[i];
      } else {
        break;
      }
    }

    return common;
  }
}
