import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Dashboard — IssueRadar',
};

interface Stats {
  totalProcessed: number;
  processedToday: number;
  processedThisWeek: number;
  bugsFound: number;
  dupsCaught: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
}

async function fetchStats(): Promise<Stats | null> {
  const backendUrl = process.env.BACKEND_URL ?? 'http://localhost:3000';
  try {
    const res = await fetch(`${backendUrl}/api/stats`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    return (await res.json()) as Stats;
  } catch {
    return null;
  }
}

function StatCard({
  label,
  value,
  sub,
  color = 'gray',
}: {
  label: string;
  value: number | string;
  sub?: string;
  color?: 'gray' | 'red' | 'orange' | 'yellow' | 'green' | 'purple';
}): React.JSX.Element {
  const colorMap: Record<string, string> = {
    gray: 'bg-white border-gray-200',
    red: 'bg-red-50 border-red-200',
    orange: 'bg-orange-50 border-orange-200',
    yellow: 'bg-yellow-50 border-yellow-200',
    green: 'bg-green-50 border-green-200',
    purple: 'bg-purple-50 border-purple-200',
  };

  return (
    <div className={`rounded-xl border p-6 ${colorMap[color]}`}>
      <p className="text-sm font-medium text-gray-500 mb-1">{label}</p>
      <p className="text-3xl font-bold text-gray-900">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
    </div>
  );
}

export default async function DashboardPage(): Promise<React.JSX.Element> {
  const stats = await fetchStats();

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Issue Intelligence Dashboard</h1>
        <p className="text-gray-500">
          Real-time view of GitHub issues and Slack messages analyzed by Oxlo AI.
          <a href="/demo" className="ml-2 text-brand-500 font-medium hover:underline">
            Try the live demo →
          </a>
        </p>
      </div>

      {!stats ? (
        <div className="rounded-xl bg-yellow-50 border border-yellow-200 p-6 text-center">
          <p className="text-yellow-800 font-medium">Backend not connected</p>
          <p className="text-yellow-600 text-sm mt-1">
            Start the IssueRadar server (<code className="font-mono">npm run dev</code>) and set{' '}
            <code className="font-mono">BACKEND_URL</code> in your environment.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 mb-8">
            <StatCard label="Total Issues Analyzed" value={stats.totalProcessed} color="purple" />
            <StatCard label="Processed Today" value={stats.processedToday} sub="since midnight UTC" />
            <StatCard label="This Week" value={stats.processedThisWeek} sub="rolling 7 days" />
            <StatCard label="Bugs Found" value={stats.bugsFound} color="orange" sub="across all sources" />
            <StatCard label="Duplicates Caught" value={stats.dupsCaught} color="green" sub="before they wasted anyone's time" />
            <StatCard label="Critical" value={stats.criticalCount} color="red" sub="severity 5/5" />
            <StatCard label="High" value={stats.highCount} color="orange" sub="severity 4/5" />
            <StatCard label="Medium" value={stats.mediumCount} color="yellow" sub="severity 3/5" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <h2 className="font-semibold text-gray-800 mb-4">Severity Breakdown</h2>
              <SeverityBar label="Critical" count={stats.criticalCount} total={stats.bugsFound} color="bg-red-500" />
              <SeverityBar label="High" count={stats.highCount} total={stats.bugsFound} color="bg-orange-500" />
              <SeverityBar label="Medium" count={stats.mediumCount} total={stats.bugsFound} color="bg-yellow-400" />
              <SeverityBar
                label="Low / Trivial"
                count={Math.max(0, stats.bugsFound - stats.criticalCount - stats.highCount - stats.mediumCount)}
                total={stats.bugsFound}
                color="bg-blue-400"
              />
            </div>

            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <h2 className="font-semibold text-gray-800 mb-4">Quick Links</h2>
              <div className="space-y-3">
                <QuickLink href="/demo" icon="🔬" label="Live Demo" sub="Paste any GitHub issue URL and see the 4-call pipeline" />
                <QuickLink href="/digest" icon="📋" label="Daily Digest" sub="View today's zero-noise issue summary" />
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function SeverityBar({
  label,
  count,
  total,
  color,
}: {
  label: string;
  count: number;
  total: number;
  color: string;
}): React.JSX.Element {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div className="mb-3">
      <div className="flex justify-between text-sm mb-1">
        <span className="text-gray-600">{label}</span>
        <span className="text-gray-900 font-medium">{count}</span>
      </div>
      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function QuickLink({
  href,
  icon,
  label,
  sub,
}: {
  href: string;
  icon: string;
  label: string;
  sub: string;
}): React.JSX.Element {
  return (
    <a
      href={href}
      className="flex items-start gap-3 p-3 rounded-lg hover:bg-gray-50 transition-colors group"
    >
      <span className="text-2xl">{icon}</span>
      <div>
        <p className="font-medium text-gray-800 group-hover:text-brand-500 transition-colors">{label}</p>
        <p className="text-sm text-gray-400">{sub}</p>
      </div>
    </a>
  );
}
