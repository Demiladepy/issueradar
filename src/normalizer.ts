/**
 * Normalizes raw inputs from different source systems into a common RawItem format
 * before feeding them into the Oxlo analysis pipeline.
 *
 * All pipeline inputs go through a normalizer — nothing calls analyzeIssue() directly
 * with ad-hoc strings. This ensures consistent text truncation, metadata, and source tagging.
 */

import type { IssueSource } from './pipeline.js';

/** Source-system-specific metadata attached to every normalized item. */
export interface SourceMetadata {
  /** GitHub issue number (GitHub sources only) */
  githubIssueNumber?: number;
  /** "owner/repo" string (GitHub sources only) */
  githubRepo?: string;
  /** GitHub PR number (PR comment sources only) */
  prNumber?: number;
  /** Slack channel ID (Slack source only) */
  slackChannel?: string;
  /** Slack message timestamp (Slack source only) */
  slackTs?: string;
}

/** A normalized item ready for the analysis pipeline. */
export interface RawItem {
  /** Combined, cleaned text fed to the Oxlo pipeline */
  text: string;
  source: IssueSource;
  /** Stable identifier in the source system, e.g. "vercel/next.js#1234" */
  sourceId: string;
  /** Deep link to the original item */
  sourceUrl: string;
  /** Source-specific metadata for downstream use (labeling, assigning, etc.) */
  metadata: SourceMetadata;
}

/** Maximum text length sent to Oxlo. Avoids runaway token costs. */
const MAX_TEXT_LENGTH = 4_000;

/**
 * Normalizes a GitHub issue into a RawItem.
 *
 * @param repo        - "owner/repo" string
 * @param issueNumber - GitHub issue number
 * @param title       - Issue title
 * @param body        - Issue body (may be null)
 * @param htmlUrl     - Link to the issue
 */
export function normalizeGitHubIssue(
  repo: string,
  issueNumber: number,
  title: string,
  body: string | null,
  htmlUrl: string
): RawItem {
  const text = truncate(`${title}\n\n${body ?? ''}`.trim(), MAX_TEXT_LENGTH);

  return {
    text,
    source: 'github_issue',
    sourceId: `${repo}#${issueNumber}`,
    sourceUrl: htmlUrl,
    metadata: {
      githubIssueNumber: issueNumber,
      githubRepo: repo,
    },
  };
}

/**
 * Normalizes a GitHub PR review comment into a RawItem.
 *
 * @param repo      - "owner/repo" string
 * @param prNumber  - Pull request number
 * @param commentId - Comment ID
 * @param body      - Comment body text
 * @param htmlUrl   - Link to the comment
 */
export function normalizeGitHubPRComment(
  repo: string,
  prNumber: number,
  commentId: number,
  body: string,
  htmlUrl: string
): RawItem {
  const text = truncate(body.trim(), MAX_TEXT_LENGTH);

  return {
    text,
    source: 'github_pr_comment',
    sourceId: `${repo}#pr${prNumber}-comment${commentId}`,
    sourceUrl: htmlUrl,
    metadata: {
      githubRepo: repo,
      prNumber,
    },
  };
}

/**
 * Normalizes a Slack message into a RawItem.
 *
 * @param channel   - Slack channel ID
 * @param ts        - Slack message timestamp (used as unique ID)
 * @param text      - Message text
 * @param workspaceDomain - Slack workspace domain for building the URL
 */
export function normalizeSlackMessage(
  channel: string,
  ts: string,
  text: string,
  workspaceDomain: string
): RawItem {
  const normalized = truncate(text.trim(), MAX_TEXT_LENGTH);
  const tsForUrl = ts.replace('.', '');
  const sourceUrl = `https://${workspaceDomain}.slack.com/archives/${channel}/p${tsForUrl}`;

  return {
    text: normalized,
    source: 'slack',
    sourceId: `${channel}-${ts}`,
    sourceUrl,
    metadata: {
      slackChannel: channel,
      slackTs: ts,
    },
  };
}

/**
 * Returns true if a Slack message text looks like a bug report worth analyzing.
 * Used to pre-filter before running any Oxlo calls.
 *
 * @param text   - Raw message text
 * @param minLen - Minimum length to consider (default 30 chars)
 */
export function looksLikeBugReport(text: string, minLen = 30): boolean {
  if (text.length < minLen) return false;

  const BUG_PATTERN =
    /\b(bug|broken|crash(?:ing|ed)?|error|exception|fail(?:ing|ed|ure)?|issue|problem|regression|not working|doesn['']t work|can['']t|cannot|blocked|breaks?)\b/i;

  return BUG_PATTERN.test(text);
}

/**
 * Returns true if a GitHub issue body has enough signal to be worth analyzing.
 * Empty issues, "test" issues, and bots are filtered here.
 *
 * @param title - Issue title
 * @param body  - Issue body
 */
export function isAnalyzableIssue(title: string, body: string | null): boolean {
  const combined = `${title} ${body ?? ''}`.trim();
  if (combined.length < 20) return false;

  const BOT_PATTERNS = /^\[bot\]|dependabot|renovate|snyk-bot/i;
  if (BOT_PATTERNS.test(title)) return false;

  return true;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}\n\n[truncated — ${text.length - maxLen} chars omitted]`;
}
