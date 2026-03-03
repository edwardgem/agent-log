const mysql = require('mysql2/promise');
const { EventLogStore } = require('./event_log_store');

class MysqlEventLogStore extends EventLogStore {
  /**
   * @param {object} config - MySQL connection config
   * @param {string} config.host
   * @param {number} config.port
   * @param {string} config.database
   * @param {string} config.user
   * @param {string} config.password
   */
  constructor(config) {
    super();
    this.config = config;
    this.pool = null;
  }

  async init() {
    if (this.pool) return;
    this.pool = mysql.createPool({
      host: this.config.host || '127.0.0.1',
      port: this.config.port || 3306,
      database: this.config.database || 'amp',
      user: this.config.user || 'amp_user',
      password: this.config.password || '',
      charset: 'utf8mb4',
      connectionLimit: this.config.connectionLimit || 5,
      waitForConnections: true,
    });
    // No DDL — schema is managed by Alembic.
  }

  async appendLogEntry(entry) {
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

    await this.pool.execute(
      `INSERT INTO agent_logs
         (instance_id, service, level, message, username, event_time, created_at, org_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [instance_id, service, level, message, username, event_time, created_at, org_id || '']
    );
  }

  async queryActivityByMonth({ month, year, username, org_id }) {
    const monthIndex = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
      .indexOf(String(month).toLowerCase());
    if (monthIndex === -1) return [];
    const y = Number(year);
    if (!Number.isFinite(y)) return [];

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
      sql += ` AND org_id IN (?, '')`;
      params.push(org_id);
    }
    if (username) {
      sql += ` AND username = ?`;
      params.push(username);
    }
    sql += ` ORDER BY event_time DESC, id DESC`;

    const [rows] = await this.pool.execute(sql, params);
    return rows;
  }

  async listLogEntries(instanceId) {
    const [rows] = await this.pool.execute(
      `SELECT event_time, message, username
       FROM agent_logs
       WHERE instance_id = ?
       ORDER BY event_time ASC, id ASC`,
      [instanceId]
    );
    return rows;
  }

  async insertApprovalEvent(event) {
    const payloadSource = event.payload_json ?? event.payload ?? event;
    const payloadJson = typeof payloadSource === 'string' ? payloadSource : JSON.stringify(payloadSource);

    let simRunId = null;
    try {
      const payload = typeof payloadSource === 'string' ? JSON.parse(payloadSource) : payloadSource;
      simRunId = payload.sim_run_id || null;
    } catch (_) {
      // Ignore parse errors
    }

    const [result] = await this.pool.execute(
      `INSERT IGNORE INTO approval_events
         (event_id, org_id, agent_name, decision_point_id, event_type, created_at, sim_run_id, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
    return { inserted: result.affectedRows > 0 };
  }

  async getApprovalEventsByDecisionPoint(orgId, agentName, decisionPointId) {
    const [rows] = await this.pool.execute(
      `SELECT event_id, org_id, agent_name, decision_point_id, event_type, created_at, payload_json
       FROM approval_events
       WHERE org_id = ? AND agent_name = ? AND decision_point_id = ?
       ORDER BY created_at ASC`,
      [orgId, agentName, decisionPointId]
    );
    return rows;
  }

  async getApprovalRequestByDecisionPoint(orgId, agentName, decisionPointId) {
    const [rows] = await this.pool.execute(
      `SELECT payload_json
       FROM approval_events
       WHERE org_id = ? AND agent_name = ? AND decision_point_id = ? AND event_type = 'approval_request'
       ORDER BY created_at ASC
       LIMIT 1`,
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

    const [rows] = await this.pool.execute(sql, params);
    return rows;
  }
}

module.exports = { MysqlEventLogStore };
