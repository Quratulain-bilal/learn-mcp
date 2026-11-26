export const EMBEDDING_MODEL = "@cf/baai/bge-m3";
export const EMBEDDING_DIMENSIONS = 1024;

export interface AiBinding {
  run(model: string, input: { text: string[] }): Promise<{ data?: number[][] }>;
}

export interface EmbeddingEnv {
  AI?: AiBinding;
  EMBEDDING_MODE?: string;
}

export interface EmbeddingClient {
  model: string;
  embed(texts: readonly string[]): Promise<number[][]>;
}

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) return vector;
  return vector.map((value) => Number((value / magnitude).toFixed(6)));
}

export function deterministicEmbedding(text: string): number[] {
  const vector = Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  const words = text
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((word) => word.length > 2) ?? [];
  for (const word of words) {
    vector[hashToken(word) % EMBEDDING_DIMENSIONS] += 1;
  }
  for (let index = 0; index < words.length - 1; index += 1) {
    vector[hashToken(`${words[index]}_${words[index + 1]}`) % EMBEDDING_DIMENSIONS] += 0.5;
  }
  if (words.length === 0) vector[0] = 1;
  return normalize(vector);
}

export function createEmbeddingClient(env: EmbeddingEnv, mode = env.EMBEDDING_MODE): EmbeddingClient {
  if (mode === "test") {
    return {
      model: "deterministic-test",
      async embed(texts) {
        return texts.map(deterministicEmbedding);
      },
    };
  }

  if (!env.AI) {
    throw new Error("The AI binding is required for real embeddings. Use EMBEDDING_MODE=test only in CI.");
  }

  return {
    model: EMBEDDING_MODEL,
    async embed(texts) {
      if (texts.length === 0) return [];
      const result = await env.AI!.run(EMBEDDING_MODEL, { text: [...texts] });
      const data = result.data;
      if (!data || data.length !== texts.length) {
        throw new Error(`Expected ${texts.length} embedding(s), received ${data?.length ?? 0}.`);
      }
      for (const vector of data) {
        if (vector.length !== EMBEDDING_DIMENSIONS) {
          throw new Error(`Expected ${EMBEDDING_DIMENSIONS} dimensions, received ${vector.length}.`);
        }
      }
      return data;
    },
  };
}

export function vectorLiteral(vector: readonly number[]): string {
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Cannot use a ${vector.length}-dimension vector in a vector(1024) column.`);
  }
  return `[${vector.join(",")}]`;
}
