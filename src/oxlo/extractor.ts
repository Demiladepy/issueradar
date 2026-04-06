import { z } from 'zod';
import type { OxloClient } from './client.js';
import type { IssueType } from './classifier.js';

/** Structured fields extracted from a raw GitHub issue. */
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

const ExtractedIssueSchema = z.object({
  title: z.string(),
  description: z.string(),
  stepsToReproduce: z.array(z.string()),
  expectedBehavior: z.string(),
  actualBehavior: z.string(),
  affectedModule: z.string(),
  affectedVersion: z.string().nullable(),
  environment: z.string().nullable(),
});

const SYSTEM_PROMPT = `You are a bug report field extractor for GitHub issues.

Given a raw GitHub issue and its classification type, extract structured fields.
If a field cannot be determined from the text, use an empty string or null.
For stepsToReproduce, return an array of step strings (empty array if none found).

Output ONLY valid JSON, no markdown fences, no explanation.

Output format:
{
  "title": "concise one-line title",
  "description": "full description of the issue",
  "stepsToReproduce": ["step 1", "step 2"],
  "expectedBehavior": "what should happen",
  "actualBehavior": "what actually happens",
  "affectedModule": "module/component/file most likely affected",
  "affectedVersion": "version string or null",
  "environment": "OS/browser/runtime details or null"
}`;

/**
 * Call 2 — Extracts structured bug report fields from raw issue text.
 *
 * @param client       - Initialized OxloClient
 * @param text         - Raw issue title + body text
 * @param issueType    - Classification result from Call 1 (informs extraction focus)
 * @returns Structured issue fields ready for storage and display
 */
export async function extractIssueFields(
  client: OxloClient,
  text: string,
  issueType: IssueType
): Promise<ExtractedIssue> {
  const userMessage = `Issue type: ${issueType}\n\n${text}`;

  const raw = await client.chat([{ role: 'user', content: userMessage }], SYSTEM_PROMPT);

  const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const parsed = JSON.parse(cleaned) as unknown;
  return ExtractedIssueSchema.parse(parsed);
}
