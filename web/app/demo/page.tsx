'use client';

import { useState } from 'react';

type StepStatus = 'waiting' | 'running' | 'done' | 'error';

interface PipelineStep {
  id: string;
  name: string;
  description: string;
  callNumber: number;
  parallel?: boolean;
}

interface AnalysisResult {
  classification: { type: string; confidence: number };
  extracted: {
    title: string;
    description: string;
    stepsToReproduce: string[];
    expectedBehavior: string;
    actualBehavior: string;
    affectedModule: string;
  };
  severity: { score: number; reason: string; label: string };
  deduplication: { duplicateIds: string[]; confidence: number };
  trace: { classifyMs: number; extractMs: number; scoreMs: number; deduplicateMs: number; totalMs: number };
}

interface StepState {
  status: StepStatus;
  result?: string;
  ms?: number;
}

const STEPS: PipelineStep[] = [
  { id: 'classify', callNumber: 1, name: 'Classify', description: 'Determine type: bug / feature / question / noise' },
  { id: 'extract', callNumber: 2, name: 'Extract', description: 'Pull structured fields from raw text' },
  { id: 'score', callNumber: 3, name: 'Score Severity', description: 'Rate 1–5 with justification', parallel: true },
  { id: 'deduplicate', callNumber: 4, name: 'Deduplicate', description: 'Check against existing issues', parallel: true },
];

const SEVERITY_EMOJI: Record<number, string> = { 1: '⬜', 2: '🔵', 3: '🟡', 4: '🟠', 5: '🔴' };

