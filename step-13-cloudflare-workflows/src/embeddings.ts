/**
 * EMBEDDINGS: text in, a list of 1,024 numbers out, so that texts with similar meaning
 * get similar numbers.
 *
 * The question and the passages MUST be embedded by the same model. Each model has its
 * own "map" of meaning: a vector from one model compared with a vector from another is
 * noise. That's why every stored vector records its model (the `embedder` column), and a
 * search only compares vectors from the model it used for the question.
 */

export const DIMENSIONS = 1024;
export const BGE_M3 = "@cf/baai/bge-m3";
export const TEST_EMBEDDER = "test-hash-v1";

export interface Embedder {
  /** Stored with every vector; searches only compare vectors with the same name. */
  name: string;
  embed(texts: string[]): Promise<number[][]>;
}

/** Fails loudly unless every vector has exactly 1,024 finite numbers. */
export function checkVectors(vectors: number[][], expected: number): number[][] {
  if (vectors.length !== expected) throw new Error(`Expected ${expected} embeddings, got ${vectors.length}.`);
  for (const v of vectors) {
    if (!Array.isArray(v) || v.length !== DIMENSIONS || !v.every(Number.isFinite)) {
      throw new Error(`An embedding has ${Array.isArray(v) ? v.length : "no"} numbers; expected ${DIMENSIONS}.`);
    }
  }
  return vectors;
}

/** bge-m3 on Workers AI, through the Worker's AI binding. Free daily allowance applies. */
export function workersAiEmbedder(ai: Ai): Embedder {
  const BATCH = 50;
  return {
    name: BGE_M3,
    async embed(texts) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        const batch = texts.slice(i, i + BATCH);
        const result = (await ai.run(BGE_M3, { text: batch })) as { data?: number[][] };
        out.push(...(result.data ?? []));
      }
      return checkVectors(out, texts.length);
    },
  };
}

const STOPWORDS = new Set(
  "a an and are as at be by can do does for from has have how i if in is it may me my of on or our the to we what when which who will with you your".split(
    " ",
  ),
);

/** Crude word stems, so "returns", "returned" and "return" land together. */
const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, "").slice(0, 12);

/** FNV-1a: a fast, stable string hash. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/**
 * A DETERMINISTIC test embedder: no model, no network, same output every run. Each word
 * stem (and its 3-letter pieces, more weakly) adds to a few of the 1,024 positions. It
 * matches shared WORDS, not meaning, so it scores lower than bge-m3 on paraphrases; the
 * retrieval eval keeps a separate baseline for it. Used by unit tests and CI.
 */
export function testEmbedder(): Embedder {
  return {
    name: TEST_EMBEDDER,
    async embed(texts) {
      return texts.map((text) => {
        const v = new Array<number>(DIMENSIONS).fill(0);
        const add = (feature: string, weight: number) => {
          const h = hash(feature);
          v[h % DIMENSIONS]! += (h & 0x8000_0000 ? -1 : 1) * weight;
        };
        const words = (text.toLowerCase().match(/[a-z0-9%]+/g) ?? []).filter((w) => !STOPWORDS.has(w)).map(stem);
        for (const w of words) {
          add(`w:${w}`, 1);
          for (let i = 0; i + 3 <= w.length; i++) add(`t:${w.slice(i, i + 3)}`, 0.3);
        }
        const norm = Math.hypot(...v) || 1;
        return v.map((x) => x / norm);
      });
    },
  };
}

/** The Worker's embedder: the real model, unless EMBEDDINGS=test (tests and CI). */
export function chooseEmbedder(env: { AI: Ai; EMBEDDINGS?: string }): Embedder {
  return env.EMBEDDINGS === "test" ? testEmbedder() : workersAiEmbedder(env.AI);
}

/** pgvector's text format: "[0.1,0.2,...]", passed as a query parameter and cast with ::vector. */
export const toPgVector = (v: number[]) => `[${v.join(",")}]`;

/** Cosine similarity (1 = same direction). pgvector's <=> is 1 minus this. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
