const db = require('../db/db');

/**
 * Background Job Service
 * Handles scheduled and deferred tasks with concurrency control.
 */
const jobs = {
  /**
   * Enqueues a new job.
   */
  async enqueueJob(kind, { userId, runAt, payload }) {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    await db.run(
      `INSERT INTO jobs (job_id, kind, user_id, run_at, payload_json, status)
       VALUES (?, ?, ?, ?, ?, 'PENDING')`,
      [jobId, kind, userId, runAt || 'now', JSON.stringify(payload)]
    );
    return jobId;
  },

  /**
   * Registers a handler for a job kind.
   */
  subscribe(kind, fn) {
    if (!this._handlers) this._handlers = {};
    this._handlers[kind] = fn;
  },

  /**
   * Processes due jobs with pessimistic locking.
   */
  async processJobs() {
    const dueJobs = await db.all(
      `SELECT * FROM jobs
       WHERE status = 'PENDING'
       AND (run_at <= 'now' OR run_at = 'now')
       AND (locked_until IS NULL OR locked_until < datetime('now'))
       LIMIT 10`
    );

    for (const job of dueJobs) {
      // Lock the job
      await db.run(
        `UPDATE jobs SET locked_until = datetime('now', '+5 minutes')
         WHERE job_id = ? AND (locked_until IS NULL OR locked_until < datetime('now'))`,
        [job.job_id]
      );

      const handler = this._handlers[job.kind];
      if (!handler) {
        await db.run(`UPDATE jobs SET status = 'FAILED', last_error = 'No handler registered' WHERE job_id = ?`, [job.job_id]);
        continue;
      }

      try {
        await handler(JSON.parse(job.payload_json));
        await db.run(`UPDATE jobs SET status = 'DONE' WHERE job_id = ?`, [job.job_id]);
      } catch (err) {
        const attempts = (job.attempts || 0) + 1;
        if (attempts >= 3) {
          await db.run(
            `INSERT INTO jobs_dead_letter (job_id, kind, payload_json, last_error, failed_at)
             VALUES (?, ?, ?, ?, datetime('now'))`,
            [job.job_id, job.kind, job.payload_json, err.message]
          );
          await db.run(`UPDATE jobs SET status = 'DEAD' WHERE job_id = ?`, [job.job_id]);
        } else {
          await db.run(
            `UPDATE jobs SET attempts = ?, locked_until = datetime('now', '+1 minute') WHERE job_id = ?`,
            [attempts, job.job_id]
          );
        }
      }
    }
  },

  /**
   * Schedules a job to run daily at a specific time in IST.
   * @param {string} time - 'HH:MM' format.
   * @param {string} tz - Defaults to 'Asia/Kolkata'.
   */
  async scheduleDaily(kind, time, tz = 'Asia/Kolkata') {
    // Simplified: calculate next run time in IST and insert as a job
    // In production, this would be a recurring system job that re-schedules itself
    const now = new Date();
    const [hours, minutes] = time.split(':').map(Number);
    const runDate = new Date(now);
    runDate.setHours(hours, minutes, 0, 0);

    if (runDate < now) {
      runDate.setDate(runDate.getDate() + 1);
    }

    return this.enqueueJob(kind, {
      userId: 'SYSTEM',
      runAt: runDate.toISOString(),
      payload: { scheduledTime: time }
    });
  }
};

module.exports = jobs;
