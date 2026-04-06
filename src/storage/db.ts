import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { AnalysisResult } from '../pipeline.js';
import type { IssueSummary } from '../oxlo/deduplicator.js';

let _db: DatabaseType | null = null;

/**
 * Returns the singleton SQLite database connection, initializing it on first call.
 * Creates all required tables if they don't exist.
 */
export function getDb(): DatabaseType {
  if (_db) return _db;

  const dbPath = process.env.DB_PATH ?? './issueradar.db';
  _db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS processed_issues (
      id                TEXT PRIMARY KEY,
      source            TEXT NOT NULL,
      source_id         TEXT NOT NULL,
      source_url        TEXT NOT NULL,
      raw_text          TEXT NOT NULL,
      type              TEXT NOT NULL,
      type_confidence   REAL NOT NULL,
      title             TEXT NOT NULL,
      description       TEXT NOT NULL,
      steps_to_reproduce TEXT NOT NULL,
      expected_behavior TEXT NOT NULL,
      actual_behavior   TEXT NOT NULL,
      affected_module   TEXT NOT NULL,
      affected_version  TEXT,
      environment       TEXT,
      severity_score    INTEGER NOT NULL,
      severity_reason   TEXT NOT NULL,
      severity_label    TEXT NOT NULL,
      duplicate_ids     TEXT NOT NULL,
      analyzed_at       TEXT NOT NULL,
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS daily_digests (
      id         TEXT PRIMARY KEY,
      date       TEXT NOT NULL UNIQUE,
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS issue_embeddings (
      issue_id   TEXT PRIMARY KEY,
      summary    TEXT NOT NULL,
      FOREIGN KEY (issue_id) REFERENCES processed_issues(id) ON DELETE CASCADE
    );
  `);

  return _db;
}

/** A stored issue row as returned from the database. */
export interface StoredIssue {
  id: string;
  source: string;
  sourceId: string;
  sourceUrl: string;
  rawText: string;
  type: string;
  typeConfidence: number;
  title: string;
  description: string;
  stepsToReproduce: string[];
  expectedBehavior: string;
  actualBehavior: string;
  affectedModule: string;
  affectedVersion: string | null;
  environment: string | null;
  severityScore: number;
  severityReason: string;
  severityLabel: string;
  duplicateIds: string[];
  analyzedAt: string;
  createdAt: string;
}

/**
 * Saves a completed analysis result to the database.
 *
 * @param rawText - The original raw text that was analyzed
 * @param result  - The full pipeline analysis result
 * @returns The generated unique ID for this record
 */
export function saveAnalysis(rawText: string, result: AnalysisResult): string {
  const db = getDb();
  const id = `${result.source}-${result.sourceId}-${Date.now()}`;

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO processed_issues (
      id, source, source_id, source_url, raw_text,
      type, type_confidence,
      title, description, steps_to_reproduce,
      expected_behavior, actual_behavior,
      affected_module, affected_version, environment,
      severity_score, severity_reason, severity_label,
      duplicate_ids, analyzed_at
    ) VALUES (
      @id, @source, @sourceId, @sourceUrl, @rawText,
      @type, @typeConfidence,
      @title, @description, @stepsToReproduce,
      @expectedBehavior, @actualBehavior,
      @affectedModule, @affectedVersion, @environment,
      @severityScore, @severityReason, @severityLabel,
      @duplicateIds, @analyzedAt
    )
  `);

  stmt.run({
    id,
    source: result.source,
    sourceId: result.sourceId,
    sourceUrl: result.sourceUrl,
    rawText,
    type: result.classification.type,
    typeConfidence: result.classification.confidence,
    title: result.extracted.title,
    description: result.extracted.description,
    stepsToReproduce: JSON.stringify(result.extracted.stepsToReproduce),
    expectedBehavior: result.extracted.expectedBehavior,
    actualBehavior: result.extracted.actualBehavior,
    affectedModule: result.extracted.affectedModule,
    affectedVersion: result.extracted.affectedVersion,
    environment: result.extracted.environment,
    severityScore: result.severity.score,
    severityReason: result.severity.reason,
    severityLabel: result.severity.label,
    duplicateIds: JSON.stringify(result.deduplication.duplicateIds),
    analyzedAt: result.analyzedAt,
  });

  // Also save the embedding summary for future dedup
  db.prepare(`
    INSERT OR REPLACE INTO issue_embeddings (issue_id, summary)
    VALUES (@issueId, @summary)
  `).run({
    issueId: id,
    summary: `${result.extracted.title}\n${result.extracted.description}\nModule: ${result.extracted.affectedModule}`,
  });

  return id;
}

/**
 * Returns issue summaries for deduplication lookup.
 * Limits to the most recent N issues to keep Oxlo prompt size manageable.
 *
 * @param limit - Maximum number of summaries to return (default 50)
 */
export function getIssueSummaries(limit = 50): IssueSummary[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT i.id, i.title, i.description, i.affected_module
       FROM issue_embeddings e
       JOIN processed_issues i ON i.id = e.issue_id
       ORDER BY i.created_at DESC
       LIMIT ?`
    )
    .all(limit) as Array<{
    id: string;
    title: string;
    description: string;
    affected_module: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    affectedModule: r.affected_module,
  }));
}

/** Dashboard statistics aggregated from the database. */
export interface DashboardStats {
  totalProcessed: number;
  processedToday: number;
  processedThisWeek: number;
  bugsFound: number;
  dupsCaught: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
}

/** Returns aggregated statistics for the web dashboard. */
export function getDashboardStats(): DashboardStats {
  const db = getDb();

  const total = (
    db.prepare('SELECT COUNT(*) as count FROM processed_issues').get() as { count: number }
  ).count;

  const today = (
    db
      .prepare(
        `SELECT COUNT(*) as count FROM processed_issues WHERE date(created_at) = date('now')`
      )
      .get() as { count: number }
  ).count;

  const week = (
    db
      .prepare(
        `SELECT COUNT(*) as count FROM processed_issues WHERE created_at >= datetime('now', '-7 days')`
      )
      .get() as { count: number }
  ).count;

  const bugs = (
    db
      .prepare(`SELECT COUNT(*) as count FROM processed_issues WHERE type = 'bug'`)
      .get() as { count: number }
  ).count;

  const dupes = (
    db
      .prepare(
        `SELECT COUNT(*) as count FROM processed_issues WHERE duplicate_ids != '[]'`
      )
      .get() as { count: number }
  ).count;

  const critical = (
    db
      .prepare(`SELECT COUNT(*) as count FROM processed_issues WHERE severity_score = 5`)
      .get() as { count: number }
  ).count;

  const high = (
    db
      .prepare(`SELECT COUNT(*) as count FROM processed_issues WHERE severity_score = 4`)
      .get() as { count: number }
  ).count;

  const medium = (
    db
      .prepare(`SELECT COUNT(*) as count FROM processed_issues WHERE severity_score = 3`)
      .get() as { count: number }
  ).count;

  return {
    totalProcessed: total,
    processedToday: today,
    processedThisWeek: week,
    bugsFound: bugs,
    dupsCaught: dupes,
    criticalCount: critical,
    highCount: high,
    mediumCount: medium,
  };
}

/**
 * Returns all issues processed today, ordered by severity descending.
 * Used to generate the daily digest.
 */
export function getTodaysIssues(): StoredIssue[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM processed_issues
       WHERE date(created_at) = date('now')
       ORDER BY severity_score DESC, created_at DESC`
    )
    .all() as Array<Record<string, unknown>>;

  return rows.map(rowToStoredIssue);
}

