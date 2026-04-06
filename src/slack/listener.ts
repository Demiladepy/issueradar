import { App as SlackApp, type GenericMessageEvent } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { OxloClient } from '../oxlo/client.js';
import { analyzeIssue } from '../pipeline.js';
import { saveAnalysis, getIssueSummaries } from '../storage/db.js';
import { findSimilarCandidates, buildIndex } from '../storage/embeddings.js';
import { normalizeSlackMessage, looksLikeBugReport } from '../normalizer.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('slack');

const WORKSPACE_DOMAIN = process.env.SLACK_WORKSPACE_DOMAIN ?? 'your-workspace';

/**
 * Creates and configures the Slack Bolt app.
 * Listens to messages in configured channels and runs the 4-call Oxlo pipeline
 * on any message that looks like a bug report.
 *
 * Required env vars:
 *   SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET, SLACK_CHANNEL_IDS
 *
 * @param oxloClient - Initialized OxloClient
 * @returns Configured Slack app (not yet started — call app.start() separately)
 */
export function createSlackApp(oxloClient: OxloClient): SlackApp {
  const app = new SlackApp({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: !!process.env.SLACK_APP_TOKEN,
  });

  const watchedChannels = new Set(
    (process.env.SLACK_CHANNEL_IDS ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean)
  );

  app.message(async ({ message }) => {
    const msg = message as GenericMessageEvent;

    if (!watchedChannels.has(msg.channel)) return;
    if (msg.subtype === 'bot_message') return;

    const text = msg.text ?? '';
    if (!looksLikeBugReport(text)) return;

    log.info(`Bug signal in channel ${msg.channel} — analyzing`);

    try {
      const item = normalizeSlackMessage(msg.channel, msg.ts, text, WORKSPACE_DOMAIN);

      const summaries = getIssueSummaries(50);
      const candidates = findSimilarCandidates(item.text, buildIndex(summaries));

      const { result } = await analyzeIssue(oxloClient, {
        text: item.text,
        source: item.source,
        sourceId: item.sourceId,
        sourceUrl: item.sourceUrl,
        existingIssues: candidates,
      });

      // Only persist bugs — questions and noise are expected in Slack
      if (result.classification.type !== 'bug') {
        log.dim(`Skipping non-bug message (type=${result.classification.type})`);
        return;
      }

      saveAnalysis(item.text, result);

      log.success(
        `Bug captured: "${result.extracted.title}" ` +
          `severity=${result.severity.score}/5` +
          (result.deduplication.duplicateIds.length > 0 ? ' [possible duplicate]' : '')
      );
    } catch (err) {
      log.error(`Failed to analyze message: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  return app;
}

/**
 * Returns the Slack WebClient from a running app instance.
 * Used by the scheduler to post digest messages without importing the full app.
 *
 * @param app - Running SlackApp instance
 */
export function getSlackClient(app: SlackApp): WebClient {
  return app.client;
}
