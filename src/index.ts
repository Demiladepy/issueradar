import 'dotenv/config';
import express from 'express';
import cron from 'node-cron';
import { OxloClient } from './oxlo/client.js';
import { createWebhookHandler } from './github/webhook.js';
import { createSlackApp, getSlackClient } from './slack/listener.js';
import { postDailyDigest } from './slack/digest.js';
import { getTodaysIssues, getDashboardStats } from './storage/db.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const WEBHOOK_PATH = process.env.WEBHOOK_PATH ?? '/webhook';
const DIGEST_CHANNEL = process.env.DIGEST_SLACK_CHANNEL ?? '';
const DIGEST_CRON = process.env.DIGEST_CRON ?? '0 9 * * *';

async function main(): Promise<void> {
  // ── Initialize Oxlo AI client ─────────────────────────────────────────────
  const oxloClient = new OxloClient();
  console.info('[init] OxloClient initialized');

  // ── Express webhook server ────────────────────────────────────────────────
  const app = express();

  // Parse raw body for webhook signature verification, JSON for all other routes
  app.use(WEBHOOK_PATH, express.text({ type: '*/*', limit: '1mb' }));
  app.use(express.json());

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Stats API — consumed by the Next.js dashboard
  app.get('/api/stats', (_req, res) => {
    try {
      const stats = getDashboardStats();
      res.json(stats);
    } catch (err) {
      console.error('/api/stats error:', err);
      res.status(500).json({ error: 'Failed to fetch stats' });
    }
  });

  // Digest API — consumed by the Next.js dashboard
  app.get('/api/digest/latest', (_req, res) => {
    try {
      const issues = getTodaysIssues();
      res.json({ issues });
    } catch (err) {
      console.error('/api/digest/latest error:', err);
      res.status(500).json({ error: 'Failed to fetch digest' });
    }
  });

  // GitHub webhook
  app.post(WEBHOOK_PATH, createWebhookHandler(oxloClient));

  app.listen(PORT, () => {
    console.info(`[server] Webhook server listening on http://localhost:${PORT}${WEBHOOK_PATH}`);
  });

  // ── Slack app ─────────────────────────────────────────────────────────────
  let slackApp;
  try {
    slackApp = createSlackApp(oxloClient);
    await slackApp.start();
    console.info('[slack] Slack Bolt app started');
  } catch (err) {
    console.warn('[slack] Failed to start Slack app (check SLACK_* env vars):', err);
  }

  // ── Daily digest cron ─────────────────────────────────────────────────────
  if (DIGEST_CHANNEL && slackApp) {
    const slackClient = getSlackClient(slackApp);

    cron.schedule(DIGEST_CRON, async () => {
      console.info('[digest] Running daily digest...');
      try {
        const issues = getTodaysIssues();
        await postDailyDigest(slackClient, issues, DIGEST_CHANNEL);
        console.info(`[digest] Posted ${issues.length} issues to ${DIGEST_CHANNEL}`);
      } catch (err) {
        console.error('[digest] Failed to post daily digest:', err);
      }
    });

    console.info(`[digest] Daily digest scheduled: ${DIGEST_CRON} → #${DIGEST_CHANNEL}`);
  } else {
    console.warn('[digest] Daily digest not configured (missing DIGEST_SLACK_CHANNEL)');
  }

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async (): Promise<void> => {
    console.info('[shutdown] Shutting down gracefully...');
    if (slackApp) await slackApp.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err) => {
  console.error('[fatal] Startup failed:', err);
  process.exit(1);
});
