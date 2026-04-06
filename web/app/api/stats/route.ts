import { type NextRequest } from 'next/server';

export const runtime = 'nodejs';

/**
 * GET /api/stats
 * Proxies to the backend IssueRadar server's /api/stats endpoint.
 */
export async function GET(_req: NextRequest): Promise<Response> {
  const backendUrl = process.env.BACKEND_URL ?? 'http://localhost:3000';

  try {
    const res = await fetch(`${backendUrl}/api/stats`, {
      next: { revalidate: 60 },
    });

    if (!res.ok) {
      return Response.json({ error: 'Backend unavailable' }, { status: 502 });
    }

    const data = await res.json();
    return Response.json(data);
  } catch {
    return Response.json({ error: 'Could not connect to backend' }, { status: 502 });
  }
}
