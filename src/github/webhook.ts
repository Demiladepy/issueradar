import { createHmac, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import type { OxloClient } from '../oxlo/client.js';
import { analyzeIssue } from '../pipeline.js';
import { saveAnalysis, getIssueSummaries } from '../storage/db.js';
import { findSimilarCandidates, buildIndex } from '../storage/embeddings.js';
import { labelIssue, postAnalysisComment } from './issues.js';
import { suggestAssignee } from './blame.js';

/** GitHub webhook event types we handle. */
type GitHubIssueAction = 'opened' | 'edited' | 'reopened';
type GitHubPRCommentAction = 'created';

interface GitHubIssuePayload {
  action: GitHubIssueAction;
  issue: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    labels: Array<{ name: string }>;
  };
  repository: {
    full_name: string;
    default_branch: string;
  };
  installation?: {
    id: number;
  };
}

interface GitHubPRCommentPayload {
  action: GitHubPRCommentAction;
  comment: {
    id: number;
    body: string;
    html_url: string;
    user: { login: string };
  };
  pull_request: {
    number: number;
    html_url: string;
  };
  repository: {
    full_name: string;
    default_branch: string;
  };
  installation?: {
    id: number;
  };
}

/**
 * Verifies the GitHub webhook HMAC-SHA256 signature.
 *
 * @param payload   - Raw request body as string
 * @param signature - Value of the x-hub-signature-256 header
 * @param secret    - Webhook secret configured in GitHub App settings
 * @returns true if signature is valid
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

/**
 * Express handler for POST /webhook.
 * Verifies GitHub signature, dispatches to the correct handler by event type,
 * and returns 200 immediately — analysis happens asynchronously.
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

    // Acknowledge immediately — GitHub expects a fast 2xx
    res.status(200).json({ ok: true });

    // Process asynchronously
    try {
      const payload = JSON.parse(rawBody) as unknown;

      if (event === 'issues') {
        await handleIssueEvent(client, payload as GitHubIssuePayload);
      } else if (event === 'pull_request_review_comment' || event === 'issue_comment') {
        await handlePRCommentEvent(client, payload as GitHubPRCommentPayload);
      }
      // Other event types are silently ignored
    } catch (err) {
      console.error('[webhook] Processing error:', err);
    }
  };
}

async function handleIssueEvent(
  client: OxloClient,
  payload: GitHubIssuePayload
): Promise<void> {
  const { action, issue, repository } = payload;

  if (!(['opened', 'edited', 'reopened'] as GitHubIssueAction[]).includes(action)) return;

  // Skip if already labeled by IssueRadar
  if (issue.labels.some((l) => l.name.startsWith('severity/'))) return;

  const text = `${issue.title}\n\n${issue.body ?? ''}`.trim();
  if (!text) return;

  console.info(`[webhook] Analyzing issue #${issue.number} in ${repository.full_name}`);

  const summaries = getIssueSummaries(50);
  const candidates = findSimilarCandidates(text, buildIndex(summaries));

  const { result } = await analyzeIssue(client, {
    text,
    source: 'github_issue',
    sourceId: `${repository.full_name}#${issue.number}`,
    sourceUrl: issue.html_url,
    existingIssues: candidates,
  });

  saveAnalysis(text, result);

  const [repoOwner, repoName] = repository.full_name.split('/');

  await Promise.all([
    labelIssue(repoOwner, repoName, issue.number, result.severity.label, result.classification.type),
    postAnalysisComment(repoOwner, repoName, issue.number, result, await suggestAssignee(repoOwner, repoName, result.extracted.affectedModule)),
  ]);
}

async function handlePRCommentEvent(
  client: OxloClient,
  payload: GitHubPRCommentPayload
): Promise<void> {
  const { action, comment, repository } = payload;
  if (action !== 'created') return;

  // Only analyze comments that look like bug reports (keyword filter to reduce noise)
  const bugKeywords = /\b(bug|broken|crash|error|exception|fail|issue|problem|regression)\b/i;
  if (!bugKeywords.test(comment.body)) return;

  console.info(`[webhook] Analyzing PR comment in ${repository.full_name}`);

  const text = comment.body;
  const summaries = getIssueSummaries(50);
  const candidates = findSimilarCandidates(text, buildIndex(summaries));

  const { result } = await analyzeIssue(client, {
    text,
    source: 'github_pr_comment',
    sourceId: `${repository.full_name}#comment-${comment.id}`,
    sourceUrl: comment.html_url,
    existingIssues: candidates,
  });

  // Only save bugs from PR comments — noise/questions are expected in PRs
  if (result.classification.type === 'bug') {
    saveAnalysis(text, result);
    console.info(`[webhook] Bug detected in PR comment, severity ${result.severity.score}/5`);
  }
}
