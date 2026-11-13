import { EventEmitter } from 'node:events';
import type { Job } from '@ofln-scout/shared';
import type { ScoutDatabase } from './db.js';

/**
 * Parses a single cron field with support for *, step (e.g. *\/5), range (e.g. 1-5), and comma lists (e.g. 1,3,5).
 */
export function parseCronField(field: string, min: number, max: number): number[] {
  if (field === '*') {
    const res: number[] = [];
    for (let i = min; i <= max; i++) res.push(i);
    return res;
  }

  const values = new Set<number>();
  const parts = field.split(',');

  for (const part of parts) {
    if (part.startsWith('*/')) {
      const step = parseInt(part.slice(2), 10);
      if (!isNaN(step) && step > 0) {
        for (let i = min; i <= max; i += step) values.add(i);
      }
    } else if (part.includes('-')) {
      let step = 1;
      let rangePart = part;
      if (part.includes('/')) {
        const [r, s] = part.split('/');
        rangePart = r;
        step = parseInt(s, 10) || 1;
      }
      const [startStr, endStr] = rangePart.split('-');
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (!isNaN(start) && !isNaN(end) && step > 0) {
        for (let i = Math.max(min, start); i <= Math.min(max, end); i += step) {
          values.add(i);
        }
      }
    } else if (part.includes('/')) {
      const [startStr, stepStr] = part.split('/');
      const start = parseInt(startStr, 10);
      const step = parseInt(stepStr, 10);
      if (!isNaN(start) && !isNaN(step) && step > 0) {
        for (let i = Math.max(min, start); i <= max; i += step) {
          values.add(i);
        }
      }
    } else {
      const num = parseInt(part, 10);
      if (!isNaN(num) && num >= min && num <= max) {
        values.add(num);
      }
    }
  }

  return Array.from(values).sort((a, b) => a - b);
}

/**
 * Checks if a given Date matches a standard 5-part cron expression:
 * [minute: 0-59] [hour: 0-23] [day_of_month: 1-31] [month: 1-12] [day_of_week: 0-7]
 */
export function matchesCron(expression: string, date: Date): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const [minPart, hourPart, domPart, monthPart, dowPart] = parts;
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const month = date.getMonth() + 1; // 1-12
  const dow = date.getDay(); // 0-6 (0=Sun, 6=Sat)

  const allowedMinutes = parseCronField(minPart, 0, 59);
  if (!allowedMinutes.includes(minute)) return false;

  const allowedHours = parseCronField(hourPart, 0, 23);
  if (!allowedHours.includes(hour)) return false;

  const allowedDom = parseCronField(domPart, 1, 31);
  if (!allowedDom.includes(dom)) return false;

  const allowedMonth = parseCronField(monthPart, 1, 12);
  if (!allowedMonth.includes(month)) return false;

  const allowedDow = parseCronField(dowPart, 0, 7); // 0 or 7 = Sunday
  const matchesDow = allowedDow.includes(dow) || (dow === 0 && allowedDow.includes(7));
  if (!matchesDow) return false;

  return true;
}

/**
 * Calculates the next execution timestamp (in ms) from a cron expression or interval format.
 */
export function calculateNextRun(cronSchedule: string, fromDate = new Date()): number {
  const schedule = cronSchedule.trim();

  // Interval formats: "@every 30s", "@every 5m", "every 10s"
  if (schedule.startsWith('@every ') || schedule.startsWith('every ')) {
    const raw = schedule.replace(/^@?every\s+/, '').trim();
    if (raw.endsWith('s')) {
      const sec = parseFloat(raw);
      if (!isNaN(sec) && sec > 0) return fromDate.getTime() + sec * 1000;
    }
    if (raw.endsWith('m')) {
      const min = parseFloat(raw);
      if (!isNaN(min) && min > 0) return fromDate.getTime() + min * 60 * 1000;
    }
    if (raw.endsWith('h')) {
      const hr = parseFloat(raw);
      if (!isNaN(hr) && hr > 0) return fromDate.getTime() + hr * 3600 * 1000;
    }
  }

  // Interval in milliseconds format: "interval:60000"
  if (schedule.startsWith('interval:')) {
    const ms = parseInt(schedule.slice(9), 10);
    if (!isNaN(ms) && ms > 0) return fromDate.getTime() + ms;
  }

  // Pre-defined cron shortcuts
  if (schedule === '@hourly') return fromDate.getTime() + 3600 * 1000;
  if (schedule === '@daily') return fromDate.getTime() + 86400 * 1000;

  // Standard 5-field cron parsing
  const parts = schedule.split(/\s+/);
  if (parts.length === 5) {
    const allowedMinutes = parseCronField(parts[0], 0, 59);
    const allowedHours = parseCronField(parts[1], 0, 23);
    const allowedDom = parseCronField(parts[2], 1, 31);
    const allowedMonth = parseCronField(parts[3], 1, 12);
    const allowedDow = parseCronField(parts[4], 0, 7);

    // Fast fallback if any cron field is empty or unparseable
    if (
      allowedMinutes.length === 0 ||
      allowedHours.length === 0 ||
      allowedDom.length === 0 ||
      allowedMonth.length === 0 ||
      allowedDow.length === 0
    ) {
      return fromDate.getTime() + 3600000;
    }

    const checkDate = new Date(Math.floor(fromDate.getTime() / 60000) * 60000 + 60000);

    const limitMs = fromDate.getTime() + 366 * 24 * 3600 * 1000;
    while (checkDate.getTime() <= limitMs) {
      const month = checkDate.getMonth() + 1;
      if (!allowedMonth.includes(month)) {
        checkDate.setDate(1);
        checkDate.setHours(0, 0, 0, 0);
        checkDate.setMonth(checkDate.getMonth() + 1);
        continue;
      }

      const dom = checkDate.getDate();
      if (!allowedDom.includes(dom)) {
        checkDate.setDate(checkDate.getDate() + 1);
        checkDate.setHours(0, 0, 0, 0);
        continue;
      }

      const dow = checkDate.getDay();
      const matchesDow = allowedDow.includes(dow) || (dow === 0 && allowedDow.includes(7));
      if (!matchesDow) {
        checkDate.setDate(checkDate.getDate() + 1);
        checkDate.setHours(0, 0, 0, 0);
        continue;
      }

      const hour = checkDate.getHours();
      if (!allowedHours.includes(hour)) {
        checkDate.setHours(checkDate.getHours() + 1, 0, 0, 0);
        continue;
      }

      const minute = checkDate.getMinutes();
      if (!allowedMinutes.includes(minute)) {
        checkDate.setTime(checkDate.getTime() + 60000);
        continue;
      }

      return checkDate.getTime();
    }
  }

  // Fallback to 1 hour from now if no match found
  return fromDate.getTime() + 3600000;
}

