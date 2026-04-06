import { type NextRequest } from 'next/server';
import { OxloClient } from '../../../lib/oxlo-client';
import { classifyIssue } from '../../../lib/classifier';
import { extractIssueFields } from '../../../lib/extractor';
import { scoreIssueSeverity } from '../../../lib/scorer';
import { findDuplicateIssues } from '../../../lib/deduplicator';

export const runtime = 'nodejs';
export const maxDuration = 60;

interface RequestBody {
  url?: string;
  text?: string;
}

/**
 * POST /api/analyze
 *
 * Runs the 4-call Oxlo pipeline on a GitHub issue URL or raw text.
 * Returns a Server-Sent Events stream so the demo page can show step-by-step progress.
 *
 * Body: { url?: string, text?: string }
 * Stream format: "data: <JSON>\n\n"
 */
export async function POST(req: NextRequest): Promise<Response> {
  const body = (await req.json()) as RequestBody;

  let issueText: string;

  if (body.url) {
    const fetchedText = await fetchGitHubIssueText(body.url);
    if (!fetchedText) {
      return Response.json({ error: 'Could not fetch issue. Check the URL and try again.' }, { status: 400 });
    }
    issueText = fetchedText;
  } else if (body.text?.trim()) {
    issueText = body.text.trim();
  } else {
    return Response.json({ error: 'Provide either a GitHub issue URL or raw text.' }, { status: 400 });
  }

  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();

  const send = async (data: unknown): Promise<void> => {
    await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  };

  // Run pipeline async and stream results
  void (async () => {
    try {
      const client = new OxloClient();

      // ── Call 1: Classify ────────────────────────────────────────────────
      await send({ type: 'step_start', step: 'classify' });
      const classifyStart = Date.now();
      const classification = await classifyIssue(client, issueText);
      const classifyMs = Date.now() - classifyStart;
      await send({
        type: 'step_done',
        step: 'classify',
        result: `${classification.type} (${Math.round(classification.confidence * 100)}%)`,
        ms: classifyMs,
      });

      // ── Call 2: Extract ─────────────────────────────────────────────────
      await send({ type: 'step_start', step: 'extract' });
      const extractStart = Date.now();
      const extracted = await extractIssueFields(client, issueText, classification.type);
      const extractMs = Date.now() - extractStart;
      await send({
        type: 'step_done',
        step: 'extract',
        result: extracted.title,
        ms: extractMs,
      });

      // ── Calls 3 + 4: Score + Deduplicate (parallel) ─────────────────────
      await send({ type: 'step_start', step: 'score' });
      await send({ type: 'step_start', step: 'deduplicate' });

      const deduplicationText = `${extracted.title}\n${extracted.description}\nModule: ${extracted.affectedModule}`;
      const parallelStart = Date.now();

      const [severity, deduplication] = await Promise.all([
        scoreIssueSeverity(client, extracted),
        findDuplicateIssues(client, deduplicationText, []),
      ]);

      const parallelMs = Date.now() - parallelStart;

      await send({
        type: 'step_done',
        step: 'score',
        result: `${severity.score}/5 — ${severity.reason}`,
        ms: parallelMs,
      });
      await send({
        type: 'step_done',
        step: 'deduplicate',
        result: deduplication.duplicateIds.length === 0 ? 'No duplicates' : `${deduplication.duplicateIds.length} found`,
        ms: parallelMs,
      });

      const totalMs = classifyMs + extractMs + parallelMs;

      await send({
        type: 'complete',
        result: {
          classification,
          extracted,
          severity,
          deduplication,
          trace: {
            classifyMs,
            extractMs,
            scoreMs: parallelMs,
            deduplicateMs: parallelMs,
            totalMs,
          },
        },
      });
    } catch (err) {
      await send({
        type: 'error',
        message: err instanceof Error ? err.message : 'Pipeline failed',
      });
    } finally {
      await writer.close();
    }
  })();

  return new Response(stream.readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

/**
 * Fetches a GitHub issue's title + body from a GitHub issue URL.
 * Parses the URL to extract owner/repo/number, then calls the GitHub API.
 */
async function fetchGitHubIssueText(url: string): Promise<string | null> {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (!match) return null;

  const [, owner, repo, number] = match;

  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${number}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'IssueRadar/1.0',
  };

  const token = process.env.GITHUB_TOKEN;
  if (token) headers['Authorization'] = `Bearer ${token}`;

  try {
    const res = await fetch(apiUrl, { headers });
    if (!res.ok) return null;

    const data = (await res.json()) as { title: string; body: string | null };
    return `${data.title}\n\n${data.body ?? ''}`.trim();
  } catch {
    return null;
  }
}
