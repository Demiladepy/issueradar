import type { OxloClient } from './oxlo-client.js';
import type { IssueType } from './classifier.js';

export interface ExtractedIssue {
  title: string;
  description: string;
  stepsToReproduce: string[];
  expectedBehavior: string;
  actualBehavior: string;
  affectedModule: string;
  affectedVersion: string | null;
  environment: string | null;
}

const SYSTEM_PROMPT = `You are a bug report field extractor.
Extract structured fields from a GitHub issue. Use empty string or null if a field cannot be determined.
Output ONLY valid JSON:
{
  "title": "concise one-line title",
  "description": "full description",
  "stepsToReproduce": ["step 1", "step 2"],
  "expectedBehavior": "...",
  "actualBehavior": "...",
  "affectedModule": "module/component name",
  "affectedVersion": "version string or null",
  "environment": "OS/browser/runtime or null"
}`;

export async function extractIssueFields(
  client: OxloClient,
  text: string,
  issueType: IssueType
): Promise<ExtractedIssue> {
  const raw = await client.chat(
    [{ role: 'user', content: `Issue type: ${issueType}\n\n${text}` }],
    SYSTEM_PROMPT
  );
  const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(cleaned) as ExtractedIssue;
}
