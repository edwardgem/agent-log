const sqlite3 = require('sqlite3');
const { EventLogStore } = require('./event_log_store');

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

class SqliteEventLogStore extends EventLogStore {
  constructor(dbPath) {
    super();
    this.dbPath = dbPath;
    this.db = null;
  }

  async init() {
    if (this.db) return;
    this.db = new sqlite3.Database(this.dbPath);

    await run(this.db, `PRAGMA journal_mode = WAL`);
    await run(this.db, `PRAGMA synchronous = NORMAL`);
    await run(this.db, `PRAGMA busy_timeout = 5000`);

    await run(this.db, `
      CREATE TABLE IF NOT EXISTS agent_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id TEXT NOT NULL,
        service TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        username TEXT NOT NULL,
        event_time TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);

    // Migration: add org_id column
    try {
      await run(this.db, `ALTER TABLE agent_logs ADD COLUMN org_id TEXT NOT NULL DEFAULT ''`);
    } catch (err) {
      // Column already exists, ignore error
    }

    await run(this.db, `
      CREATE INDEX IF NOT EXISTS idx_agent_logs_instance_time
      ON agent_logs(instance_id, event_time)
    `);

    await run(this.db, `
      CREATE INDEX IF NOT EXISTS idx_agent_logs_event_time
      ON agent_logs(event_time)
    `);

    await run(this.db, `
      CREATE INDEX IF NOT EXISTS idx_agent_logs_org_instance_time
      ON agent_logs(org_id, instance_id, event_time)
    `);

    await run(this.db, `
      CREATE TABLE IF NOT EXISTS approval_events (
        event_id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        decision_point_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sim_run_id TEXT,
        payload_json TEXT NOT NULL
      )
    `);

    await run(this.db, `
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_approval_events_idempotent
      ON approval_events(org_id, agent_name, decision_point_id, event_type)
    `);

    await run(this.db, `
      CREATE INDEX IF NOT EXISTS idx_approval_events_created
      ON approval_events(org_id, agent_name, created_at)
    `);

    await run(this.db, `
      CREATE INDEX IF NOT EXISTS idx_approval_events_decision
      ON approval_events(org_id, agent_name, decision_point_id)
    `);

    await run(this.db, `
      CREATE INDEX IF NOT EXISTS idx_approval_events_type_created
      ON approval_events(org_id, agent_name, event_type, created_at)
    `);

    // Migration: Add sim_run_id column if it doesn't exist
    try {
      await run(this.db, `ALTER TABLE approval_events ADD COLUMN sim_run_id TEXT`);
    } catch (err) {
      // Column already exists, ignore error
    }

    await run(this.db, `
      CREATE INDEX IF NOT EXISTS idx_approval_events_sim_run
      ON approval_events(org_id, agent_name, sim_run_id, event_type, created_at)
    `);
  }

  async appendLogEntry(entry) {
    if (!this.db) throw new Error('Database not initialized');

    const {
      instance_id,
      service,
      level,
      message,
      username,
      event_time,
      created_at,
      org_id
    } = entry;

    await run(
      this.db,
      `
        INSERT INTO agent_logs (
          instance_id, service, level, message, username, event_time, created_at, org_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        instance_id,
        service,
        level,
        message,
        username,
        event_time,
        created_at,
        org_id || ''
      ]
    );
  }

  async queryActivityByMonth({ month, year, username, org_id }) {
    if (!this.db) throw new Error('Database not initialized');

    // Build date range for the requested month in Pacific time.
    // month is a 3-letter abbreviation (e.g. "jan"), year is a 4-digit string/number.
    const monthIndex = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
      .indexOf(String(month).toLowerCase());
    if (monthIndex === -1) return [];
    const y = Number(year);
    if (!Number.isFinite(y)) return [];

    // ISO range: first ms of month through last ms of month (in UTC).
    // We widen by 1 day on each side to account for Pacific offset.
    const startDate = new Date(Date.UTC(y, monthIndex, 1));
    startDate.setUTCDate(startDate.getUTCDate() - 1);
    const endDate = new Date(Date.UTC(y, monthIndex + 1, 1));
    endDate.setUTCDate(endDate.getUTCDate() + 1);

    const params = [startDate.toISOString(), endDate.toISOString()];
    let sql = `
      SELECT instance_id, message, username, event_time
      FROM agent_logs
      WHERE event_time >= ? AND event_time < ?
    `;
    if (org_id) {
      sql += ` AND org_id = ?`;
      params.push(org_id);
    }
    if (username) {
      sql += ` AND username = ?`;
      params.push(username);
    }
    sql += ` ORDER BY event_time DESC, id DESC`;

    return all(this.db, sql, params);
  }

