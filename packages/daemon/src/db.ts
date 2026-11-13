import DatabaseConstructor, { type Database as DatabaseType, type Statement } from 'better-sqlite3';
import type {
  CompiledTaskSpec,
  InferenceTelemetryItem,
  Job,
  JobRun,
  RunAggregation
} from '@ofln-scout/shared';

interface TaskRow {
  id: string;
  name: string;
  user_goal: string;
  target_url: string;
  dom_selector: string;
  poll_interval_ms: number;
  scroll_step_px: number;
  spec_json: string;
  created_at: number;
}

interface AlertRow {
  id: string;
  task_id: string;
  run_id: string | null;
  timestamp: number;
  dom_snippet: string;
  latency_ms: number;
  raw_answers_json: string;
  triggered_alert: number;
}

interface JobRow {
  id: string;
  name: string;
  spec_json: string;
  cron_schedule: string | null;
  is_scheduled: number;
  status: string;
  last_run_at: number | null;
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
}

interface JobRunRow {
  id: string;
  job_id: string;
  started_at: number;
  completed_at: number | null;
  status: string;
  total_scanned: number;
  total_alerts: number;
  avg_latency_ms: number;
  error: string | null;
}

export class ScoutDatabase {
  private db: DatabaseType;
  private insertTaskStmt!: Statement<[
    string,
    string,
    string,
    string,
    string,
    number,
    number,
    string,
    number
  ]>;
  private getTaskStmt!: Statement<[string]>;
  private listTasksStmt!: Statement<[]>;
  private deleteTaskStmt!: Statement<[string]>;

  private insertAlertStmt!: Statement<[
    string,
    string,
    string | null,
    number,
    string,
    number,
    string,
    number
  ]>;
  private listAlertsAllStmt!: Statement<[]>;
  private listAlertsByTaskStmt!: Statement<[string]>;
  private listAlertsByRunStmt!: Statement<[string]>;
  private clearAlertsAllStmt!: Statement<[]>;
  private clearAlertsByTaskStmt!: Statement<[string]>;

  private insertJobStmt!: Statement<[
    string,
    string,
    string,
    string | null,
    number,
    string,
    number | null,
    number | null,
    number,
    number
  ]>;
  private getJobStmt!: Statement<[string]>;
  private listJobsStmt!: Statement<[]>;
  private deleteJobStmt!: Statement<[string]>;

  private insertJobRunStmt!: Statement<[
    string,
    string,
    number,
    number | null,
    string,
    number,
    number,
    number,
    string | null
  ]>;
  private getJobRunStmt!: Statement<[string]>;
  private listJobRunsAllStmt!: Statement<[]>;
  private listJobRunsByJobStmt!: Statement<[string]>;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? process.env.SCOUT_DB_PATH ?? 'scout_local.db';
    this.db = new DatabaseConstructor(resolvedPath);

