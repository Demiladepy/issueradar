import { createSign } from 'crypto';
import { readFileSync } from 'fs';
import { Octokit } from '@octokit/rest';

/**
 * GitHub App installation token cache entry.
 * Installation tokens expire after 1 hour — we refresh 5 minutes early.
 */
interface TokenCache {
  token: string;
  expiresAt: Date;
}

const tokenCache = new Map<number, TokenCache>();

/**
 * Signs a GitHub App JWT using the app's RSA private key.
 * JWTs are valid for 10 minutes — only used to exchange for installation tokens.
 *
 * @param appId      - GitHub App ID (from App settings)
 * @param privateKey - PEM-formatted RSA private key content
 * @returns Signed JWT string
 */
function signAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iat: now - 60, // allow for clock skew
      exp: now + 600, // 10 minutes
      iss: appId,
    })
  ).toString('base64url');

  const signingInput = `${header}.${payload}`;
  const sign = createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(privateKey, 'base64url');

  return `${signingInput}.${signature}`;
}

/**
 * Loads the GitHub App private key from the file path in GITHUB_PRIVATE_KEY_PATH,
 * or falls back to the GITHUB_PRIVATE_KEY env var (for Vercel/Railway deployments
 * where file paths aren't available).
 *
 * @returns PEM key string
 */
function loadPrivateKey(): string {
  const keyPath = process.env.GITHUB_PRIVATE_KEY_PATH;
  if (keyPath) {
    return readFileSync(keyPath, 'utf-8');
  }

  const keyEnv = process.env.GITHUB_PRIVATE_KEY;
  if (keyEnv) {
    // Handle escaped newlines from env var serialization
    return keyEnv.replace(/\\n/g, '\n');
  }

  throw new Error(
    'GitHub App private key not found. Set GITHUB_PRIVATE_KEY_PATH or GITHUB_PRIVATE_KEY.'
  );
}

/**
 * Returns a valid GitHub App installation access token for a given installation ID.
 * Tokens are cached and refreshed automatically 5 minutes before expiry.
 *
 * @param installationId - GitHub App installation ID (from webhook payload.installation.id)
 * @returns Installation access token valid for Octokit authentication
 */
export async function getInstallationToken(installationId: number): Promise<string> {
  const cached = tokenCache.get(installationId);
  const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);

  if (cached && cached.expiresAt > fiveMinutesFromNow) {
    return cached.token;
  }

  const appId = process.env.GITHUB_APP_ID;
  if (!appId) {
    // Fall back to PAT for local dev without a GitHub App configured
    const pat = process.env.GITHUB_TOKEN;
    if (pat) return pat;
    throw new Error('Neither GITHUB_APP_ID nor GITHUB_TOKEN is set');
  }

  const privateKey = loadPrivateKey();
  const jwt = signAppJwt(appId, privateKey);

  // Exchange JWT for installation token via GitHub API
  const appOctokit = new Octokit({ auth: jwt });
  const { data } = await appOctokit.apps.createInstallationAccessToken({
    installation_id: installationId,
  });

  const entry: TokenCache = {
    token: data.token,
    expiresAt: new Date(data.expires_at),
  };
  tokenCache.set(installationId, entry);

  return data.token;
}

/**
 * Returns an Octokit instance authenticated for a specific installation.
 * Handles token refresh automatically via the cache.
 *
 * @param installationId - GitHub App installation ID (or undefined for PAT auth)
 */
export async function getInstallationOctokit(installationId?: number): Promise<Octokit> {
  if (!installationId) {
    // Local dev: use PAT
    return new Octokit({ auth: process.env.GITHUB_TOKEN });
  }

  const token = await getInstallationToken(installationId);
  return new Octokit({ auth: token });
}
