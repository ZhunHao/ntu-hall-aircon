import type { Activity } from "../shared/api";

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

interface ActivityRow extends Record<string, SqlStorageValue> {
  id: number;
  at: number;
  kind: Activity["kind"];
  summary: string;
  result: Activity["result"];
  reason: string | null;
}

/** SQLite-backed state of the Home Durable Object. Construct inside blockConcurrencyWhile. */
export class Store {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires INTEGER);
      CREATE TABLE IF NOT EXISTS activity (
        id INTEGER PRIMARY KEY, at INTEGER, kind TEXT, summary TEXT, result TEXT, reason TEXT
      );
      CREATE TABLE IF NOT EXISTS attempts (at INTEGER, ip TEXT);
      CREATE INDEX IF NOT EXISTS attempts_at ON attempts (at);
      CREATE INDEX IF NOT EXISTS attempts_ip_at ON attempts (ip, at);
    `);
  }

  get<T>(key: string): T | undefined {
    const rows = this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = ?", key).toArray();
    return rows[0] ? (JSON.parse(rows[0].value) as T) : undefined;
  }

  put(key: string, v: unknown): void {
    this.sql.exec(
      "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      JSON.stringify(v),
    );
  }

  del(key: string): void {
    this.sql.exec("DELETE FROM kv WHERE key = ?", key);
  }

  addSession(hash: string, expiresMs: number): void {
    this.sql.exec(
      "INSERT INTO sessions (hash, expires) VALUES (?, ?) ON CONFLICT(hash) DO UPDATE SET expires = excluded.expires",
      hash,
      expiresMs,
    );
  }

  hasSession(hash: string, nowMs: number): boolean {
    return (
      this.sql
        .exec("SELECT 1 FROM sessions WHERE hash = ? AND expires > ?", hash, nowMs)
        .toArray().length > 0
    );
  }

  clearSessions(): void {
    this.sql.exec("DELETE FROM sessions");
  }

  log(a: Omit<Activity, "id">): void {
    this.sql.exec(
      "INSERT INTO activity (at, kind, summary, result, reason) VALUES (?, ?, ?, ?, ?)",
      a.at,
      a.kind,
      a.summary,
      a.result,
      a.reason ?? null,
    );
  }

  /** Newest first. */
  activity(limit: number): Activity[] {
    return this.sql
      .exec<ActivityRow>("SELECT id, at, kind, summary, result, reason FROM activity ORDER BY at DESC, id DESC LIMIT ?", limit)
      .toArray()
      .map(({ reason, ...rest }) => (reason === null ? rest : { ...rest, reason }));
  }

  /** Drop activity older than 90 days. */
  prune(nowMs: number): void {
    this.sql.exec("DELETE FROM activity WHERE at < ?", nowMs - RETENTION_MS);
  }

  /**
   * Drop attempts older than the window, then record one for `ip` only if both limits still have room.
   * A refused call records nothing, so it uses none of the shared budget and adds no row.
   * `ip` and `total` are the counts inside the window, including this attempt when it was recorded.
   */
  attempt(
    ip: string,
    nowMs: number,
    windowMs: number,
    limits: { perIp: number; total: number },
  ): { allowed: boolean; ip: number; total: number } {
    this.sql.exec("DELETE FROM attempts WHERE at <= ?", nowMs - windowMs);
    const r = this.sql
      .exec<{ total: number; mine: number }>(
        "SELECT COUNT(*) AS total, COALESCE(SUM(ip = ?), 0) AS mine FROM attempts",
        ip,
      )
      .one();
    if (r.mine >= limits.perIp || r.total >= limits.total) return { allowed: false, ip: r.mine, total: r.total };
    this.sql.exec("INSERT INTO attempts (at, ip) VALUES (?, ?)", nowMs, ip);
    return { allowed: true, ip: r.mine + 1, total: r.total + 1 };
  }
}
