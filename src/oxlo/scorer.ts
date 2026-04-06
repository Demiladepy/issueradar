import { z } from 'zod';
import type { OxloClient } from './client.js';
import type { ExtractedIssue } from './extractor.js';

/** Severity score with justification from Call 3. */
export interface SeverityResult {
  /** 1 = trivial, 5 = critical/data loss/security */
  score: 1 | 2 | 3 | 4 | 5;
  /** One-line human-readable justification */
  reason: string;
  /** Suggested GitHub label */
  label: 'severity/critical' | 'severity/high' | 'severity/medium' | 'severity/low' | 'severity/trivial';
}

const SeverityResultSchema = z.object({
  score: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  reason: z.string(),
  label: z.enum([
    'severity/critical',
    'severity/high',
    'severity/medium',
    'severity/low',
    'severity/trivial',
  ]),
});

const SYSTEM_PROMPT = `You are a software bug severity scorer.

Score the severity of a GitHub issue from 1 to 5 based on:
- User impact: How many users are affected? How severely?
- Frequency signals: Words like "always", "intermittent", "sometimes"
- Affected surface: Core functionality vs edge case
- Data loss / security implications

Severity scale:
- 5 (critical): Data loss, security vulnerability, complete feature outage affecting all users
- 4 (high): Major feature broken, affects many users, no workaround
- 3 (medium): Feature partially broken, workaround exists, moderate user impact
- 2 (low): Minor issue, cosmetic, rare edge case, easy workaround
- 1 (trivial): Typo, documentation, negligible user impact

Label mapping:
- 5 → severity/critical
- 4 → severity/high
- 3 → severity/medium
- 2 → severity/low
- 1 → severity/trivial

Output ONLY valid JSON, no markdown fences, no explanation.

Output format: {"score": 1-5, "reason": "one-line justification", "label": "severity/..."}`;

/**
 * Call 3 — Scores issue severity on a 1–5 scale with justification.
 *
 * @param client    - Initialized OxloClient
 * @param extracted - Structured issue fields from Call 2
 * @returns Severity score, reason, and suggested GitHub label
 */
export async function scoreIssueSeverity(
  client: OxloClient,
  extracted: ExtractedIssue
): Promise<SeverityResult> {
  const userMessage = JSON.stringify(extracted);

  const raw = await client.chat([{ role: 'user', content: userMessage }], SYSTEM_PROMPT);

  const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const parsed = JSON.parse(cleaned) as unknown;
  return SeverityResultSchema.parse(parsed);
}
