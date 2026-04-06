import { Octokit } from '@octokit/rest';
import type { OxloClient } from '../oxlo/client.js';
import { analyzeIssue } from '../pipeline.js';
import { saveAnalysis, getIssueSummaries } from '../storage/db.js';
import { findSimilarCandidates, buildIndex } from '../storage/embeddings.js';
import { createLogger, printIssueSummaryRow } from '../utils/logger.js';

const log = createLogger('batch-scan');

/** Result of scanning a single issue. */
export interface ScanResult {
  issueNumber: number;
  title: string;
  url: string;
  type: string;
  severityScore: number;
  severityLabel: string;
  severityReason: string;
  affectedModule: string;
  duplicateIds: string[];
  skipped: boolean;
  skipReason?: string;
  error?: string;
}

/** Options for batch scanning. */
export interface BatchScanOptions {
  /** Maximum number of issues to scan (default 20). */
  limit?: number;
  /** Skip issues already labeled with 'issueradar'. */
  skipLabeled?: boolean;
  /** Only scan issues matching this type (undefined = all). */
  filterType?: 'bug' | 'feature' | 'question' | 'noise';
  /** Delay between API calls in ms to avoid rate limits (default 500). */
  delayMs?: number;
  /** Called after each issue is processed (for progress reporting). */
  onProgress?: (result: ScanResult, index: number, total: number) => void;
}

/**
 * Fetches open issues from a GitHub repository and runs the full 4-call
 * Oxlo pipeline on each one, saving results to the database.
 *
 * @param owner   - Repository owner (org or user)
 * @param repo    - Repository name
 * @param client  - Initialized OxloClient
 * @param options - Scan configuration
 * @returns Array of scan results — one per issue processed
 */
export async function batchScanRepo(
  owner: string,
  repo: string,
  client: OxloClient,
  options: BatchScanOptions = {}
): Promise<ScanResult[]> {
  const {
    limit = 20,
    skipLabeled = true,
    filterType,
    delayMs = 500,
    onProgress,
  } = options;

  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

  log.info(`Fetching open issues from ${owner}/${repo}...`);

  const { data: issues } = await octokit.issues.listForRepo({
    owner,
    repo,
    state: 'open',
    per_page: Math.min(limit * 2, 100), // over-fetch to account for skips
    sort: 'created',
    direction: 'desc',
  });

  // Filter out pull requests (GitHub API includes them in issues endpoint)
  const filteredIssues = issues
    .filter((i) => !('pull_request' in i))
    .filter((i) => !skipLabeled || !i.labels.some((l) => (typeof l === 'string' ? l : l.name) === 'issueradar'))
    .slice(0, limit);

  log.info(`Found ${filteredIssues.length} issues to scan`);

  const results: ScanResult[] = [];

  for (let i = 0; i < filteredIssues.length; i++) {
    const issue = filteredIssues[i]!;
    const text = `${issue.title}\n\n${issue.body ?? ''}`.trim();

    if (!text || text.length < 20) {
      const result: ScanResult = {
        issueNumber: issue.number,
        title: issue.title,
        url: issue.html_url,
        type: 'noise',
        severityScore: 1,
        severityLabel: 'severity/trivial',
        severityReason: 'Too short to analyze',
        affectedModule: '',
        duplicateIds: [],
        skipped: true,
        skipReason: 'body too short',
      };
      results.push(result);
      onProgress?.(result, i, filteredIssues.length);
      continue;
    }

    try {
      // Build dedup candidates from what we've already scanned this session
      const summaries = getIssueSummaries(50);
      const candidates = findSimilarCandidates(text, buildIndex(summaries));

      const { result: analysis, trace } = await analyzeIssue(client, {
        text,
        source: 'github_issue',
        sourceId: `${owner}/${repo}#${issue.number}`,
        sourceUrl: issue.html_url,
        existingIssues: candidates,
      });

      // Apply type filter after classification (we can't pre-filter without running Call 1)
      if (filterType && analysis.classification.type !== filterType) {
        const result: ScanResult = {
          issueNumber: issue.number,
          title: issue.title,
          url: issue.html_url,
          type: analysis.classification.type,
          severityScore: analysis.severity.score,
          severityLabel: analysis.severity.label,
          severityReason: analysis.severity.reason,
          affectedModule: analysis.extracted.affectedModule,
          duplicateIds: analysis.deduplication.duplicateIds,
          skipped: true,
          skipReason: `type=${analysis.classification.type} (filter=${filterType})`,
        };
        results.push(result);
        onProgress?.(result, i, filteredIssues.length);
        continue;
      }

      saveAnalysis(text, analysis);

      const result: ScanResult = {
        issueNumber: issue.number,
        title: issue.title,
        url: issue.html_url,
        type: analysis.classification.type,
        severityScore: analysis.severity.score,
        severityLabel: analysis.severity.label,
        severityReason: analysis.severity.reason,
        affectedModule: analysis.extracted.affectedModule,
        duplicateIds: analysis.deduplication.duplicateIds,
        skipped: false,
      };

      results.push(result);
      onProgress?.(result, i, filteredIssues.length);

      log.success(
        `#${issue.number} → ${analysis.classification.type} severity=${analysis.severity.score} ` +
          `(classify=${trace.classifyMs}ms extract=${trace.extractMs}ms score+dedup=${trace.scoreMs}ms)`
      );
    } catch (err) {
      const result: ScanResult = {
        issueNumber: issue.number,
        title: issue.title,
        url: issue.html_url,
        type: 'unknown',
        severityScore: 0,
        severityLabel: '',
        severityReason: '',
        affectedModule: '',
        duplicateIds: [],
        skipped: false,
        error: err instanceof Error ? err.message : String(err),
      };
      results.push(result);
      onProgress?.(result, i, filteredIssues.length);
      log.error(`#${issue.number} failed: ${result.error}`);
    }

    // Rate-limit courtesy delay between issues
    if (i < filteredIssues.length - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  return results;
}

/**
 * Prints a summary table of batch scan results to stdout.
 *
 * @param results - Results from batchScanRepo
 * @param repo    - "owner/repo" string for the header
 */
export function printScanSummary(results: ScanResult[], repo: string): void {
  const processed = results.filter((r) => !r.skipped && !r.error);
  const errors = results.filter((r) => r.error);
  const skipped = results.filter((r) => r.skipped);
  const dupes = processed.filter((r) => r.duplicateIds.length > 0);

  console.info('');
  console.info(`\x1b[1m  Batch Scan: ${repo}\x1b[0m`);
  console.info(`  ${'─'.repeat(76)}`);
  console.info(
    `  \x1b[2m${'#'.padEnd(6)}${'SEV'.padEnd(4)}${'TYPE'.padEnd(9)}${'MODULE'.padEnd(21)}TITLE\x1b[0m`
  );
  console.info(`  ${'─'.repeat(76)}`);

  const sorted = [...processed].sort((a, b) => b.severityScore - a.severityScore);
  sorted.forEach((r, i) =>
    printIssueSummaryRow(i, r.issueNumber, r.title, r.severityScore, r.type, r.affectedModule, r.duplicateIds.length > 0)
  );

  console.info(`  ${'─'.repeat(76)}`);
  console.info(
    `  Processed: ${processed.length}  ` +
      `Bugs: ${processed.filter((r) => r.type === 'bug').length}  ` +
      `Dupes caught: ${dupes.length}  ` +
      `Skipped: ${skipped.length}  ` +
      `Errors: ${errors.length}`
  );
  console.info('');
}
