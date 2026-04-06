import type { OxloClient } from './oxlo-client.js';

export type IssueType = 'bug' | 'feature' | 'question' | 'noise';

export interface ClassificationResult {
  type: IssueType;
  confidence: number;
}

const SYSTEM_PROMPT = `You are a GitHub issue classifier.
Classify as: bug, feature, question, or noise.
Output ONLY valid JSON: {"type": "bug"|"feature"|"question"|"noise", "confidence": 0.0-1.0}`;

export async function classifyIssue(
  client: OxloClient,
  text: string
): Promise<ClassificationResult> {
  const raw = await client.chat([{ role: 'user', content: text }], SYSTEM_PROMPT);
  const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(cleaned) as ClassificationResult;
}
