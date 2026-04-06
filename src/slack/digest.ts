import type { WebClient } from '@slack/web-api';
import type { StoredIssue } from '../storage/db.js';
import { saveDigest } from '../storage/db.js';

/** Groups issues by severity score for digest formatting. */
interface DigestGroups {
  critical: StoredIssue[];
  high: StoredIssue[];
  medium: StoredIssue[];
  low: StoredIssue[];
  features: StoredIssue[];
  duplicates: StoredIssue[];
}

/**
 * Groups today's issues by severity and type for the digest.
 *
 * @param issues - All issues processed today
 * @returns Grouped issues for rendering
 */
export function groupIssuesForDigest(issues: StoredIssue[]): DigestGroups {
  return {
    critical: issues.filter((i) => i.type === 'bug' && i.severityScore === 5),
    high: issues.filter((i) => i.type === 'bug' && i.severityScore === 4),
    medium: issues.filter((i) => i.type === 'bug' && i.severityScore === 3),
    low: issues.filter((i) => i.type === 'bug' && i.severityScore <= 2),
    features: issues.filter((i) => i.type === 'feature'),
    duplicates: issues.filter((i) => i.duplicateIds.length > 0),
  };
}

/**
 * Renders a daily digest as a Slack Block Kit message.
 *
 * @param groups - Issues grouped by severity
 * @param date   - The date string for the digest header (e.g. "2026-04-06")
 * @returns Slack Block Kit blocks array
 */
export function renderDigestBlocks(
  groups: DigestGroups,
  date: string
): Array<Record<string, unknown>> {
  const totalBugs = groups.critical.length + groups.high.length + groups.medium.length + groups.low.length;
  const blocks: Array<Record<string, unknown>> = [];

  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: `📡 IssueRadar Daily Digest — ${date}`, emoji: true },
  });

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*${totalBugs} bugs* · *${groups.features.length} features* · *${groups.duplicates.length} duplicates caught*`,
    },
  });

  blocks.push({ type: 'divider' });

  if (groups.critical.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `🔴 *Critical (${groups.critical.length})*` },
    });
    for (const issue of groups.critical) {
      blocks.push(renderIssueBlock(issue, '🔴'));
    }
  }

  if (groups.high.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `🟠 *High (${groups.high.length})*` },
    });
    for (const issue of groups.high) {
      blocks.push(renderIssueBlock(issue, '🟠'));
    }
  }

  if (groups.medium.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `🟡 *Medium (${groups.medium.length})*` },
    });
    for (const issue of groups.medium) {
      blocks.push(renderIssueBlock(issue, '🟡'));
    }
  }

  if (groups.low.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `🔵 *Low / Trivial (${groups.low.length})*` },
    });
    for (const issue of groups.low.slice(0, 5)) {
      blocks.push(renderIssueBlock(issue, '🔵'));
    }
    if (groups.low.length > 5) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `_…and ${groups.low.length - 5} more low-severity issues_` },
      });
    }
  }

  if (groups.features.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `✨ *Feature Requests (${groups.features.length})*` },
    });
    for (const issue of groups.features.slice(0, 3)) {
      blocks.push(renderIssueBlock(issue, '✨'));
    }
  }

  if (groups.duplicates.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `♻️ *Duplicates Caught (${groups.duplicates.length})* — these may already be tracked`,
      },
    });
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Powered by <https://github.com/your-username/issueradar|IssueRadar> via Oxlo AI`,
      },
    ],
  });

  return blocks;
}

function renderIssueBlock(
  issue: StoredIssue,
  emoji: string
): Record<string, unknown> {
  const moduleTag = issue.affectedModule ? ` \`${issue.affectedModule}\`` : '';
  const dupeTag =
    issue.duplicateIds.length > 0 ? ` _(possible duplicate)_` : '';

  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `${emoji} *<${issue.sourceUrl}|${issue.title}>*${moduleTag}\n${issue.severityReason}${dupeTag}`,
    },
  };
}

/**
 * Formats and posts the daily digest to Slack, then saves it to the database.
 *
 * @param slack   - Slack WebClient instance
 * @param issues  - All issues processed today
 * @param channel - Slack channel ID to post to
 */
export async function postDailyDigest(
  slack: WebClient,
  issues: StoredIssue[],
  channel: string
): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);

  if (issues.length === 0) {
    await slack.chat.postMessage({
      channel,
      text: `📡 IssueRadar Daily Digest — ${date}\n\nNo new issues processed today. 🎉`,
    });
    saveDigest(date, `No issues processed on ${date}.`);
    return;
  }

  const groups = groupIssuesForDigest(issues);
  const blocks = renderDigestBlocks(groups, date);

  await slack.chat.postMessage({
    channel,
    text: `IssueRadar Daily Digest — ${date}`,
    blocks,
  });

  // Save a plain-text version for the web dashboard
  const plainText = buildPlainTextDigest(groups, date);
  saveDigest(date, plainText);
}

function buildPlainTextDigest(groups: DigestGroups, date: string): string {
  const lines: string[] = [`IssueRadar Daily Digest — ${date}`, ''];

  const sections: Array<[string, StoredIssue[]]> = [
    ['🔴 Critical', groups.critical],
    ['🟠 High', groups.high],
    ['🟡 Medium', groups.medium],
    ['🔵 Low/Trivial', groups.low],
    ['✨ Features', groups.features],
  ];

  for (const [label, items] of sections) {
    if (items.length === 0) continue;
    lines.push(`${label} (${items.length})`);
    for (const issue of items) {
      lines.push(`  • ${issue.title} — ${issue.sourceUrl}`);
    }
    lines.push('');
  }

  if (groups.duplicates.length > 0) {
    lines.push(`♻️ Duplicates Caught: ${groups.duplicates.length}`);
  }

  return lines.join('\n');
}