export default function DemoPage(): React.JSX.Element {
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [inputMode, setInputMode] = useState<'url' | 'text'>('url');
  const [steps, setSteps] = useState<Record<string, StepState>>({});
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const updateStep = (id: string, update: Partial<StepState>): void => {
    setSteps((prev) => ({ ...prev, [id]: { ...prev[id], status: 'waiting', ...update } }));
  };

  const run = async (): Promise<void> => {
    setRunning(true);
    setError(null);
    setResult(null);
    setSteps({});

    // Initialize all steps as waiting
    for (const step of STEPS) updateStep(step.id, { status: 'waiting' });

    try {
      // Step 1: classify
      updateStep('classify', { status: 'running' });
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: inputMode === 'url' ? url : undefined, text: inputMode === 'text' ? text : undefined }),
      });

      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(err.error ?? 'Analysis failed');
      }

      // Stream step updates via SSE-style JSON lines
      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = JSON.parse(line.slice(6)) as
            | { type: 'step_start'; step: string }
            | { type: 'step_done'; step: string; result: string; ms: number }
            | { type: 'complete'; result: AnalysisResult }
            | { type: 'error'; message: string };

          if (data.type === 'step_start') {
            updateStep(data.step, { status: 'running' });
          } else if (data.type === 'step_done') {
            updateStep(data.step, { status: 'done', result: data.result, ms: data.ms });
          } else if (data.type === 'complete') {
            setResult(data.result);
          } else if (data.type === 'error') {
            throw new Error(data.message);
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      for (const step of STEPS) {
        setSteps((prev) => {
          if (prev[step.id]?.status === 'running') {
            return { ...prev, [step.id]: { status: 'error' } };
          }
          return prev;
        });
      }
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Live Demo</h1>
        <p className="text-gray-500">
          Paste a GitHub issue URL or raw text and watch the 4-call Oxlo AI pipeline fire in real time.
        </p>
      </div>

      {/* Input */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
        <div className="flex gap-3 mb-4">
          <button
            onClick={() => setInputMode('url')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${inputMode === 'url' ? 'bg-brand-500 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          >
            GitHub Issue URL
          </button>
          <button
            onClick={() => setInputMode('text')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${inputMode === 'text' ? 'bg-brand-500 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          >
            Raw Text
          </button>
        </div>

        {inputMode === 'url' ? (
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/owner/repo/issues/123"
            className="w-full border border-gray-200 rounded-lg px-4 py-3 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        ) : (
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste the raw issue title + body here..."
            rows={6}
            className="w-full border border-gray-200 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none"
          />
        )}

        <button
          onClick={() => void run()}
          disabled={running || (inputMode === 'url' ? !url.trim() : !text.trim())}
          className="mt-4 px-6 py-3 bg-brand-500 text-white rounded-lg font-semibold hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {running ? 'Analyzing…' : 'Analyze with Oxlo AI →'}
        </button>
      </div>

      {/* Pipeline steps */}
      {Object.keys(steps).length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
          <h2 className="font-semibold text-gray-800 mb-4">4-Call Oxlo Pipeline</h2>
          <div className="space-y-3">
            {STEPS.map((step) => {
              const s = steps[step.id] ?? { status: 'waiting' as StepStatus };
              return (
                <div key={step.id} className="flex items-center gap-4">
                  <div className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center text-xs font-bold text-gray-400 flex-shrink-0">
                    {step.callNumber}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm text-gray-800">
                        {step.name}
                        {step.parallel && (
                          <span className="ml-2 text-xs text-purple-500 font-normal">parallel</span>
                        )}
                      </span>
                      <StepIndicator status={s.status} ms={s.ms} />
                    </div>
                    <p className="text-xs text-gray-400">{step.description}</p>
                    {s.result && s.status === 'done' && (
                      <p className="text-xs text-gray-600 mt-1 font-mono bg-gray-50 px-2 py-1 rounded">
                        {s.result}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-6 text-red-700 text-sm">
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* Result */}
      {result && <AnalysisResultPanel result={result} />}
    </div>
  );
}

function StepIndicator({ status, ms }: { status: StepStatus; ms?: number }): React.JSX.Element {
  if (status === 'waiting') return <span className="text-xs text-gray-300">waiting</span>;
  if (status === 'running') return <span className="text-xs text-blue-500 animate-pulse">running…</span>;
  if (status === 'error') return <span className="text-xs text-red-500">failed</span>;
  return <span className="text-xs text-green-500">✓ {ms ? `${ms}ms` : 'done'}</span>;
}

function AnalysisResultPanel({ result }: { result: AnalysisResult }): React.JSX.Element {
  const severityEmoji = SEVERITY_EMOJI[result.severity.score] ?? '❓';
  const typeColor: Record<string, string> = {
    bug: 'text-red-700 bg-red-50',
    feature: 'text-purple-700 bg-purple-50',
    question: 'text-blue-700 bg-blue-50',
    noise: 'text-gray-600 bg-gray-100',
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="font-semibold text-gray-800 text-lg">Analysis Result</h2>
        <span className="text-xs text-gray-400">
          {result.trace.totalMs}ms total · {result.trace.classifyMs}ms classify · {result.trace.extractMs}ms extract
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <div className="rounded-lg bg-gray-50 p-3">
          <p className="text-xs text-gray-400 mb-1">Type</p>
          <span className={`text-sm font-semibold px-2 py-0.5 rounded ${typeColor[result.classification.type] ?? 'text-gray-700 bg-gray-100'}`}>
            {result.classification.type}
          </span>
          <p className="text-xs text-gray-400 mt-1">{Math.round(result.classification.confidence * 100)}% confidence</p>
        </div>

        <div className="rounded-lg bg-gray-50 p-3">
          <p className="text-xs text-gray-400 mb-1">Severity</p>
          <p className="text-2xl">{severityEmoji}</p>
          <p className="text-xs text-gray-500 mt-1">{result.severity.score}/5</p>
        </div>

        <div className="rounded-lg bg-gray-50 p-3">
          <p className="text-xs text-gray-400 mb-1">Module</p>
          <p className="text-sm font-mono text-gray-800 truncate">{result.extracted.affectedModule || 'unknown'}</p>
        </div>

        <div className="rounded-lg bg-gray-50 p-3">
          <p className="text-xs text-gray-400 mb-1">Duplicates</p>
          <p className="text-sm font-semibold text-gray-800">
            {result.deduplication.duplicateIds.length === 0
              ? 'None found'
              : `${result.deduplication.duplicateIds.length} found`}
          </p>
        </div>
      </div>

      <div className="space-y-4">
        <Field label="Extracted Title" value={result.extracted.title} />
        <Field label="Description" value={result.extracted.description} />
        <Field label="Severity Reason" value={result.severity.reason} />
        {result.extracted.expectedBehavior && (
          <Field label="Expected" value={result.extracted.expectedBehavior} />
        )}
        {result.extracted.actualBehavior && (
          <Field label="Actual" value={result.extracted.actualBehavior} />
        )}
        {result.extracted.stepsToReproduce.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Steps to Reproduce</p>
            <ol className="list-decimal list-inside space-y-1">
              {result.extracted.stepsToReproduce.map((step, i) => (
                <li key={i} className="text-sm text-gray-700">{step}</li>
              ))}
            </ol>
          </div>
        )}
        {result.deduplication.duplicateIds.length > 0 && (
          <div className="bg-orange-50 border border-orange-200 rounded-lg p-3">
            <p className="text-xs font-semibold text-orange-700 mb-1">Possible Duplicates</p>
            <p className="text-sm text-orange-800">{result.deduplication.duplicateIds.join(', ')}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">{label}</p>
      <p className="text-sm text-gray-700">{value || '—'}</p>
    </div>
  );
}
