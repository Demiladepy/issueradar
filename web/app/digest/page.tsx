import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Daily Digest — IssueRadar',
};

interface DigestIssue {
  id: string;
  type: string;
  title: string;
  sourceUrl: string;
  sourceId: string;
  severityScore: number;
  severityLabel: string;
  severityReason: string;
  affectedModule: string;
  duplicateIds: string[];
  analyzedAt: string;
}

interface DigestResponse {
  issues: DigestIssue[];
}

async function fetchDigest(): Promise<DigestResponse | null> {
  const backendUrl = process.env.BACKEND_URL ?? 'http://localhost:3000';
  try {
    const res = await fetch(`${backendUrl}/api/digest/latest`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    return (await res.json()) as DigestResponse;
  } catch {
    return null;
  }
}

const SEVERITY_CONFIG: Record<number, { emoji: string; label: string; bg: string; text: string }> = {
  5: { emoji: '🔴', label: 'Critical', bg: 'bg-red-50', text: 'text-red-700' },
  4: { emoji: '🟠', label: 'High', bg: 'bg-orange-50', text: 'text-orange-700' },
  3: { emoji: '🟡', label: 'Medium', bg: 'bg-yellow-50', text: 'text-yellow-700' },
  2: { emoji: '🔵', label: 'Low', bg: 'bg-blue-50', text: 'text-blue-700' },
  1: { emoji: '⬜', label: 'Trivial', bg: 'bg-gray-50', text: 'text-gray-600' },
};

export default async function DigestPage(): Promise<React.JSX.Element> {
  const data = await fetchDigest();
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Daily Digest — {today}</h1>
        <p className="text-gray-500">
          Zero-noise summary of all issues processed today, grouped by severity.
        </p>
      </div>

      {!data ? (
        <div className="rounded-xl bg-yellow-50 border border-yellow-200 p-6 text-center">
          <p className="text-yellow-800 font-medium">Backend not connected</p>
          <p className="text-yellow-600 text-sm mt-1">
            Start the IssueRadar server and ensure <code className="font-mono">BACKEND_URL</code> is set.
          </p>
        </div>
      ) : data.issues.length === 0 ? (
        <div className="rounded-xl bg-green-50 border border-green-200 p-8 text-center">
          <p className="text-4xl mb-3">🎉</p>
          <p className="text-green-800 font-semibold text-lg">No issues today!</p>
          <p className="text-green-600 text-sm mt-1">Nothing has been processed yet today.</p>
        </div>
      ) : (
        <DigestList issues={data.issues} />
      )}
    </div>
  );
}

function DigestList({ issues }: { issues: DigestIssue[] }): React.JSX.Element {
  const bugs = issues.filter((i) => i.type === 'bug');
  const features = issues.filter((i) => i.type === 'feature');
  const dupes = issues.filter((i) => i.duplicateIds.length > 0);

  const summary = [
    `${bugs.length} bug${bugs.length !== 1 ? 's' : ''}`,
    `${features.length} feature request${features.length !== 1 ? 's' : ''}`,
    `${dupes.length} duplicate${dupes.length !== 1 ? 's' : ''} caught`,
  ].join(' · ');

  const grouped = new Map<number, DigestIssue[]>();
  for (const issue of bugs) {
    const score = issue.severityScore;
    if (!grouped.has(score)) grouped.set(score, []);
    grouped.get(score)!.push(issue);
  }

  return (
    <div>
      <div className="mb-6 p-4 bg-brand-50 border border-brand-500/20 rounded-xl text-brand-500 font-medium">
        {summary}
      </div>

      {[5, 4, 3, 2, 1].map((score) => {
        const sectionIssues = grouped.get(score) ?? [];
        if (sectionIssues.length === 0) return null;
        const config = SEVERITY_CONFIG[score]!;

        return (
          <div key={score} className="mb-8">
            <h2 className={`text-lg font-semibold mb-3 ${config.text}`}>
              {config.emoji} {config.label} ({sectionIssues.length})
            </h2>
            <div className="space-y-3">
              {sectionIssues.map((issue) => (
                <IssueCard key={issue.id} issue={issue} />
              ))}
            </div>
          </div>
        );
      })}

      {features.length > 0 && (
        <div className="mb-8">
          <h2 className="text-lg font-semibold mb-3 text-purple-700">✨ Feature Requests ({features.length})</h2>
          <div className="space-y-3">
            {features.map((issue) => (
              <IssueCard key={issue.id} issue={issue} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function IssueCard({ issue }: { issue: DigestIssue }): React.JSX.Element {
  const config = SEVERITY_CONFIG[issue.severityScore] ?? SEVERITY_CONFIG[1]!;

  return (
    <div className={`rounded-xl border p-4 ${config.bg} border-gray-200`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <a
            href={issue.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-gray-900 hover:underline block truncate"
          >
            {issue.title}
          </a>
          <p className="text-sm text-gray-500 mt-1">{issue.severityReason}</p>
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            {issue.affectedModule && (
              <span className="text-xs bg-white border border-gray-200 text-gray-600 px-2 py-0.5 rounded font-mono">
                {issue.affectedModule}
              </span>
            )}
            {issue.duplicateIds.length > 0 && (
              <span className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded">
                ♻️ possible duplicate
              </span>
            )}
            <span className="text-xs text-gray-400">{issue.sourceId}</span>
          </div>
        </div>
        <span className={`text-lg flex-shrink-0 ${config.text}`}>{config.emoji}</span>
      </div>
    </div>
  );
}
