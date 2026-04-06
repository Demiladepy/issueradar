/**
 * Local webhook testing utility.
 *
 * Sends a synthetic GitHub issues.opened payload to the local webhook server.
 * Use this to test the full pipeline without needing ngrok or a live GitHub App.
 *
 * Usage:
 *   npm run cli test-webhook -- --issue "Button crash on mobile" --body "Clicking submit throws TypeError"
 *   npm run cli test-webhook -- --url https://github.com/vercel/next.js/issues/12345
 */

import 'dotenv/config';
import { createHmac } from 'crypto';

interface TestWebhookOptions {
  title: string;
  body: string;
  repo?: string;
  issueNumber?: number;
  serverUrl?: string;
}

/**
 * Sends a signed GitHub `issues.opened` webhook payload to a local server.
 *
 * @param opts - Issue content and server options
 */
export async function sendTestWebhook(opts: TestWebhookOptions): Promise<void> {
  const {
    title,
    body,
    repo = 'test-owner/test-repo',
    issueNumber = Math.floor(Math.random() * 9000) + 1000,
    serverUrl = `http://localhost:${process.env.PORT ?? 3000}`,
  } = opts;

  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET ?? 'test-secret';

  const payload = JSON.stringify({
    action: 'opened',
    issue: {
      number: issueNumber,
      title,
      body,
      html_url: `https://github.com/${repo}/issues/${issueNumber}`,
      labels: [],
    },
    repository: {
      full_name: repo,
      default_branch: 'main',
    },
    installation: null,
  });

  const signature = `sha256=${createHmac('sha256', webhookSecret).update(payload).digest('hex')}`;
  const webhookPath = process.env.WEBHOOK_PATH ?? '/webhook';

  console.info(`\nSending test webhook to ${serverUrl}${webhookPath}`);
  console.info(`  Issue:  #${issueNumber} — "${title}"`);
  console.info(`  Repo:   ${repo}`);
  console.info(`  Size:   ${payload.length} bytes\n`);

  try {
    const res = await fetch(`${serverUrl}${webhookPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-github-event': 'issues',
        'x-hub-signature-256': signature,
        'x-github-delivery': crypto.randomUUID(),
      },
      body: payload,
    });

    if (res.ok) {
      console.info(`  ✔ Webhook accepted (${res.status})`);
      console.info('  Pipeline is running asynchronously — check server logs for output.\n');
    } else {
      const text = await res.text();
      console.error(`  ✖ Webhook rejected (${res.status}): ${text}\n`);
    }
  } catch (err) {
    console.error(
      `  ✖ Could not reach server at ${serverUrl}.\n` +
        `  Make sure the server is running with: npm run dev\n\n` +
        `  Error: ${err instanceof Error ? err.message : String(err)}\n`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI entry (invoked via: npm run cli test-webhook ...)
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
};

const title = getArg('--issue') ?? 'Test: clicking the submit button crashes on iOS 17';
const body =
  getArg('--body') ??
  `## Steps to reproduce
1. Open the app on iPhone (iOS 17)
2. Fill out the form
3. Tap Submit

## Expected
Form submits and shows success message.

## Actual
TypeError: Cannot read property 'value' of null at FormHandler.submit

## Environment
- iOS 17.2, Safari 17
- App version: 2.4.1`;

const repo = getArg('--repo');

await sendTestWebhook({
  title,
  body,
  repo: repo ?? undefined,
  serverUrl: getArg('--server'),
});
