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

    await run(this.db, `
      CREATE INDEX IF NOT EXISTS idx_agent_logs_instance_time
      ON agent_logs(instance_id, event_time)
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
      created_at
    } = entry;

    await run(
      this.db,
      `
        INSERT INTO agent_logs (
          instance_id, service, level, message, username, event_time, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        instance_id,
        service,
        level,
        message,
        username,
        event_time,
        created_at
      ]
    );
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

  async queryApprovalEvents({ orgId, agentName, eventType, start, end, simRunId }) {
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

    return all(this.db, sql, params);
  }
}

module.exports = { SqliteEventLogStore };
