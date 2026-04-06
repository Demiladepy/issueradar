import type { OxloClient } from './oxlo-client.js';

export interface IssueSummary {
  id: string;
  title: string;
  description: string;
  affectedModule: string;
}

export interface DeduplicationResult {
  duplicateIds: string[];
  confidence: number;
}

const SYSTEM_PROMPT = `You are a GitHub issue deduplication engine.
Given a new issue and existing issue summaries, identify duplicates.
Return empty duplicateIds if no duplicates found.
Output ONLY valid JSON: {"duplicateIds": ["id1"], "confidence": 0.0-1.0}`;

export async function findDuplicateIssues(
  client: OxloClient,
  newIssueText: string,
  existingIssues: IssueSummary[]
): Promise<DeduplicationResult> {
  if (existingIssues.length === 0) return { duplicateIds: [], confidence: 0 };

  const raw = await client.chat(
    [{ role: 'user', content: `New issue:\n${newIssueText}\n\nExisting:\n${JSON.stringify(existingIssues)}` }],
    SYSTEM_PROMPT
  );
  const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(cleaned) as DeduplicationResult;
}
