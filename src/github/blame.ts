import { getInstallationOctokit } from './app-auth.js';

/**
 * Suggests an assignee for an issue based on recent Git commit activity
 * in the affected module path.
 *
 * Strategy: fetches the last 30 commits, boosts authors whose commit messages
 * mention the affected module name, returns the most frequent contributor.
 *
 * @param owner          - Repository owner
 * @param repo           - Repository name
 * @param affectedModule - Module/component/file name from the extractor
 * @param installationId - GitHub App installation ID (omit for PAT auth)
 * @returns GitHub login of the suggested assignee, or null if no match
 */
export async function suggestAssignee(
  owner: string,
  repo: string,
  affectedModule: string,
  installationId?: number
): Promise<string | null> {
  if (!affectedModule || affectedModule === 'unknown') return null;

  const octokit = await getInstallationOctokit(installationId);

  try {
    const { data: commits } = await octokit.repos.listCommits({
      owner,
      repo,
      per_page: 30,
    });

    const authorFrequency = new Map<string, number>();
    const moduleLower = affectedModule.toLowerCase();

    for (const commit of commits) {
      const login = commit.author?.login;
      if (!login) continue;

      // Boost authors whose commits reference the affected module
      const weight = commit.commit.message.toLowerCase().includes(moduleLower) ? 3 : 1;
      authorFrequency.set(login, (authorFrequency.get(login) ?? 0) + weight);
    }

    if (authorFrequency.size === 0) return null;

    return Array.from(authorFrequency.entries())
      .sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  } catch {
    // Don't fail the pipeline if blame lookup fails
    return null;
  }
}

/**
 * Finds files changed recently that match a module name — used to narrow
 * blame lookup to files actually related to the affected module.
 *
 * @param owner          - Repository owner
 * @param repo           - Repository name
 * @param affectedModule - Module/component/file name to search for
 * @param installationId - GitHub App installation ID (omit for PAT auth)
 */
export async function findAffectedFiles(
  owner: string,
  repo: string,
  affectedModule: string,
  installationId?: number
): Promise<string[]> {
  const octokit = await getInstallationOctokit(installationId);

  try {
    const { data: commits } = await octokit.repos.listCommits({
      owner,
      repo,
      per_page: 20,
    });

    const matchedFiles = new Set<string>();
    const moduleLower = affectedModule.toLowerCase();

    await Promise.all(
      commits.slice(0, 10).map(async (commit) => {
        try {
          const { data } = await octokit.repos.getCommit({ owner, repo, ref: commit.sha });
          for (const file of data.files ?? []) {
            if (file.filename.toLowerCase().includes(moduleLower)) {
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