export interface JobSchedulerOptions {
  db?: ScoutDatabase;
  onTriggerJob?: (job: Job) => Promise<void>;
  checkIntervalMs?: number;
}

export class JobScheduler extends EventEmitter {
  private db?: ScoutDatabase;
  private onTriggerJob?: (job: Job) => Promise<void>;
  private checkIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private runningJobs = new Set<string>();
  private isStarted = false;

  constructor(options: JobSchedulerOptions = {}) {
    super();
    this.db = options.db;
    this.onTriggerJob = options.onTriggerJob;
    this.checkIntervalMs = options.checkIntervalMs ?? 1000;
  }

  public setDatabase(db: ScoutDatabase): void {
    this.db = db;
  }

  public setTriggerHandler(handler: (job: Job) => Promise<void>): void {
    this.onTriggerJob = handler;
  }

  /**
   * Start the scheduler check loop.
   */
  public start(): void {
    if (this.isStarted) return;
    this.isStarted = true;

    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        this.emit('error', err);
      });
    }, this.checkIntervalMs);
  }

  /**
   * Stop the scheduler loop.
   */
  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isStarted = false;
  }

  /**
   * Check all scheduled jobs in the database.
   */
  public async tick(): Promise<void> {
    if (!this.db || !this.db.isOpen) return;

    const jobs = this.db.listJobs();
    const now = Date.now();

    for (const job of jobs) {
      if (!job.isScheduled || !job.cronSchedule) {
        continue;
      }

      // If nextRunAt is not yet computed, compute and persist
      if (!job.nextRunAt) {
        const next = calculateNextRun(job.cronSchedule, new Date(now));
        this.db.updateJob(job.id, { nextRunAt: next });
        continue;
      }

      // If scheduled time has arrived
      if (now >= job.nextRunAt) {
        // Concurrency guard: skip if already running
        if (this.runningJobs.has(job.id)) {
          this.emit('job_skipped', {
            jobId: job.id,
            reason: 'Job is already actively executing'
          });
          continue;
        }

        // Calculate and save the next execution time
        const nextRun = calculateNextRun(job.cronSchedule, new Date(now));
        this.db.updateJob(job.id, { nextRunAt: nextRun });

        // Trigger execution asynchronously
        this.triggerJob(job.id).catch((err) => {
          this.emit('job_error', { jobId: job.id, error: err.message });
        });
      }
    }
  }

  /**
   * Trigger a job execution manually or via scheduler tick with concurrency guard.
   */
  public async triggerJob(jobId: string): Promise<boolean> {
    if (this.runningJobs.has(jobId)) {
      this.emit('job_skipped', {
        jobId,
        reason: 'Job is already actively running (concurrency guard)'
      });
      return false;
    }

    if (!this.db || !this.db.isOpen) {
      return false;
    }

    const job = this.db.getJob(jobId);
    if (!job) {
      return false;
    }

    this.runningJobs.add(jobId);
    this.emit('job_started', { jobId });

    try {
      if (this.onTriggerJob) {
        await this.onTriggerJob(job);
      }
      this.emit('job_completed', { jobId });
      return true;
    } catch (err: any) {
      this.emit('job_failed', { jobId, error: err.message });
      throw err;
    } finally {
      this.runningJobs.delete(jobId);
    }
  }

  /**
   * Check if a job is currently executing.
   */
  public isJobRunning(jobId: string): boolean {
    return this.runningJobs.has(jobId);
  }

  /**
   * Count of currently running jobs.
   */
  public get activeJobsCount(): number {
    return this.runningJobs.size;
  }

  /**
   * List of active job IDs.
   */
  public get activeJobIds(): string[] {
    return Array.from(this.runningJobs);
  }
}
