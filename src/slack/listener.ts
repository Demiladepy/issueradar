import { App as SlackApp, type GenericMessageEvent } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { OxloClient } from '../oxlo/client.js';
import { analyzeIssue } from '../pipeline.js';
import { saveAnalysis, getIssueSummaries } from '../storage/db.js';
import { findSimilarCandidates, buildIndex } from '../storage/embeddings.js';

/** Keyword pattern that flags a Slack message as a potential bug report. */
const BUG_PATTERN =
  /\b(bug|broken|crash(?:ing|ed)?|error|exception|fail(?:ing|ed|ure)?|issue|problem|regression|not working|doesn['']t work|can['']t|cannot)\b/i;

/** Minimum message length to analyze (avoids single-word false positives). */
const MIN_MESSAGE_LENGTH = 30;

/**
 * Creates and configures the Slack Bolt app.
 * Listens to all messages in configured channels and runs the pipeline
 * on messages that look like bug reports.
 *
 * @param oxloClient - Initialized OxloClient for the pipeline
 * @returns Configured SlackApp instance (not yet started)
 */
export function createSlackApp(oxloClient: OxloClient): SlackApp {
  const app = new SlackApp({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: !!process.env.SLACK_APP_TOKEN,
  });

  const watchedChannels = new Set(
    (process.env.SLACK_CHANNEL_IDS ?? '').split(',').map((c) => c.trim()).filter(Boolean)
  );

  // Listen to all messages (will filter by channel below)
  app.message(async ({ message, client }) => {
    const msg = message as GenericMessageEvent;

    // Only process messages from configured channels
    if (!watchedChannels.has(msg.channel)) return;

    // Skip bot messages to avoid feedback loops
    if (msg.subtype === 'bot_message') return;

    const text = msg.text ?? '';
    if (text.length < MIN_MESSAGE_LENGTH) return;
    if (!BUG_PATTERN.test(text)) return;

    console.info(`[slack] Analyzing message in channel ${msg.channel}`);

    try {
      await processSlackMessage(oxloClient, client, msg, text);
    } catch (err) {
      console.error('[slack] Failed to analyze message:', err);
    }
  });

  return app;
}

async function processSlackMessage(
  oxloClient: OxloClient,
  _slackClient: WebClient,
  msg: GenericMessageEvent,
  text: string
): Promise<void> {
  const summaries = getIssueSummaries(50);
  const candidates = findSimilarCandidates(text, buildIndex(summaries));

  const messageUrl = buildSlackMessageUrl(msg.channel, msg.ts);

  const { result } = await analyzeIssue(oxloClient, {
    text,
    source: 'slack',
    sourceId: `${msg.channel}-${msg.ts}`,
    sourceUrl: messageUrl,
    existingIssues: candidates,
  });

  // Only persist bugs from Slack — questions and noise are expected
  if (result.classification.type !== 'bug') return;

  saveAnalysis(text, result);

  console.info(
    `[slack] Bug captured from Slack: "${result.extracted.title}" severity ${result.severity.score}/5`
  );
}

function buildSlackMessageUrl(channel: string, ts: string): string {
  const workspaceDomain = process.env.SLACK_WORKSPACE_DOMAIN ?? 'your-workspace';
  const tsForUrl = ts.replace('.', '');
  return `https://${workspaceDomain}.slack.com/archives/${channel}/p${tsForUrl}`;
}

/**
 * Returns the WebClient from an initialized Slack app.
 * Used by the digest scheduler to post messages without importing the app instance.
 *
 * @param app - Running SlackApp instance
 * @returns The underlying WebClient
 */
export function getSlackClient(app: SlackApp): WebClient {
  return app.client;
}
