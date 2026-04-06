/**
 * Scheduled job manager for IssueRadar.
 *
 * Registers two cron jobs:
 *   1. Daily digest — posts a severity-grouped issue summary to Slack at 9am UTC
 *   2. Weekly dedup pass — re-runs deduplication across all open issues each Sunday
 *
 * Both jobs are registered here and started by src/index.ts.
 */

import cron from 'node-cron';
import type { WebClient } from '@slack/web-api';
import type { OxloClient } from './oxlo/client.js';
import { getTodaysIssues, getIssueSummaries, getWeeklyTrend } from './storage/db.js';
import { postDailyDigest } from './slack/digest.js';
import { analyzeIssue } from './pipeline.js';
import { saveAnalysis } from './storage/db.js';
import { findSimilarCandidates, buildIndex } from './storage/embeddings.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('scheduler');

/** Options for registering scheduled jobs. */
export interface SchedulerOptions {
  slack: WebClient;
  oxloClient: OxloClient;
  /** Slack channel ID for the daily digest */
  digestChannel: string;
  /** Cron expression for the daily digest (default: 9am UTC) */
  digestCron?: string;
  /** Repos to dedup weekly, in "owner/repo" format */
  watchedRepos?: string[];
}

/**
 * Registers all IssueRadar cron jobs.
 * Call this once during server startup.
 *
 * @param options - Scheduler configuration
 * @returns An object with a stop() function to cancel all jobs
 */
export function registerScheduledJobs(options: SchedulerOptions): { stop: () => void } {
  const {
    slack,
    oxloClient,
    digestChannel,
    digestCron = process.env.DIGEST_CRON ?? '0 9 * * *',
  } = options;

  const jobs: cron.ScheduledTask[] = [];

  // ── Daily digest ──────────────────────────────────────────────────────────
  const digestJob = cron.schedule(digestCron, async () => {
    log.info('Running daily digest...');
    try {
      const issues = getTodaysIssues();
      const trend = getWeeklyTrend();
      await postDailyDigest(slack, issues, digestChannel, trend);
      log.success(`Daily digest posted: ${issues.length} issue(s) to #${digestChannel}`);
    } catch (err) {
      log.error(`Daily digest failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  jobs.push(digestJob);

  log.info(`Daily digest scheduled: ${digestCron} → channel ${digestChannel}`);

  // ── Weekly cross-repo dedup pass (Sundays at 8am UTC) ────────────────────
  const dedupJob = cron.schedule('0 8 * * 0', async () => {
    log.info('Running weekly cross-repo dedup pass...');
    try {
      await runDedupPass(oxloClient);
    } catch (err) {
      log.error(`Dedup pass failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  jobs.push(dedupJob);

  log.info('Weekly dedup pass scheduled: Sundays at 08:00 UTC');

  return {
    stop: () => {
      for (const job of jobs) job.stop();
      log.info('All scheduled jobs stopped');
    },
  };
}

/**
 * Runs a deduplication pass over all recently stored issue summaries.
 * Re-analyzes issues that haven't been checked for duplicates recently.
 * This catches duplicates that were filed AFTER the original issue was processed.
 *
 * @param oxloClient - Initialized OxloClient
 */
async function runDedupPass(oxloClient: OxloClient): Promise<void> {
  const summaries = getIssueSummaries(100);
  if (summaries.length < 2) {
    log.info('Not enough issues for dedup pass (need at least 2)');
    return;
  }

  const index = buildIndex(summaries);
  let newDupesFound = 0;

  // Re-check each issue against the full index (excluding itself)
  for (const summary of summaries.slice(0, 50)) {
    const text = `${summary.title}\n${summary.description}\nModule: ${summary.affectedModule}`;
    const otherSummaries = summaries.filter((s) => s.id !== summary.id);
    const candidates = findSimilarCandidates(text, index.filter((i) => i.id !== summary.id), 10, 0.15);

    if (candidates.length === 0) continue;

    try {
      const { result } = await analyzeIssue(oxloClient, {
        text,
        source: 'github_issue',
        sourceId: summary.id,
        sourceUrl: '',
        existingIssues: otherSummaries.slice(0, 20),
      });

      if (result.deduplication.duplicateIds.length > 0) {
        saveAnalysis(text, result);
        newDupesFound++;
        log.info(`New duplicate detected: ${summary.id} → ${result.deduplication.duplicateIds.join(', ')}`);
      }
    } catch {
      // Continue dedup pass even if one issue fails
    }

    // Courtesy delay between Oxlo calls
    await new Promise((r) => setTimeout(r, 300));
  }

  log.success(`Dedup pass complete — ${newDupesFound} new duplicate(s) found`);
}
