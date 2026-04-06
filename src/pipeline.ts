import { OxloClient } from './oxlo/client.js';
import { classifyIssue, type ClassificationResult } from './oxlo/classifier.js';
import { extractIssueFields, type ExtractedIssue } from './oxlo/extractor.js';
import { scoreIssueSeverity, type SeverityResult } from './oxlo/scorer.js';
import { findDuplicateIssues, type IssueSummary, type DeduplicationResult } from './oxlo/deduplicator.js';

/** Source system from which the issue originated. */
export type IssueSource = 'github_issue' | 'github_pr_comment' | 'slack';

/** Input to the analysis pipeline. */
export interface PipelineInput {
  /** Combined title + body text of the issue or message */
  text: string;
  /** Where the issue came from */
  source: IssueSource;
  /** Original ID in the source system (GitHub issue number, Slack message ts, etc.) */
  sourceId: string;
  /** URL to the original item */
  sourceUrl: string;
  /** Existing issue summaries to check for duplicates */
  existingIssues: IssueSummary[];
}

/** Full result of the 4-call Oxlo analysis pipeline. */
export interface AnalysisResult {
  source: IssueSource;
  sourceId: string;
  sourceUrl: string;
  /** Call 1 output */
  classification: ClassificationResult;
  /** Call 2 output */
  extracted: ExtractedIssue;
  /** Call 3 output */
  severity: SeverityResult;
  /** Call 4 output */
  deduplication: DeduplicationResult;
  /** ISO timestamp of analysis */
  analyzedAt: string;
}

/** Tracks timing for each pipeline call for the demo dashboard. */
export interface PipelineTrace {
  classifyMs: number;
  extractMs: number;
  scoreMs: number;
  deduplicateMs: number;
  totalMs: number;
}

/**
 * Runs the full 4-call Oxlo AI analysis pipeline on a single issue.
 *
 * Call order:
 *   1. classify  (sequential)
 *   2. extract   (sequential, depends on 1)
 *   3. score     (parallel with 4)
 *   4. deduplicate (parallel with 3)
 *
 * @param client - Initialized OxloClient
 * @param input  - Issue text, source metadata, and existing issues for dedup
 * @returns Full analysis result + pipeline timing trace
 */
export async function analyzeIssue(
  client: OxloClient,
  input: PipelineInput
): Promise<{ result: AnalysisResult; trace: PipelineTrace }> {
  const pipelineStart = Date.now();

  // ── Call 1: Classify ──────────────────────────────────────────────────────
  const classifyStart = Date.now();
  const classification = await classifyIssue(client, input.text);
  const classifyMs = Date.now() - classifyStart;

  // ── Call 2: Extract ───────────────────────────────────────────────────────
  const extractStart = Date.now();
  const extracted = await extractIssueFields(client, input.text, classification.type);
  const extractMs = Date.now() - extractStart;

  // ── Calls 3 + 4 in parallel ───────────────────────────────────────────────
  const parallelStart = Date.now();

  const deduplicationText = `${extracted.title}\n${extracted.description}\nModule: ${extracted.affectedModule}`;

  const [severity, deduplication] = await Promise.all([
    scoreIssueSeverity(client, extracted),
    findDuplicateIssues(client, deduplicationText, input.existingIssues),
  ]);

  const parallelMs = Date.now() - parallelStart;
  const totalMs = Date.now() - pipelineStart;

  const result: AnalysisResult = {
    source: input.source,
    sourceId: input.sourceId,
    sourceUrl: input.sourceUrl,
    classification,
    extracted,
    severity,
    deduplication,
    analyzedAt: new Date().toISOString(),
  };

  const trace: PipelineTrace = {
    classifyMs,
    extractMs,
    // Score and dedup ran in parallel — split parallelMs evenly for display purposes
    scoreMs: parallelMs,
    deduplicateMs: parallelMs,
    totalMs,
  };

  return { result, trace };
}