/** Returns the most recent daily digest, if one exists. */
export function getLatestDigest(): { date: string; content: string } | null {
  const db = getDb();
  const row = db
    .prepare('SELECT date, content FROM daily_digests ORDER BY date DESC LIMIT 1')
    .get() as { date: string; content: string } | undefined;

  return row ?? null;
}

/** Saves a generated daily digest. */
export function saveDigest(date: string, content: string): void {
  const db = getDb();
  db.prepare(
    'INSERT OR REPLACE INTO daily_digests (id, date, content) VALUES (@id, @date, @content)'
  ).run({ id: `digest-${date}`, date, content });
}

function rowToStoredIssue(row: Record<string, unknown>): StoredIssue {
  return {
    id: row.id as string,
    source: row.source as string,
    sourceId: row.source_id as string,
    sourceUrl: row.source_url as string,
    rawText: row.raw_text as string,
    type: row.type as string,
    typeConfidence: row.type_confidence as number,
    title: row.title as string,
    description: row.description as string,
    stepsToReproduce: JSON.parse(row.steps_to_reproduce as string) as string[],
    expectedBehavior: row.expected_behavior as string,
    actualBehavior: row.actual_behavior as string,
    affectedModule: row.affected_module as string,
    affectedVersion: row.affected_version as string | null,
    environment: row.environment as string | null,
    severityScore: row.severity_score as number,
    severityReason: row.severity_reason as string,
    severityLabel: row.severity_label as string,
    duplicateIds: JSON.parse(row.duplicate_ids as string) as string[],
    analyzedAt: row.analyzed_at as string,
    createdAt: row.created_at as string,
  };
}
