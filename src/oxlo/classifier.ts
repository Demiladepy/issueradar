import { z } from 'zod';
import type { OxloClient } from './client.js';

/** The category of a GitHub issue or PR comment. */
export type IssueType = 'bug' | 'feature' | 'question' | 'noise';

/** Result of Call 1 — type classification. */
export interface ClassificationResult {
  type: IssueType;
  confidence: number;
}

const ClassificationSchema = z.object({
  type: z.enum(['bug', 'feature', 'question', 'noise']),
  confidence: z.number().min(0).max(1),
});

const SYSTEM_PROMPT = `You are a GitHub issue classifier.

Classify the given GitHub issue or PR comment as exactly one of:
- bug: Something is broken or not working as expected
- feature: A request for new functionality or enhancement
- question: A question about how something works
- noise: Spam, test issue, off-topic, or too vague to act on

Rules:
- Output ONLY valid JSON, no markdown fences, no explanation
- confidence is a float from 0.0 to 1.0
- When unsure between bug and feature, prefer bug

Output format: {"type": "bug"|"feature"|"question"|"noise", "confidence": 0.0-1.0}`;

/**
 * Call 1 — Classifies a GitHub issue or PR comment into a category.
 *
 * @param client - Initialized OxloClient
 * @param text   - Raw issue title + body or PR comment text
 * @returns Classification type and confidence score
 */
export async function classifyIssue(
  client: OxloClient,
  text: string
): Promise<ClassificationResult> {
  const raw = await client.chat([{ role: 'user', content: text }], SYSTEM_PROMPT);

  const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const parsed = JSON.parse(cleaned) as unknown;
  return ClassificationSchema.parse(parsed);
}
