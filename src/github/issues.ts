import type { AnalysisResult } from '../pipeline.js';
import { getInstallationOctokit } from './app-auth.js';

/** All labels IssueRadar manages. Ensures they exist before applying. */
const MANAGED_LABELS: Record<string, { color: string; description: string }> = {
  'severity/critical': { color: 'B60205', description: 'Critical: data loss, security, full outage' },
  'severity/high':     { color: 'D93F0B', description: 'High: major feature broken, no workaround' },
  'severity/medium':   { color: 'E4E669', description: 'Medium: partial breakage, workaround exists' },
  'severity/low':      { color: '0075CA', description: 'Low: minor issue, easy workaround' },
  'severity/trivial':  { color: 'EDEDED', description: 'Trivial: cosmetic, documentation' },
  'type/bug':          { color: 'EE0701', description: 'Confirmed bug' },
  'type/feature':      { color: '84B6EB', description: 'Feature request' },
  'type/question':     { color: 'CC317C', description: 'Question or support request' },
  'issueradar':        { color: '5319E7', description: 'Processed by IssueRadar AI' },
};

/** Cached set of repos where labels have already been ensured this process lifetime. */
const labelledRepos = new Set<string>();

/**
 * Ensures all IssueRadar labels exist in the repository, creating missing ones.
 * Results are cached per repo to avoid redundant API calls.
 *
 * @param owner          - Repository owner (org or user)
 * @param repo           - Repository name
 * @param installationId - GitHub App installation ID (omit for PAT auth)
 */
export async function ensureLabels(
  owner: string,
  repo: string,
  installationId?: number
): Promise<void> {
  const key = `${owner}/${repo}`;
  if (labelledRepos.has(key)) return;

  const octokit = await getInstallationOctokit(installationId);
  const { data: existing } = await octokit.issues.listLabelsForRepo({ owner, repo, per_page: 100 });
  const existingNames = new Set(existing.map((l) => l.name));

  await Promise.all(
    Object.entries(MANAGED_LABELS)
      .filter(([name]) => !existingNames.has(name))
      .map(([name, { color, description }]) =>
        octokit.issues.createLabel({ owner, repo, name, color, description })
      )
  );

  labelledRepos.add(key);
}

/**
 * Applies severity and type labels to a GitHub issue, then adds the 'issueradar' marker label.
 *
 * @param owner          - Repository owner
 * @param repo           - Repository name
 * @param issueNumber    - GitHub issue number
 * @param severityLabel  - e.g. 'severity/high'
 * @param issueType      - e.g. 'bug'
 * @param installationId - GitHub App installation ID (omit for PAT auth)
 */
export async function labelIssue(
  owner: string,
  repo: string,
  issueNumber: number,
  severityLabel: string,
  issueType: string,
  installationId?: number
): Promise<void> {
  const octokit = await getInstallationOctokit(installationId);
  await ensureLabels(owner, repo, installationId);

  await octokit.issues.addLabels({
    owner,
    repo,
    issue_number: issueNumber,
    labels: [severityLabel, `type/${issueType}`, 'issueradar'],
  });
}

/**
 * Posts an AI analysis comment on a GitHub issue with the full pipeline output.
 *
 * @param owner          - Repository owner
 * @param repo           - Repository name
 * @param issueNumber    - GitHub issue number
 * @param result         - Full analysis result from the pipeline
 * @param suggestedLogin - Suggested assignee GitHub login (or null)
 * @param installationId - GitHub App installation ID (omit for PAT auth)
 */
export async function postAnalysisComment(
  owner: string,
  repo: string,
  issueNumber: number,
  result: AnalysisResult,
  suggestedLogin: string | null,
  installationId?: number
): Promise<void> {
  const octokit = await getInstallationOctokit(installationId);

  const severityEmoji = ['', '⬜', '🔵', '🟡', '🟠', '🔴'][result.severity.score] ?? '❓';

  const dupeSection =
    result.deduplication.duplicateIds.length > 0
      ? `\n\n### ⚠️ Possible Duplicates\nThis may be a duplicate of: ${result.deduplication.duplicateIds.join(', ')}`
      : '';

  const stepsSection =
    result.extracted.stepsToReproduce.length > 0
      ? `\n\n**Steps to Reproduce:**\n${result.extracted.stepsToReproduce.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
      : '';

  const assigneeSection = suggestedLogin
    ? `\n\n**Suggested Assignee:** @${suggestedLogin} _(based on recent commits to \`${result.extracted.affectedModule}\`)_`
    : '';

  const versionLine = result.extracted.affectedVersion
    ? `**Version:** ${result.extracted.affectedVersion}\n`
    : '';

  const body = `### 🤖 IssueRadar Analysis

**Type:** \`${result.classification.type}\` (${Math.round(result.classification.confidence * 100)}% confidence)
**Severity:** ${severityEmoji} ${result.severity.score}/5 — ${result.severity.reason}
**Affected Module:** \`${result.extracted.affectedModule || 'unknown'}\`
${versionLine}
**Summary:** ${result.extracted.description}

**Expected:** ${result.extracted.expectedBehavior || '_not specified_'}
**Actual:** ${result.extracted.actualBehavior || '_not specified_'}
${stepsSection}${assigneeSection}${dupeSection}

---
_Analyzed by [IssueRadar](https://github.com/your-username/issueradar) via Oxlo AI · ${new Date(result.analyzedAt).toUTCString()}_`;

  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });
}

/**
 * Fetches all open issues from a repository, limited to the most recent N.
 * Used for the daily digest and batch scan cron jobs.
 *
 * @param owner          - Repository owner
 * @param repo           - Repository name
 * @param limit          - Maximum issues to return (default 100)
 * @param installationId - GitHub App installation ID (omit for PAT auth)
 */
export async function fetchOpenIssues(
  owner: string,
  repo: string,
  limit = 100,
  installationId?: number
): Promise<Array<{ number: number; title: string; body: string | null; htmlUrl: string }>> {
  const octokit = await getInstallationOctokit(installationId);

  const { data } = await octokit.issues.listForRepo({
    owner,
    repo,
    state: 'open',
    per_page: Math.min(limit, 100),
    sort: 'created',
    direction: 'desc',
  });

  return data
    .filter((issue) => !('pull_request' in issue))
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body ?? null,
      htmlUrl: issue.html_url,
    }));
}
