import { createHash } from 'node:crypto';
import type { AiConfig } from '../config/index.js';
import { STOP_WORDS } from '../db/repos/memory.js';

export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  /** True when vectors come from a trained model rather than a local transform. */
  readonly isSemantic: boolean;
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
}

/**
 * Local, dependency-free embedding.
 *
 * Tokens are hashed into a fixed-width vector with sub-word shingles and
 * sqrt-scaled term frequency, then L2-normalised. That makes cosine similarity
 * behave like a smoothed lexical overlap measure: it generalises over word
 * order, inflection and typos, but it does NOT capture meaning the way a
 * trained embedding model does — "car" and "automobile" stay far apart.
 *
 * It is the default because it needs no API key and is deterministic. Point
 * EMBEDDINGS_PROVIDER at a real model when semantic recall matters; the
 * retrieval code above does not change.
 */
export class LocalHashEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'local-hash';
  readonly isSemantic = false;

  constructor(readonly dimensions: number = 384) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.embedOne(text));
  }

  embedOne(text: string): Float32Array {
    const vector = new Float32Array(this.dimensions);
    const tokens = tokenize(text);
    if (tokens.length === 0) return vector;

    const counts = new Map<string, number>();
    const add = (feature: string, weight: number) => {
      counts.set(feature, (counts.get(feature) ?? 0) + weight);
    };

    for (const token of tokens) {
      add(token, 1);
      // Character shingles give partial credit for morphological variants.
      for (const shingle of shingles(token, 4)) add(`#${shingle}`, 0.35);
    }
    // Adjacent-word bigrams retain a little word-order signal.
    for (let i = 0; i + 1 < tokens.length; i++) {
      add(`${tokens[i]}_${tokens[i + 1]}`, 0.5);
    }

    for (const [feature, count] of counts) {
      const idx = hashToIndex(feature, this.dimensions);
      // Signed hashing keeps collisions from systematically inflating a bucket.
      const sign = hashToIndex(`s:${feature}`, 2) === 0 ? 1 : -1;
      vector[idx] = (vector[idx] ?? 0) + sign * Math.sqrt(count);
    }

    return normalize(vector);
  }
}

/** Voyage AI embeddings (Anthropic's recommended embedding partner). */
export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'voyage';
  readonly isSemantic = true;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    readonly dimensions: number,
    private readonly baseUrl = 'https://api.voyageai.com/v1',
  ) {}

  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ input: texts, model: this.model }),
      signal: signal ?? null,
    });
    if (!response.ok) {
      throw new Error(`Voyage embeddings ${response.status}: ${await response.text()}`);
    }
    const payload = (await response.json()) as { data: Array<{ embedding: number[] }> };
    return payload.data.map((row) => normalize(Float32Array.from(row.embedding)));
  }
}

/** OpenAI-compatible embeddings endpoint. */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly isSemantic = true;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    readonly dimensions: number,
    private readonly baseUrl = 'https://api.openai.com/v1',
  ) {}

  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ input: texts, model: this.model, dimensions: this.dimensions }),
      signal: signal ?? null,
    });
    if (!response.ok) {
      throw new Error(`OpenAI embeddings ${response.status}: ${await response.text()}`);
    }
    const payload = (await response.json()) as { data: Array<{ embedding: number[] }> };
    return payload.data.map((row) => normalize(Float32Array.from(row.embedding)));
  }
}

export function createEmbeddingProvider(config: AiConfig['embeddings']): EmbeddingProvider {
  switch (config.provider) {
    case 'voyage':
      if (!config.apiKey) break;
      return new VoyageEmbeddingProvider(
        config.apiKey,
        config.model,
        config.dimensions,
        config.baseUrl ?? undefined,
      );
    case 'openai':
      if (!config.apiKey) break;
      return new OpenAIEmbeddingProvider(
        config.apiKey,
        config.model,
        config.dimensions,
        config.baseUrl ?? undefined,
      );
    case 'local':
      break;
  }
  return new LocalHashEmbeddingProvider(config.dimensions);
}

// ---------------------------------------------------------------------------

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  // Both vectors are stored normalised, so the dot product is the cosine.
  return dot;
}

function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += (vector[i] ?? 0) ** 2;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vector;
  for (let i = 0; i < vector.length; i++) vector[i] = (vector[i] ?? 0) / norm;
  return vector;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t))
    .slice(0, 512);
}

function shingles(token: string, size: number): string[] {
  if (token.length <= size) return [token];
  const out: string[] = [];
  for (let i = 0; i + size <= token.length; i++) out.push(token.slice(i, i + size));
  return out;
}

function hashToIndex(feature: string, modulo: number): number {
  const digest = createHash('sha1').update(feature).digest();
  // 32 bits of the digest is plenty of entropy for a bucket index.
  const value = digest.readUInt32BE(0);
  return value % modulo;
}
