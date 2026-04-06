import { z } from 'zod';
import type { OxloClient } from './client.js';

/** A summary of an existing issue used for deduplication comparison. */
export interface IssueSummary {
  id: string;
  title: string;
  description: string;
  affectedModule: string;
}

/** Result of Call 4 — duplicate detection. */
export interface DeduplicationResult {
  /** IDs of existing issues that are likely duplicates of the new issue */
  duplicateIds: string[];
  /** Confidence score for the best duplicate match (0 if no duplicates found) */
  confidence: number;
}

const DeduplicationResultSchema = z.object({
  duplicateIds: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

const SYSTEM_PROMPT = `You are a GitHub issue deduplication engine.

Given a new issue and a list of existing issue summaries, identify which existing issues
are likely duplicates or closely related to the new issue.

Two issues are duplicates if they:
- Describe the same root cause or bug
- Affect the same component with the same unexpected behavior
- Would be resolved by the same fix

Two issues are NOT duplicates if they:
- Affect different modules
- Have the same symptoms but clearly different root causes
- One is a feature request and one is a bug

Return an empty duplicateIds array if no duplicates are found.
confidence should reflect your confidence in the BEST match (0.0 if no matches).

Output ONLY valid JSON, no markdown fences, no explanation.

Output format: {"duplicateIds": ["id1", "id2"], "confidence": 0.0-1.0}`;

/**
 * Call 4 — Detects duplicate issues by comparing against existing issue summaries.
 * Runs in parallel with Call 3 (scorer).
 *
 * @param client         - Initialized OxloClient
 * @param newIssueText   - The new issue title + body + extracted fields as text
 * @param existingIssues - Array of existing issue summaries from the database
 * @returns List of duplicate issue IDs and confidence score
 */
export async function findDuplicateIssues(
  client: OxloClient,
  newIssueText: string,
  existingIssues: IssueSummary[]
): Promise<DeduplicationResult> {
  if (existingIssues.length === 0) {
    return { duplicateIds: [], confidence: 0 };
  }

  const userMessage = `New issue:
${newIssueText}

Existing issues to compare against:
${JSON.stringify(existingIssues, null, 2)}`;

  const raw = await client.chat([{ role: 'user', content: userMessage }], SYSTEM_PROMPT);

  const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const parsed = JSON.parse(cleaned) as unknown;
  return DeduplicationResultSchema.parse(parsed);
}
