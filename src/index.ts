import 'dotenv/config';
import express from 'express';
import { OxloClient } from './oxlo/client.js';
import { createWebhookHandler } from './github/webhook.js';
import { createSlackApp, getSlackClient } from './slack/listener.js';
import { registerScheduledJobs } from './scheduler.js';
import { getDashboardStats, getTodaysIssues } from './storage/db.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('server');

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const WEBHOOK_PATH = process.env.WEBHOOK_PATH ?? '/webhook';
const DIGEST_CHANNEL = process.env.DIGEST_SLACK_CHANNEL ?? '';

async function main(): Promise<void> {
  // ── Oxlo AI client ────────────────────────────────────────────────────────
  const oxloClient = new OxloClient();
  log.success('OxloClient initialized');

  // ── Express server ────────────────────────────────────────────────────────
  const app = express();

  // Webhook endpoint: raw body for HMAC verification
  app.use(WEBHOOK_PATH, express.text({ type: '*/*', limit: '2mb' }));
  // Everything else: JSON
  app.use(express.json());

  // ── Routes ────────────────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  /** Dashboard stats — consumed by the Next.js web app. */
  app.get('/api/stats', (_req, res) => {
    try {
      res.json(getDashboardStats());
    } catch (err) {
      log.error(`/api/stats: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: 'Failed to fetch stats' });
    }
  });

  /** Today's issues for the digest viewer. */
  app.get('/api/digest/latest', (_req, res) => {
    try {
      res.json({ issues: getTodaysIssues() });
    } catch (err) {
      log.error(`/api/digest/latest: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: 'Failed to fetch digest' });
    }
  });

  /** GitHub webhook. */
  app.post(WEBHOOK_PATH, createWebhookHandler(oxloClient));

  const server = app.listen(PORT, () => {
    log.success(`Webhook server → http://localhost:${PORT}${WEBHOOK_PATH}`);
  });

  // ── Slack app ─────────────────────────────────────────────────────────────
  let scheduler: { stop: () => void } | null = null;
  let slackApp: Awaited<ReturnType<typeof createSlackApp>> | null = null;

  try {
    slackApp = createSlackApp(oxloClient);
    await slackApp.start();
    log.success('Slack Bolt app started (Socket Mode)');

    // Register cron jobs only if Slack is available
    if (DIGEST_CHANNEL) {
      scheduler = registerScheduledJobs({
        slack: getSlackClient(slackApp),
        oxloClient,
        digestChannel: DIGEST_CHANNEL,
      });
    } else {
      log.warn('DIGEST_SLACK_CHANNEL not set — daily digest disabled');
    }
  } catch (err) {
    log.warn(`Slack unavailable — check SLACK_* env vars: ${err instanceof Error ? err.message : String(err)}`);
    log.info('Webhook server is still running. Slack features are disabled.');
  }

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async (): Promise<void> => {
    log.info('Shutting down gracefully...');
    scheduler?.stop();
    if (slackApp) await slackApp.stop();
    server.close(() => {
      log.info('HTTP server closed');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  // ── Startup summary ───────────────────────────────────────────────────────
  const stats = getDashboardStats();
  log.info(
    `Database: ${stats.totalProcessed} issues processed, ${stats.dupsCaught} dupes caught`
  );
}

main().catch((err: unknown) => {
  console.error('[fatal] Startup failed:', err);
  process.exit(1);
});
