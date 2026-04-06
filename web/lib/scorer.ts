import type { OxloClient } from './oxlo-client.js';
import type { ExtractedIssue } from './extractor.js';

export interface SeverityResult {
  score: 1 | 2 | 3 | 4 | 5;
  reason: string;
  label: 'severity/critical' | 'severity/high' | 'severity/medium' | 'severity/low' | 'severity/trivial';
}

const SYSTEM_PROMPT = `You are a bug severity scorer. Score 1–5 where:
5=critical (data loss/security/full outage), 4=high (major feature broken),
3=medium (partial breakage, workaround exists), 2=low (minor/edge case), 1=trivial (cosmetic)
Label mapping: 5→severity/critical, 4→severity/high, 3→severity/medium, 2→severity/low, 1→severity/trivial
Output ONLY valid JSON: {"score": 1-5, "reason": "one-line justification", "label": "severity/..."}`;

export async function scoreIssueSeverity(
  client: OxloClient,
  extracted: ExtractedIssue
): Promise<SeverityResult> {
  const raw = await client.chat(
    [{ role: 'user', content: JSON.stringify(extracted) }],
    SYSTEM_PROMPT
  );
  const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(cleaned) as SeverityResult;
}