  async listLogEntries(instanceId) {
    if (!this.db) throw new Error('Database not initialized');
    return all(
      this.db,
      `
        SELECT event_time, message, username
        FROM agent_logs
        WHERE instance_id = ?
        ORDER BY event_time ASC, id ASC
      `,
      [instanceId]
    );
  }

  async insertApprovalEvent(event) {
    if (!this.db) throw new Error('Database not initialized');

    const payloadSource = event.payload_json ?? event.payload ?? event;
    const payloadJson = typeof payloadSource === 'string' ? payloadSource : JSON.stringify(payloadSource);

    // Extract sim_run_id from payload
    let simRunId = null;
    try {
      const payload = typeof payloadSource === 'string' ? JSON.parse(payloadSource) : payloadSource;
      simRunId = payload.sim_run_id || null;
    } catch (_) {
      // Ignore parse errors
    }

    const result = await run(
      this.db,
      `
        INSERT OR IGNORE INTO approval_events (
          event_id, org_id, agent_name, decision_point_id, event_type, created_at, sim_run_id, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        event.event_id,
        event.org_id,
        event.agent_name,
        event.decision_point_id,
        event.event_type,
        event.created_at,
        simRunId,
        payloadJson
      ]
    );
    return { inserted: Boolean(result && result.changes) };
  }

  async getApprovalEventsByDecisionPoint(orgId, agentName, decisionPointId) {
    if (!this.db) throw new Error('Database not initialized');

    return all(
      this.db,
      `
        SELECT event_id, org_id, agent_name, decision_point_id, event_type, created_at, payload_json
        FROM approval_events
        WHERE org_id = ? AND agent_name = ? AND decision_point_id = ?
        ORDER BY created_at ASC
      `,
      [orgId, agentName, decisionPointId]
    );
  }

  async getApprovalRequestByDecisionPoint(orgId, agentName, decisionPointId) {
    if (!this.db) throw new Error('Database not initialized');

    const rows = await all(
      this.db,
      `
        SELECT payload_json
        FROM approval_events
        WHERE org_id = ? AND agent_name = ? AND decision_point_id = ? AND event_type = 'approval_request'
        ORDER BY created_at ASC
        LIMIT 1
      `,
      [orgId, agentName, decisionPointId]
    );

    if (!rows.length) return null;
    try {
      return JSON.parse(rows[0].payload_json);
    } catch (_) {
      return null;
    }
  }

  async queryApprovalEvents({ orgId, agentName, eventType, start, end, simRunId, limit, offset }) {
    if (!this.db) throw new Error('Database not initialized');

    const params = [orgId, agentName];
    let sql = `
      SELECT event_id, org_id, agent_name, decision_point_id, event_type, created_at, payload_json
      FROM approval_events
      WHERE org_id = ? AND agent_name = ?
    `;
    if (simRunId) {
      sql += ` AND sim_run_id = ?`;
      params.push(simRunId);
    }
    if (start) {
      sql += ` AND created_at >= ?`;
      params.push(start);
    }
    if (end) {
      sql += ` AND created_at <= ?`;
      params.push(end);
    }
    if (eventType) {
      sql += ` AND event_type = ?`;
      params.push(eventType);
    }
    sql += ` ORDER BY created_at ASC, event_id ASC`;
    if (typeof limit === 'number') {
      sql += ` LIMIT ?`;
      params.push(limit);
      if (typeof offset === 'number' && offset > 0) {
        sql += ` OFFSET ?`;
        params.push(offset);
      }
    }

    return all(this.db, sql, params);
  }
}

module.exports = { SqliteEventLogStore };
