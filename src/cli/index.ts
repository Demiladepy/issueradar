#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { OxloClient } from '../oxlo/client.js';
import { analyzeIssue } from '../pipeline.js';
import { batchScanRepo, printScanSummary } from '../github/batch-scan.js';
import {
  saveAnalysis,
  getIssueSummaries,
  getTodaysIssues,
  getLatestDigest,
  getDashboardStats,
} from '../storage/db.js';
import { findSimilarCandidates, buildIndex } from '../storage/embeddings.js';
import { createLogger, printAnalysisResult } from '../utils/logger.js';

const log = createLogger('cli');

const program = new Command();

program
  .name('issueradar')
  .description('AI-powered GitHub issue triage using Oxlo AI')
  .version('1.0.0');

// ─────────────────────────────────────────────────────────────────────────────
// analyze <url-or-text>
// ─────────────────────────────────────────────────────────────────────────────
program
  .command('analyze <input>')
  .description('Analyze a single GitHub issue URL or raw text through the 4-call Oxlo pipeline')
  .option('--save', 'Save result to local SQLite database', false)
  .option('--json', 'Output raw JSON instead of formatted result', false)
  .action(async (input: string, opts: { save: boolean; json: boolean }) => {
    const client = new OxloClient();

    let text: string;
    let sourceUrl = input;
    let sourceId = 'cli-input';

    if (input.startsWith('https://github.com')) {
      log.info(`Fetching issue from GitHub: ${input}`);
      const fetched = await fetchGitHubIssue(input);
      if (!fetched) {
        log.error('Could not fetch issue. Check the URL and your GITHUB_TOKEN.');
        process.exit(1);
      }
      text = fetched.text;
      sourceId = fetched.id;
    } else {
      text = input;
    }

    log.info('Running 4-call Oxlo pipeline...');

    const summaries = getIssueSummaries(50);
    const candidates = findSimilarCandidates(text, buildIndex(summaries));

    const { result, trace } = await analyzeIssue(client, {
      text,
      source: 'github_issue',
      sourceId,
      sourceUrl,
      existingIssues: candidates,
    });

    log.step(1, 'classify', trace.classifyMs);
    log.step(2, 'extract', trace.extractMs);
    log.step(3, 'score (parallel)', trace.scoreMs);
    log.step(4, 'deduplicate (parallel)', trace.deduplicateMs);

    if (opts.json) {
      console.info(JSON.stringify({ result, trace }, null, 2));
    } else {
      printAnalysisResult({ ...result, trace });
    }

    if (opts.save) {
      const id = saveAnalysis(text, result);
      log.success(`Saved to database: ${id}`);
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// scan <owner/repo>
// ─────────────────────────────────────────────────────────────────────────────
program
  .command('scan <repo>')
  .description('Batch-scan all open issues in a GitHub repository')
  .option('-n, --limit <number>', 'Max issues to scan', '20')
  .option('--type <type>', 'Filter: bug | feature | question | noise')
  .option('--delay <ms>', 'Delay between API calls in ms', '500')
  .option('--save', 'Save all results to database', true)
  .option('--json', 'Output raw JSON at the end', false)
  .action(
    async (
      repo: string,
      opts: { limit: string; type?: string; delay: string; save: boolean; json: boolean }
    ) => {
      const parts = repo.split('/');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        log.error('Repo must be in "owner/repo" format, e.g. vercel/next.js');
        process.exit(1);
      }
      const [owner, repoName] = parts;
      const client = new OxloClient();

      log.info(`Scanning ${repo} — up to ${opts.limit} issues`);

      const results = await batchScanRepo(owner, repoName, client, {
        limit: parseInt(opts.limit, 10),
        filterType: opts.type as 'bug' | 'feature' | 'question' | 'noise' | undefined,
        delayMs: parseInt(opts.delay, 10),
        skipLabeled: true,
        onProgress: (_r, i, total) => {
          process.stdout.write(`\r  Progress: ${i + 1}/${total}`);
        },
      });

      process.stdout.write('\n');

      if (opts.json) {
        console.info(JSON.stringify(results, null, 2));
      } else {
        printScanSummary(results, repo);
      }
    }
  );

// ─────────────────────────────────────────────────────────────────────────────
// digest
// ─────────────────────────────────────────────────────────────────────────────
program
  .command('digest')
  .description("Print today's issue digest to stdout (or the last saved digest)")
  .option('--slack', 'Post digest to Slack instead of printing', false)
  .action(async (opts: { slack: boolean }) => {
    if (opts.slack) {
      log.info('Posting digest to Slack...');
      const { createSlackApp, getSlackClient } = await import('../slack/listener.js');
      const { postDailyDigest } = await import('../slack/digest.js');
      const channel = process.env.DIGEST_SLACK_CHANNEL ?? '';
      if (!channel) {
        log.error('DIGEST_SLACK_CHANNEL is not set');
        process.exit(1);
      }
      const slackApp = createSlackApp(new OxloClient());
      await slackApp.start();
      const issues = getTodaysIssues();
      await postDailyDigest(getSlackClient(slackApp), issues, channel);
      await slackApp.stop();
      log.success(`Posted ${issues.length} issues to Slack`);
      return;
    }

    const digest = getLatestDigest();
    if (!digest) {
      const issues = getTodaysIssues();
      if (issues.length === 0) {
        log.info('No issues processed today.');
        return;
      }
      console.info('');
      for (const issue of issues) {
        console.info(
          `  [${issue.severityScore}/5] ${issue.title}\n  ${issue.sourceUrl}\n`
        );
      }
    } else {
      console.info(`\n${digest.content}\n`);
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// stats
// ─────────────────────────────────────────────────────────────────────────────
program
  .command('stats')
  .description('Print database statistics')
  .action(() => {
    const stats = getDashboardStats();
    console.info('');
    console.info('  IssueRadar Statistics');
    console.info('  ─────────────────────');
    console.info(`  Total processed   ${stats.totalProcessed}`);
    console.info(`  Today             ${stats.processedToday}`);
    console.info(`  This week         ${stats.processedThisWeek}`);
    console.info(`  Bugs found        ${stats.bugsFound}`);
    console.info(`  Duplicates caught ${stats.dupsCaught}`);
    console.info(`  Critical          ${stats.criticalCount}`);
    console.info(`  High              ${stats.highCount}`);
    console.info(`  Medium            ${stats.mediumCount}`);
    console.info('');
  });

program.parse(process.argv);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function fetchGitHubIssue(url: string): Promise<{ text: string; id: string } | null> {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (!match) return null;

  const [, owner, repo, number] = match;
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${number}`;

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'IssueRadar/1.0',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers['Authorization'] = `Bearer ${token}`;

  try {
    const res = await fetch(apiUrl, { headers });
    if (!res.ok) return null;

    const data = (await res.json()) as { title: string; body: string | null };
    const text = `${data.title}\n\n${data.body ?? ''}`.trim();
    return { text, id: `${owner}/${repo}#${number}` };
  } catch {
    return null;
  }
}