    this.initPragmas();
    this.initSchema();
    this.prepareStatements();
  }

  private initPragmas(): void {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        user_goal TEXT NOT NULL,
        target_url TEXT NOT NULL,
        dom_selector TEXT NOT NULL,
        poll_interval_ms INTEGER NOT NULL,
        scroll_step_px INTEGER NOT NULL,
        spec_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS alerts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        run_id TEXT,
        timestamp INTEGER NOT NULL,
        dom_snippet TEXT NOT NULL,
        latency_ms REAL NOT NULL,
        raw_answers_json TEXT NOT NULL,
        triggered_alert INTEGER NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_alerts_task_id ON alerts(task_id);
      CREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON alerts(timestamp DESC);

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        cron_schedule TEXT,
        is_scheduled INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'idle',
        last_run_at INTEGER,
        next_run_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS job_runs (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        status TEXT NOT NULL DEFAULT 'running',
        total_scanned INTEGER NOT NULL DEFAULT 0,
        total_alerts INTEGER NOT NULL DEFAULT 0,
        avg_latency_ms REAL NOT NULL DEFAULT 0,
        error TEXT,
        FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_job_runs_job_id ON job_runs(job_id);
      CREATE INDEX IF NOT EXISTS idx_job_runs_started_at ON job_runs(started_at DESC);
    `);

    // Schema migration check for alerts.run_id
    try {
      const tableInfo = this.db.pragma('table_info(alerts)') as Array<{ name: string }>;
      const hasRunId = tableInfo.some((col) => col.name === 'run_id');
      if (!hasRunId && tableInfo.length > 0) {
        this.db.exec('ALTER TABLE alerts ADD COLUMN run_id TEXT;');
      }
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_alerts_run_id ON alerts(run_id);');
    } catch {
      // Ignored if pragma fails
    }
  }

  private prepareStatements(): void {
    this.insertTaskStmt = this.db.prepare(`
      INSERT INTO tasks (
        id, name, user_goal, target_url, dom_selector, poll_interval_ms, scroll_step_px, spec_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        user_goal = excluded.user_goal,
        target_url = excluded.target_url,
        dom_selector = excluded.dom_selector,
        poll_interval_ms = excluded.poll_interval_ms,
        scroll_step_px = excluded.scroll_step_px,
        spec_json = excluded.spec_json,
        created_at = excluded.created_at
    `);

    this.getTaskStmt = this.db.prepare(`SELECT spec_json FROM tasks WHERE id = ?`);
    this.listTasksStmt = this.db.prepare(`SELECT spec_json FROM tasks ORDER BY created_at DESC`);
    this.deleteTaskStmt = this.db.prepare(`DELETE FROM tasks WHERE id = ?`);

    this.insertAlertStmt = this.db.prepare(`
      INSERT INTO alerts (
        id, task_id, run_id, timestamp, dom_snippet, latency_ms, raw_answers_json, triggered_alert
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        task_id = excluded.task_id,
        run_id = excluded.run_id,
        timestamp = excluded.timestamp,
        dom_snippet = excluded.dom_snippet,
        latency_ms = excluded.latency_ms,
        raw_answers_json = excluded.raw_answers_json,
        triggered_alert = excluded.triggered_alert
    `);

    this.listAlertsAllStmt = this.db.prepare(`
      SELECT id, task_id, run_id, timestamp, dom_snippet, latency_ms, raw_answers_json, triggered_alert
      FROM alerts
      ORDER BY timestamp DESC
    `);

    this.listAlertsByTaskStmt = this.db.prepare(`
      SELECT id, task_id, run_id, timestamp, dom_snippet, latency_ms, raw_answers_json, triggered_alert
      FROM alerts
      WHERE task_id = ?
      ORDER BY timestamp DESC
    `);

    this.listAlertsByRunStmt = this.db.prepare(`
      SELECT id, task_id, run_id, timestamp, dom_snippet, latency_ms, raw_answers_json, triggered_alert
      FROM alerts
      WHERE run_id = ?
      ORDER BY timestamp DESC
    `);

    this.clearAlertsAllStmt = this.db.prepare(`DELETE FROM alerts`);
    this.clearAlertsByTaskStmt = this.db.prepare(`DELETE FROM alerts WHERE task_id = ?`);

    this.insertJobStmt = this.db.prepare(`
      INSERT INTO jobs (
        id, name, spec_json, cron_schedule, is_scheduled, status, last_run_at, next_run_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        spec_json = excluded.spec_json,
        cron_schedule = excluded.cron_schedule,
        is_scheduled = excluded.is_scheduled,
        status = excluded.status,
        last_run_at = excluded.last_run_at,
        next_run_at = excluded.next_run_at,
        updated_at = excluded.updated_at
    `);

    this.getJobStmt = this.db.prepare(`SELECT * FROM jobs WHERE id = ?`);
    this.listJobsStmt = this.db.prepare(`SELECT * FROM jobs ORDER BY updated_at DESC`);
    this.deleteJobStmt = this.db.prepare(`DELETE FROM jobs WHERE id = ?`);

    this.insertJobRunStmt = this.db.prepare(`
      INSERT INTO job_runs (
        id, job_id, started_at, completed_at, status, total_scanned, total_alerts, avg_latency_ms, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        job_id = excluded.job_id,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        status = excluded.status,
        total_scanned = excluded.total_scanned,
        total_alerts = excluded.total_alerts,
        avg_latency_ms = excluded.avg_latency_ms,
        error = excluded.error
    `);

    this.getJobRunStmt = this.db.prepare(`SELECT * FROM job_runs WHERE id = ?`);
    this.listJobRunsAllStmt = this.db.prepare(`SELECT * FROM job_runs ORDER BY started_at DESC`);
    this.listJobRunsByJobStmt = this.db.prepare(`SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC`);
  }

  /**
   * Insert or update a compiled task specification.
   */
  public insertTask(spec: CompiledTaskSpec): void {
    if (!this.db.open || !spec) return;
    this.insertTaskStmt.run(
      spec.id,
      spec.name,
      spec.userGoal,
      spec.targetUrl,
      spec.domSelector,
      spec.pollIntervalMs,
      spec.scrollStepPx,
      JSON.stringify(spec),
      spec.createdAt
    );
  }

  /**
   * Retrieve a task specification by ID.
   */
  public getTask(id: string): CompiledTaskSpec | null {
    if (!this.db.open) return null;
    const row = this.getTaskStmt.get(id) as { spec_json: string } | undefined;
    if (!row) {
      return null;
    }
    return JSON.parse(row.spec_json) as CompiledTaskSpec;
  }

  /**
   * List all stored task specifications, ordered newest to oldest.
   */
  public listTasks(): CompiledTaskSpec[] {
    if (!this.db.open) return [];
    const rows = this.listTasksStmt.all() as Array<{ spec_json: string }>;
    return rows.map((r) => JSON.parse(r.spec_json) as CompiledTaskSpec);
  }

  /**
   * Delete a task by ID (cascades to all associated alerts).
   */
  public deleteTask(id: string): void {
    if (!this.db.open) return;
    this.deleteTaskStmt.run(id);
  }

  /**
   * Insert or update an inference telemetry item / alert.
   */
  public saveAlert(item: InferenceTelemetryItem, runId?: string): void {
    if (!this.db.open) return;
    this.insertAlertStmt.run(
      item.id,
      item.taskId,
      runId ?? null,
      item.timestamp,
      item.domSnippet,
      item.latencyMs,
      JSON.stringify(item.rawAnswers),
      item.triggeredAlert ? 1 : 0
    );
  }

  /**
   * Backwards-compatible alias for saveAlert.
   */
  public insertAlert(item: InferenceTelemetryItem, runId?: string): void {
    this.saveAlert(item, runId);
  }

  /**
   * List alerts, optionally filtered by taskId or runId, ordered descending by timestamp.
   */
  public listAlerts(taskId?: string, runId?: string): InferenceTelemetryItem[] {
    if (!this.db.open) return [];
    let rows: AlertRow[];
    if (runId) {
      rows = this.listAlertsByRunStmt.all(runId) as AlertRow[];
    } else if (taskId) {
      rows = this.listAlertsByTaskStmt.all(taskId) as AlertRow[];
    } else {
      rows = this.listAlertsAllStmt.all() as AlertRow[];
    }

    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      timestamp: row.timestamp,
      domSnippet: row.dom_snippet,
      latencyMs: row.latency_ms,
      rawAnswers: JSON.parse(row.raw_answers_json),
      triggeredAlert: Boolean(row.triggered_alert)
    }));
  }

  /**
   * Clear alerts, optionally filtered by taskId.
   */
  public clearAlerts(taskId?: string): void {
    if (!this.db.open) return;
    if (taskId) {
      this.clearAlertsByTaskStmt.run(taskId);
    } else {
      this.clearAlertsAllStmt.run();
    }
  }

  // ===================== Job CRUD =====================

  private rowToJob(row: JobRow): Job {
    return {
      id: row.id,
      name: row.name,
      spec: JSON.parse(row.spec_json) as CompiledTaskSpec,
      cronSchedule: row.cron_schedule ?? undefined,
      isScheduled: Boolean(row.is_scheduled),
      status: row.status as Job['status'],
      lastRunAt: row.last_run_at ?? undefined,
      nextRunAt: row.next_run_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  public createJob(job: {
    id?: string;
    name: string;
    spec: CompiledTaskSpec;
    cronSchedule?: string;
    isScheduled?: boolean;
    status?: Job['status'];
  }): Job {
    const now = Date.now();
    const id = job.id || `job-${now}-${Math.random().toString(36).slice(2, 7)}`;
    const isScheduled = job.isScheduled ?? false;
    const status = job.status ?? (isScheduled ? 'scheduled' : 'idle');

    if (!this.db.open) {
      return {
        id,
        name: job.name,
        spec: job.spec,
        cronSchedule: job.cronSchedule,
        isScheduled,
        status,
        createdAt: now,
        updatedAt: now
      };
    }

    // Ensure task spec exists in tasks table
    this.insertTask(job.spec);

    this.insertJobStmt.run(
      id,
      job.name,
      JSON.stringify(job.spec),
      job.cronSchedule ?? null,
      isScheduled ? 1 : 0,
      status,
      null,
      null,
      now,
      now
    );

    return {
      id,
      name: job.name,
      spec: job.spec,
      cronSchedule: job.cronSchedule,
      isScheduled,
      status,
      createdAt: now,
      updatedAt: now
    };
  }

  public getJob(id: string): Job | null {
    if (!this.db.open) return null;
    const row = this.getJobStmt.get(id) as JobRow | undefined;
    if (!row) return null;
    return this.rowToJob(row);
  }

  public updateJob(
    id: string,
    updates: Partial<{
      name: string;
      spec: CompiledTaskSpec;
      cronSchedule?: string;
      isScheduled: boolean;
      status: Job['status'];
      lastRunAt?: number;
      nextRunAt?: number;
    }>
  ): Job | null {
    if (!this.db.open) return null;
    const existing = this.getJob(id);
    if (!existing) return null;

    const filteredUpdates: Record<string, any> = {};
    for (const [key, val] of Object.entries(updates)) {
      if (val !== undefined) {
        filteredUpdates[key] = val;
      }
    }

    const updatedJob: Job = {
      ...existing,
      ...filteredUpdates,
      updatedAt: Date.now()
    };

    if (filteredUpdates.spec) {
      this.insertTask(filteredUpdates.spec);
    }

    this.insertJobStmt.run(
      updatedJob.id,
      updatedJob.name,
      JSON.stringify(updatedJob.spec),
      updatedJob.cronSchedule ?? null,
      updatedJob.isScheduled ? 1 : 0,
      updatedJob.status,
      updatedJob.lastRunAt ?? null,
      updatedJob.nextRunAt ?? null,
      updatedJob.createdAt,
      updatedJob.updatedAt
    );

    return updatedJob;
  }

  public deleteJob(id: string): boolean {
    if (!this.db.open) return false;
    const result = this.deleteJobStmt.run(id);
    return result.changes > 0;
  }

  public listJobs(): Job[] {
    if (!this.db.open) return [];
    const rows = this.listJobsStmt.all() as JobRow[];
    return rows.map((r) => this.rowToJob(r));
  }

  // ===================== JobRun & Aggregation =====================

  private rowToJobRun(row: JobRunRow): JobRun {
    return {
      id: row.id,
      jobId: row.job_id,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
      status: row.status as JobRun['status'],
      totalScanned: row.total_scanned,
      totalAlerts: row.total_alerts,
      avgLatencyMs: row.avg_latency_ms,
      error: row.error ?? undefined
    };
  }

  public createRun(run: {
    id?: string;
    jobId: string;
    startedAt?: number;
    status?: JobRun['status'];
  }): JobRun {
    const now = Date.now();
    const id = run.id || `run-${now}-${Math.random().toString(36).slice(2, 7)}`;
    const startedAt = run.startedAt ?? now;
    const status = run.status ?? 'running';

    if (!this.db.open) {
      return {
        id,
        jobId: run.jobId,
        startedAt,
        status,
        totalScanned: 0,
        totalAlerts: 0,
        avgLatencyMs: 0
      };
    }

    this.insertJobRunStmt.run(
      id,
      run.jobId,
      startedAt,
      null,
      status,
      0,
      0,
      0,
      null
    );

    // Update parent job status and lastRunAt
    try {
      this.updateJob(run.jobId, { status: 'running', lastRunAt: startedAt });
    } catch {
      // Ignore if job doesn't exist
    }

    return {
      id,
      jobId: run.jobId,
      startedAt,
      status,
      totalScanned: 0,
      totalAlerts: 0,
      avgLatencyMs: 0
    };
  }

  public updateRun(
    id: string,
    updates: Partial<{
      status: JobRun['status'];
      totalScanned: number;
      totalAlerts: number;
      avgLatencyMs: number;
      completedAt?: number;
      error?: string;
    }>
  ): JobRun | null {
    const existing = this.getRun(id);
    if (!existing) return null;

    const filteredUpdates: Record<string, any> = {};
    for (const [key, val] of Object.entries(updates)) {
      if (val !== undefined) {
        filteredUpdates[key] = val;
      }
    }

    const updated: JobRun = {
      ...existing,
      ...filteredUpdates
    };

    this.insertJobRunStmt.run(
      updated.id,
      updated.jobId,
      updated.startedAt,
      updated.completedAt ?? null,
      updated.status,
      updated.totalScanned,
      updated.totalAlerts,
      updated.avgLatencyMs,
      updated.error ?? null
    );

    return updated;
  }

  public completeRun(
    id: string,
    result?: Partial<{
      status: JobRun['status'];
      totalScanned: number;
      totalAlerts: number;
      avgLatencyMs: number;
      error?: string;
    }>
  ): JobRun | null {
    if (!this.db.open) return null;
    const existing = this.getRun(id);
    if (!existing) return null;

    const now = Date.now();
    const completedStatus = result?.status ?? (result?.error ? 'failed' : 'completed');

    const completedRun: JobRun = {
      ...existing,
      ...result,
      status: completedStatus,
      completedAt: now
    };

    this.insertJobRunStmt.run(
      completedRun.id,
      completedRun.jobId,
      completedRun.startedAt,
      completedRun.completedAt ?? null,
      completedRun.status,
      completedRun.totalScanned,
      completedRun.totalAlerts,
      completedRun.avgLatencyMs,
      completedRun.error ?? null
    );

    // Update parent job status to idle or error
    try {
      this.updateJob(completedRun.jobId, {
        status: completedStatus === 'failed' ? 'error' : 'idle'
      });
    } catch {
      // Ignore
    }

    return completedRun;
  }

  public getRun(id: string): JobRun | null {
    if (!this.db.open) return null;
    const row = this.getJobRunStmt.get(id) as JobRunRow | undefined;
    if (!row) return null;
    return this.rowToJobRun(row);
  }

  public listRuns(jobId?: string): JobRun[] {
    if (!this.db.open) return [];
    const rows = (
      jobId ? this.listJobRunsByJobStmt.all(jobId) : this.listJobRunsAllStmt.all()
    ) as JobRunRow[];
    return rows.map((r) => this.rowToJobRun(r));
  }

  public getRunAggregation(runId: string): RunAggregation | null {
    if (!this.db.open) return null;
    const run = this.getRun(runId);
    if (!run) return null;

    const now = Date.now();
    const durationMs = run.completedAt
      ? Math.max(0, run.completedAt - run.startedAt)
      : Math.max(0, now - run.startedAt);

    const alertRows = this.listAlertsByRunStmt.all(runId) as AlertRow[];
    const topMatches: InferenceTelemetryItem[] = alertRows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      timestamp: row.timestamp,
      domSnippet: row.dom_snippet,
      latencyMs: row.latency_ms,
      rawAnswers: JSON.parse(row.raw_answers_json),
      triggeredAlert: Boolean(row.triggered_alert)
    }));

    return {
      runId,
      totalScanned: run.totalScanned,
      totalAlerts: run.totalAlerts,
      avgLatencyMs: run.avgLatencyMs,
      durationMs,
      topMatches
    };
  }

  /**
   * Close database connection after executing WAL checkpoint.
   */
  public close(): void {
    if (this.db.open) {
      try {
        this.db.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        // In-memory or environments without checkpointing support ignore checkpoint errors
      }
      this.db.close();
    }
  }

  /**
   * Check if connection is open.
   */
  public get isOpen(): boolean {
    return this.db.open;
  }

  /**
   * Expose internal Database instance for inspection/testing.
   */
  public get rawDb(): DatabaseType {
    return this.db;
  }
}
