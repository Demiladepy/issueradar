import { Octokit } from '@octokit/rest';

let _octokit: Octokit | null = null;

function getOctokit(): Octokit {
  if (!_octokit) {
    _octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  }
  return _octokit;
}

interface CommitAuthor {
  login: string;
  commitCount: number;
}

/**
 * Suggests an assignee for an issue based on recent Git commit activity
 * in the affected module path.
 *
 * Strategy: fetches the last 30 commits touching files that match the
 * affected module name, then returns the most frequent author.
 *
 * @param owner          - Repository owner
 * @param repo           - Repository name
 * @param affectedModule - Module/component/file name from the extractor
 * @returns GitHub login of the suggested assignee, or null if no match
 */
export async function suggestAssignee(
  owner: string,
  repo: string,
  affectedModule: string
): Promise<string | null> {
  if (!affectedModule || affectedModule === 'unknown') return null;

  const octokit = getOctokit();

  try {
    const { data: commits } = await octokit.repos.listCommits({
      owner,
      repo,
      per_page: 30,
    });

    const authorFrequency = new Map<string, number>();

    for (const commit of commits) {
      const login = commit.author?.login;
      if (!login) continue;

      // Check if the commit message or files reference the affected module
      const messageMentionsModule = commit.commit.message
        .toLowerCase()
        .includes(affectedModule.toLowerCase());

      if (messageMentionsModule) {
        authorFrequency.set(login, (authorFrequency.get(login) ?? 0) + 2);
      } else {
        // Still count general commits but with lower weight
        authorFrequency.set(login, (authorFrequency.get(login) ?? 0) + 1);
      }
    }

    if (authorFrequency.size === 0) return null;

    const sorted: CommitAuthor[] = Array.from(authorFrequency.entries())
      .map(([login, commitCount]) => ({ login, commitCount }))
      .sort((a, b) => b.commitCount - a.commitCount);

    return sorted[0]?.login ?? null;
  } catch {
    // Don't fail the pipeline if blame lookup fails
    return null;
  }
}

/**
 * Looks up files changed in the last N commits that match a module name pattern.
 * Returns the set of matching file paths — used to narrow down the blame search.
 *
 * @param owner          - Repository owner
 * @param repo           - Repository name
 * @param affectedModule - Module/component/file name to search for
 * @param commitCount    - Number of recent commits to scan (default 20)
 */
export async function findAffectedFiles(
  owner: string,
  repo: string,
  affectedModule: string,
  commitCount = 20
): Promise<string[]> {
  const octokit = getOctokit();

  try {
    const { data: commits } = await octokit.repos.listCommits({
      owner,
      repo,
      per_page: commitCount,
    });

    const matchedFiles = new Set<string>();

    await Promise.all(
      commits.slice(0, 10).map(async (commit) => {
        try {
          const { data } = await octokit.repos.getCommit({
            owner,
            repo,
            ref: commit.sha,
          });

          for (const file of data.files ?? []) {
            if (file.filename.toLowerCase().includes(affectedModule.toLowerCase())) {
              matchedFiles.add(file.filename);
            }
          }
        } catch {
          // Skip individual commit fetch errors
        }
      })
    );

    return Array.from(matchedFiles);
  } catch {
    return [];
  }
}
