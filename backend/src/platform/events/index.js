const db = require('../db/db');
const { validate } = require('../../shared/contracts/validator');

/**
 * Event Outbox Service
 * Implements the transactional outbox pattern for reliable event delivery.
 */
const events = {
  /**
   * Appends an event to the outbox within a transaction.
   * @param {Object} tx - The SQLite transaction object.
   * @param {string} userId - The user associated with the event.
   * @param {string} type - The event type (e.g., 'TRANSACTION_CATEGORIZED').
   * @param {Object} payload - The event data.
   * @returns {Promise<string>} The event ID.
   */
  async append(tx, userId, type, payload) {
    // Basic validation for Event@1 structure
    // In a full implementation, we'd use a specific Event schema via validator.validate
    if (!userId || !type || !payload) {
      throw new Error('Missing required event fields: userId, type, or payload');
    }

    const eventId = `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    await tx.run(
      `INSERT INTO outbox_events (event_id, type, user_id, occurred_at, payload_json)
       VALUES (?, ?, ?, datetime('now'), ?)`,
      [eventId, type, userId, JSON.stringify(payload)]
    );

    return eventId;
  },

  /**
   * Registers a handler for a specific event type.
   * @param {string} type - The event type to subscribe to.
   * @param {string} handlerName - Unique name for the handler (used for idempotency).
   * @param {Function} fn - The async handler function.
   */
  subscribe(type, handlerName, fn) {
    if (!this._subscribers) {
      this._subscribers = {};
    }
    if (!this._subscribers[type]) {
      this._subscribers[type] = [];
    }
    this._subscribers[type].push({ handlerName, fn });
  },

  /**
   * Dispatches undelivered events to their subscribers.
   * Used by the background loop.
   */
  async drainOnce() {
    const undelivered = await db.all(
      `SELECT * FROM outbox_events
       WHERE event_id NOT IN (SELECT event_id FROM event_deliveries WHERE status = 'DONE')
       AND (event_id NOT IN (SELECT event_id FROM event_deliveries WHERE status = 'DEAD'))
       LIMIT 100`
    );

    let deliveredCount = 0;
    let failedCount = 0;

    for (const event of undelivered) {
      const handlers = this._subscribers?.[event.type] || [];

      for (const { handlerName, fn } of handlers) {
        try {
          // Idempotency check: check if this handler already finished this event
          const existing = await db.get(
            `SELECT status FROM event_deliveries WHERE event_id = ? AND handler = ?`,
            [event.event_id, handlerName]
          );

          if (existing?.status === 'DONE') continue;

          await fn(JSON.parse(event.payload_json));

          await db.run(
            `INSERT INTO event_deliveries (event_id, handler, status, attempts, last_error)
             VALUES (?, ?, 'DONE', 1, NULL)
             ON CONFLICT(event_id, handler) DO UPDATE SET status='DONE', attempts=attempts+1`,
            [event.event_id, handlerName]
          );
          deliveredCount++;
        } catch (err) {
          // Retry logic: 1s, 5s, 30s
          const attempts = (await db.get(
            `SELECT attempts FROM event_deliveries WHERE event_id = ? AND handler = ?`,
            [event.event_id, handlerName]
          ))?.attempts || 0;

          const newAttempts = attempts + 1;
          let status = 'FAILED';
          let nextAttemptAt = null;

          if (newAttempts >= 3) {
            status = 'DEAD';
          } else {
            const delays = [1, 5, 30];
            const delay = delays[attempts] || 30;
            nextAttemptAt = `datetime('now', '+${delay} seconds')`;
          }

          await db.run(
            `INSERT INTO event_deliveries (event_id, handler, status, attempts, last_error, next_attempt_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(event_id, handler) DO UPDATE SET
               status=excluded.status,
               attempts=excluded.attempts,
               last_error=excluded.last_error,
               next_attempt_at=excluded.next_attempt_at`,
            [event.event_id, handlerName, status, newAttempts, err.message, nextAttemptAt]
          );
          failedCount++;
        }
      }
    }

    return { delivered: deliveredCount, failed: failedCount };
  },

  startDispatcher(intervalMs = 250) {
    if (this._timer) return;
    this._timer = setInterval(() => this.drainOnce().catch(console.error), intervalMs);
  },

  stopDispatcher() {
    clearInterval(this._timer);
    this._timer = null;
  }
};

module.exports = events;
