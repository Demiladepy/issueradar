/**
 * Lightweight semantic similarity layer for issue deduplication.
 *
 * Strategy: Uses TF-IDF cosine similarity for fast pre-filtering,
 * then passes candidates to the Oxlo deduplicator (Call 4) for semantic judgment.
 *
 * This avoids sending all N issues to Oxlo on every call — only the top K
 * TF-IDF candidates are passed to the LLM, keeping prompt size bounded.
 */

/** A term-frequency vector keyed by token. */
type TfVector = Map<string, number>;

/**
 * Tokenizes text into lowercase alphanumeric tokens, filtering stop words.
 *
 * @param text - Raw input text
 * @returns Array of normalized tokens
 */
export function tokenize(text: string): string[] {
  const STOP_WORDS = new Set([
    'the', 'a', 'an', 'is', 'it', 'in', 'on', 'at', 'to', 'for', 'of',
    'and', 'or', 'but', 'not', 'with', 'this', 'that', 'are', 'was', 'be',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'i', 'we', 'you', 'they', 'he', 'she',
  ]);

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

/**
 * Builds a term-frequency vector from a list of tokens.
 *
 * @param tokens - Tokenized text
 * @returns TF vector (normalized by document length)
 */
export function buildTfVector(tokens: string[]): TfVector {
  const freq = new Map<string, number>();
  for (const token of tokens) {
    freq.set(token, (freq.get(token) ?? 0) + 1);
  }
  // Normalize by document length
  for (const [term, count] of freq) {
    freq.set(term, count / tokens.length);
  }
  return freq;
}

/**
 * Computes cosine similarity between two TF vectors.
 *
 * @param a - First TF vector
 * @param b - Second TF vector
 * @returns Similarity score in [0, 1]
 */
export function cosineSimilarity(a: TfVector, b: TfVector): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const [term, tfA] of a) {
    dot += tfA * (b.get(term) ?? 0);
    normA += tfA * tfA;
  }
  for (const [, tfB] of b) {
    normB += tfB * tfB;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** An issue with precomputed TF vector for fast similarity search. */
export interface IndexedIssue {
  id: string;
  title: string;
  description: string;
  affectedModule: string;
  vector: TfVector;
}

/**
 * Ranks existing issues by TF-IDF similarity to the new issue text.
 * Returns only the top K candidates above a similarity threshold.
 *
 * @param newText       - The new issue text to match against
 * @param indexedIssues - Pre-indexed existing issues
 * @param topK          - Maximum number of candidates to return (default 10)
 * @param threshold     - Minimum similarity score to include (default 0.1)
 * @returns Top-K candidate issues sorted by similarity descending
 */
export function findSimilarCandidates(
  newText: string,
  indexedIssues: IndexedIssue[],
  topK = 10,
  threshold = 0.1
): IndexedIssue[] {
  const newVector = buildTfVector(tokenize(newText));

  const scored = indexedIssues
    .map((issue) => ({
      issue,
      score: cosineSimilarity(newVector, issue.vector),
    }))
    .filter((x) => x.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return scored.map((x) => x.issue);
}

/**
 * Converts a list of plain issue summaries into indexed issues with TF vectors.
 * Call this once at startup or when the index needs refreshing.
 *
 * @param summaries - Raw issue summaries from the database
 * @returns Indexed issues ready for similarity search
 */
export function buildIndex(
  summaries: Array<{ id: string; title: string; description: string; affectedModule: string }>
): IndexedIssue[] {
  return summaries.map((s) => ({
    id: s.id,
    title: s.title,
    description: s.description,
    affectedModule: s.affectedModule,
    vector: buildTfVector(tokenize(`${s.title} ${s.description} ${s.affectedModule}`)),
  }));
}
