import { createHmac, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import type { OxloClient } from '../oxlo/client.js';
import { analyzeIssue } from '../pipeline.js';
import { saveAnalysis, getIssueSummaries } from '../storage/db.js';
import { findSimilarCandidates, buildIndex } from '../storage/embeddings.js';
import {
  normalizeGitHubIssue,
  normalizeGitHubPRComment,
  isAnalyzableIssue,
} from '../normalizer.js';
import { labelIssue, postAnalysisComment } from './issues.js';
import { suggestAssignee } from './blame.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('webhook');

// ─────────────────────────────────────────────────────────────────────────────
// GitHub webhook payload shapes
// ─────────────────────────────────────────────────────────────────────────────

interface GitHubIssuePayload {
  action: string;
  issue: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    labels: Array<{ name: string }>;
  };
  repository: {
    full_name: string;
  };
  installation?: { id: number };
}

interface GitHubCommentPayload {
  action: string;
  comment: {
    id: number;
    body: string;
    html_url: string;
    user: { login: string; type: string };
  };
  issue?: { number: number };
  pull_request?: { number: number };
  repository: {
    full_name: string;
  };
  installation?: { id: number };
}

// ─────────────────────────────────────────────────────────────────────────────
// Signature verification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verifies the GitHub webhook HMAC-SHA256 signature in constant time.
 *
 * @param payload   - Raw request body string
 * @param signature - Value of the x-hub-signature-256 header
 * @param secret    - Webhook secret from the GitHub App settings
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const expected = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Express handler factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates an Express handler for POST /webhook.
 * Verifies GitHub HMAC signature, acknowledges with 200 immediately,
 * then processes the event asynchronously.
 *
 * @param client - Initialized OxloClient
 */
export function createWebhookHandler(client: OxloClient) {
  return async (req: Request, res: Response): Promise<void> => {
    const rawBody = req.body as string;
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    const event = req.headers['x-github-event'] as string | undefined;
    const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET ?? '';

    if (!signature || !verifyWebhookSignature(rawBody, signature, webhookSecret)) {
      res.status(401).json({ error: 'Invalid webhook signature' });
      return;
    }

    // Respond immediately — GitHub expects a fast 2xx
    res.status(200).json({ ok: true });

    void processEvent(client, event, rawBody);
  };
}

async function processEvent(client: OxloClient, event: string | undefined, rawBody: string): Promise<void> {
  try {
    const payload = JSON.parse(rawBody) as unknown;

    if (event === 'issues') {
      await handleIssueEvent(client, payload as GitHubIssuePayload);
    } else if (event === 'issue_comment' || event === 'pull_request_review_comment') {
      await handleCommentEvent(client, payload as GitHubCommentPayload);
    }
  } catch (err) {
    log.error(`Event processing failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Event handlers
// ─────────────────────────────────────────────────────────────────────────────

async function handleIssueEvent(client: OxloClient, payload: GitHubIssuePayload): Promise<void> {
  const { action, issue, repository, installation } = payload;

  if (!['opened', 'edited', 'reopened'].includes(action)) return;

  // Skip already-processed issues
  if (issue.labels.some((l) => l.name === 'issueradar')) return;

  if (!isAnalyzableIssue(issue.title, issue.body)) {
    log.dim(`Skipping issue #${issue.number} — not analyzable`);
    return;
  }

  const [owner, repo] = repository.full_name.split('/') as [string, string];
  const item = normalizeGitHubIssue(
    repository.full_name,
    issue.number,
    issue.title,
    issue.body,
    issue.html_url
  );

  log.info(`Processing issue #${issue.number} in ${repository.full_name}`);

  const summaries = getIssueSummaries(50);
  const candidates = findSimilarCandidates(item.text, buildIndex(summaries));

  const { result } = await analyzeIssue(client, {
    text: item.text,
    source: item.source,
    sourceId: item.sourceId,
    sourceUrl: item.sourceUrl,
    existingIssues: candidates,
  });

  saveAnalysis(item.text, result);

  // Run blame and label+comment concurrently
  const installationId = installation?.id;
  const [suggestedLogin] = await Promise.all([
    suggestAssignee(owner, repo, result.extracted.affectedModule, installationId),
    labelIssue(owner, repo, issue.number, result.severity.label, result.classification.type, installationId),
  ]);

  await postAnalysisComment(owner, repo, issue.number, result, suggestedLogin, installationId);

  log.success(
    `#${issue.number} → ${result.classification.type} severity=${result.severity.score}/5` +
      (result.deduplication.duplicateIds.length > 0 ? ' [duplicate detected]' : '')
  );
}

async function handleCommentEvent(client: OxloClient, payload: GitHubCommentPayload): Promise<void> {
  const { action, comment, repository } = payload;
  if (action !== 'created') return;

  // Skip bot comments to prevent feedback loops
  if (comment.user.type === 'Bot') return;

  // Skip short or irrelevant comments
  if (!isAnalyzableIssue('', comment.body) || comment.body.length < 50) return;

  const BUG_SIGNAL = /\b(bug|broken|crash|error|exception|fail|regression|not working)\b/i;
  if (!BUG_SIGNAL.test(comment.body)) return;

  const item = normalizeGitHubPRComment(
    repository.full_name,
    payload.pull_request?.number ?? payload.issue?.number ?? 0,
    comment.id,
    comment.body,
    comment.html_url
  );

  log.info(`Processing PR comment in ${repository.full_name}`);

  const summaries = getIssueSummaries(50);
  const candidates = findSimilarCandidates(item.text, buildIndex(summaries));

  const { result } = await analyzeIssue(client, {
    text: item.text,
    source: item.source,
    sourceId: item.sourceId,
    sourceUrl: item.sourceUrl,
    existingIssues: candidates,
  });

  if (result.classification.type === 'bug') {
    saveAnalysis(item.text, result);
    log.success(`Bug in PR comment captured — severity ${result.severity.score}/5`);
  }
}
