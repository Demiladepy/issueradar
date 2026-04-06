import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'IssueRadar — AI-powered GitHub issue triage',
  description:
    'IssueRadar monitors GitHub Issues and Slack threads, uses Oxlo AI to classify severity, detect duplicates, and draft structured tickets.',
  openGraph: {
    title: 'IssueRadar',
    description: 'Zero-noise GitHub issue triage powered by Oxlo AI',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-50">
        <nav className="bg-white border-b border-gray-200 sticky top-0 z-10">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between h-16">
              <div className="flex items-center gap-8">
                <a href="/" className="flex items-center gap-2 font-bold text-lg text-brand-500">
                  <span className="text-2xl">📡</span>
                  <span>IssueRadar</span>
                </a>
                <div className="hidden sm:flex items-center gap-6 text-sm font-medium text-gray-600">
                  <a href="/" className="hover:text-brand-500 transition-colors">Dashboard</a>
                  <a href="/demo" className="hover:text-brand-500 transition-colors">Live Demo</a>
                  <a href="/digest" className="hover:text-brand-500 transition-colors">Digest</a>
                </div>
              </div>
              <a
                href="https://github.com/your-username/issueradar"
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-gray-500 hover:text-gray-800 transition-colors"
              >
                GitHub →
              </a>
            </div>
          </div>
        </nav>
        <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">{children}</main>
        <footer className="border-t border-gray-200 mt-16 py-6 text-center text-sm text-gray-400">
          Built for OxBuild · Powered by{' '}
          <a href="https://oxlo.ai" className="underline hover:text-gray-600">Oxlo AI</a>
        </footer>
      </body>
    </html>
  );
}
