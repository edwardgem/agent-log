
const express = require('express');
const fs = require('fs');
const path = require('path');
const lockfile = require('proper-lockfile');
const http = require('http');
const { SqliteEventLogStore } = require('./store/sqlite_event_log_store');

// Lightweight .env loader (avoids extra dependency). Load local .env then
// fall back to backend/.env so both services can share the trigger secret.
function loadEnvFile(envPath) {
  try {
    if (!envPath || !fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) continue;
      const key = line.slice(0, eqIdx).trim();
      if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue;
      const value = line.slice(eqIdx + 1).trim();
      process.env[key] = value;
    }
  } catch (err) {
    console.warn(`Failed to load env file at ${envPath}:`, err.message);
  }
}

const localEnvPath = path.join(__dirname, '.env');
const backendEnvPath = path.join(__dirname, '..', 'amp-backend', '.env');
loadEnvFile(localEnvPath);
loadEnvFile(backendEnvPath);

const app = express();
const PORT = process.env.PORT || 4000;
const PACIFIC_TZ = 'America/Los_Angeles';

const PACIFIC_MONTH_YEAR_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: PACIFIC_TZ,
  month: 'short',
  year: 'numeric'
});

function getPacificMonthYear(date) {
  const parts = PACIFIC_MONTH_YEAR_FORMATTER.formatToParts(date);
  const lookup = (type) => {
    const part = parts.find(p => p.type === type);
    return part ? part.value : '';
  };

  const month = lookup('month').toLowerCase();
  const year = lookup('year');

  return { month, year };
}

// Debounce mechanism
let debounceBuffer = [];
let debounceTimer = null;
const DEBOUNCE_DELAY = 1000; // 1 second
const MAX_BUFFER_SIZE = 5;

// Load log_dir from config.json
let config = { log_dir: 'logs', log_jsonl_debug: false, log_agent_secret: '' };
try {
  const raw = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8');
  config = { ...config, ...JSON.parse(raw) };
} catch (e) {
  // Use default if config.json missing or invalid
}
const LOG_DIR = path.isAbsolute(config.log_dir) ? config.log_dir : path.join(__dirname, config.log_dir);
const LOG_JSONL_DEBUG = process.env.LOG_JSONL_DEBUG === '1' || config.log_jsonl_debug === true;
const DB_PATH = process.env.LOG_DB_PATH || config.db_path || path.join(LOG_DIR, 'agent-log.sqlite');
const LOG_AGENT_SECRET = process.env.LOG_AGENT_SECRET || config.log_agent_secret || '';
const NODE_ENV = process.env.NODE_ENV || config.node_env || 'development';
const AMP_ENV = process.env.AMP_ENV || '';
const isProduction = ['production'].includes(String(NODE_ENV).toLowerCase())
  || ['production'].includes(String(AMP_ENV).toLowerCase());
const REQUIRE_AUTH = process.env.LOG_AGENT_REQUIRE_AUTH === '1' || isProduction;
const BODY_LIMIT = process.env.BODY_LIMIT || config.body_limit || '64kb';
const eventLogStore = new SqliteEventLogStore(DB_PATH);

if (isProduction && !LOG_AGENT_SECRET) {
  console.error('[FATAL] log-agent requires LOG_AGENT_SECRET in production.');
  process.exit(1);
}

// Function to call AMP refresh API
function triggerAmpRefresh() {
  const postData = JSON.stringify({});
  const options = {
    hostname: 'localhost',
    port: 5000,
    path: '/api/amp/trigger-refresh',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  const triggerSecret = process.env.AMP_TRIGGER_SECRET;
  if (triggerSecret) {
    options.headers['X-AMP-Trigger-Key'] = triggerSecret;
  }

  const req = http.request(options, (res) => {
    // Success - no need to log anything
  });

  req.on('error', (err) => {
    console.error(`AMP refresh API error: ${err.message}`);
  });

  req.write(postData);
  req.end();
}

// Function to flush debounced log entries
async function flushLogBuffer() {
  if (!LOG_JSONL_DEBUG) return;
  console.log('[DEBUG] flushLogBuffer called, buffer length:', debounceBuffer.length);
  if (debounceBuffer.length === 0) return;

  const entries = [...debounceBuffer];
  const logFilePath = entries[0].logFilePath; // All entries should have same file path
  const logText = entries.map(entry => entry.line).join('');
  console.log(`[DEBUG] Flushing ${entries.length} entries to: ${logFilePath}`);

  debounceBuffer = [];
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  try {
    // Ensure file exists before locking
    if (!fs.existsSync(logFilePath)) {
      console.log('[DEBUG] Creating new log file:', logFilePath);
      fs.writeFileSync(logFilePath, '');
    }
    console.log('[DEBUG] Acquiring file lock...');
    const release = await lockfile.lock(logFilePath, { retries: 5, realpath: false });
    console.log('[DEBUG] Lock acquired, writing log text');
    fs.appendFileSync(logFilePath, logText);
    console.log('[DEBUG] Log written, releasing lock');
    await release();
    console.log('[DEBUG] Lock released');
    console.log('[DEBUG] Flush completed successfully');
  } catch (err) {
    console.error(`[ERROR] Failed to write log (debounced):`, err);
    console.error('[ERROR] Stack:', err.stack);
  }
}

app.use(express.json({ limit: BODY_LIMIT }));
// Optional: custom error response for payload too large
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload too large', limit: BODY_LIMIT });
  }
  return next(err);
});

function requireLogAgentAuth(req, res) {
  if (!REQUIRE_AUTH) return false;
  if (!LOG_AGENT_SECRET) {
    res.status(500).json({ error: 'log_agent_secret_missing' });
    return true;
  }
  const provided = req.headers['x-amp-internal-key'];
  if (!provided || provided !== LOG_AGENT_SECRET) {
    res.status(401).json({ error: 'invalid_log_agent_key' });
    return true;
  }
  return false;
}

// Ensure log directory exists (sync is fine during startup)
fs.mkdirSync(LOG_DIR, { recursive: true });

app.post('/api/log', async (req, res) => {
  console.log('[DEBUG] /api/log received request');
  console.log('[DEBUG] Request body:', JSON.stringify(req.body, null, 2));

  const { service, level = 'info', message, timestamp, instance_id, username } = req.body;
  // Sanitize helper first so we can validate instance_id after trimming
  const clean = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim();

  // Validate required fields including top-level instance_id and username
  const instanceId = clean(instance_id);
  const userName = clean(username);
  console.log('[DEBUG] Parsed fields:', { service, level, instanceId, userName, hasMessage: !!message });

  if (!service || !message || !instanceId || !userName) {
    console.error('[ERROR] Missing required fields:', { service: !!service, message: !!message, instanceId: !!instanceId, userName: !!userName });
    return res.status(400).json({ error: 'Missing required fields: service, message, instance_id, username' });
  }
  const dateObj = timestamp ? new Date(timestamp) : new Date();
  const isValidDate = !isNaN(dateObj.getTime());
  const safeDate = isValidDate ? dateObj : new Date();
  const eventTime = isValidDate ? safeDate.toISOString() : new Date().toISOString();

  // Sanitize inputs to keep one-line logs
  const cleanMessage = clean(message);

  try {
    await eventLogStore.appendLogEntry({
      instance_id: instanceId,
      service,
      level,
      message: cleanMessage,
      username: userName,
      event_time: eventTime,
      created_at: new Date().toISOString()
    });
  } catch (err) {
    console.error('[ERROR] Failed to write log entry to SQLite:', err);
    return res.status(500).json({ error: 'log_write_failed' });
  }

  if (LOG_JSONL_DEBUG) {
    const monthNames = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const { month: pacificMonth, year: pacificYear } = getPacificMonthYear(safeDate);
    const mmm = pacificMonth || monthNames[safeDate.getMonth()];
    const yyyy = pacificYear || String(safeDate.getFullYear());
    const logFileName = `amp-${mmm}-${yyyy}.jsonl`;
    const logFilePath = path.join(LOG_DIR, logFileName);

    const debugEntry = {
      ts: eventTime,
      service,
      level,
      message: cleanMessage,
      instance_id: instanceId,
      username: userName
    };
    const line = `${JSON.stringify(debugEntry)}\n`;
    debounceBuffer.push({ logFilePath, line });
    console.log(`[DEBUG] Debug buffer size: ${debounceBuffer.length}/${MAX_BUFFER_SIZE}`);

    if (debounceBuffer.length >= MAX_BUFFER_SIZE) {
      console.log('[DEBUG] Debug buffer full, flushing immediately');
      await flushLogBuffer();
    } else {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      console.log(`[DEBUG] Starting debug debounce timer (${DEBOUNCE_DELAY}ms)`);
      debounceTimer = setTimeout(flushLogBuffer, DEBOUNCE_DELAY);
    }
  }

  triggerAmpRefresh();
  console.log('[DEBUG] Responding with ok: true');
  res.json({ ok: true });
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// GET /api/log/progress-all?instance_id=...
// Returns all log records for a given instance_id from SQLite
function formatPacificTimestamp(input) {
  if (!input) return 'unknown';
  let date;
  try {
    date = typeof input === 'string' ? new Date(input) : input;
  } catch (_) {
    return String(input);
  }
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return typeof input === 'string' && input.trim() ? input : 'unknown';
  }
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const valueOf = (type) => {
    const part = parts.find((p) => p.type === type);
    return part ? part.value : '';
  };
  return `${valueOf('year')}-${valueOf('month')}-${valueOf('day')} ${valueOf('hour')}:${valueOf('minute')}:${valueOf('second')}`;
}

function serializeEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => {
    const ts = formatPacificTimestamp(entry.event_time || entry.ts || entry.raw_ts || entry.raw);
    const message = entry.message || '';
    return [ts, message];
  });
}

async function collectLogEntries(instanceId, filterFn) {
  const entries = await eventLogStore.listLogEntries(instanceId);
  if (!filterFn) return entries;
  return entries.filter(filterFn);
}

app.get('/api/log/progress-all', async (req, res) => {
  const instanceId = String(req.query.instance_id || req.query.id || '').trim();
  if (!instanceId) {
    return res.status(400).json({ error: 'instance_id_required' });
  }

  try {
    await flushLogBuffer();
    const entries = await collectLogEntries(instanceId);
    return res.json({ instance_id: instanceId, progress: serializeEntries(entries) });
  } catch (e) {
    console.error('[ERROR] progress-all failed:', e.message || e);
    return res.status(500).json({ error: 'progress_all_failed', detail: e && e.message ? e.message : String(e) });
  }
});

app.get('/api/log/hitl-progress', async (req, res) => {
  const instanceId = String(req.query.instance_id || req.query.id || '').trim();
  if (!instanceId) {
    return res.status(400).json({ error: 'instance_id_required' });
  }

  try {
    await flushLogBuffer();
    const entries = await collectLogEntries(instanceId, (entry) => {
      const msg = String(entry.message || '').trim();
      const upper = msg.toUpperCase();
      return upper.startsWith('[HITL]') || upper.startsWith('[HITL-PROGRESS]');
    });
    return res.json({ instance_id: instanceId, progress: serializeEntries(entries) });
  } catch (e) {
    console.error('[ERROR] hitl-progress failed:', e.message || e);
    return res.status(500).json({ error: 'hitl_progress_failed', detail: e && e.message ? e.message : String(e) });
  }
});

app.post('/api/rlhf/events/append', async (req, res) => {
  if (requireLogAgentAuth(req, res)) return;
  const event = req.body || {};
  const required = ['event_id', 'org_id', 'agent_name', 'decision_point_id', 'event_type', 'created_at'];
  for (const key of required) {
    if (!event[key]) {
      return res.status(400).json({ error: 'missing_required_field', field: key });
    }
  }
  const orgId = String(event.org_id || '').trim();
  const agentName = String(event.agent_name || '').trim();
  if (!orgId) {
    return res.status(400).json({ error: 'missing_required_field', field: 'org_id' });
  }
  if (!agentName) {
    return res.status(400).json({ error: 'missing_required_field', field: 'agent_name' });
  }
  if (!['approval_request', 'approval_outcome'].includes(event.event_type)) {
    return res.status(400).json({ error: 'invalid_event_type' });
  }
  try {
    const result = await eventLogStore.insertApprovalEvent(event);
    return res.json({ ok: true, inserted: result.inserted });
  } catch (e) {
    console.error('[ERROR] Failed to append RLHF event:', e.message || e);
    return res.status(500).json({ error: 'event_append_failed' });
  }
});

app.get('/api/rlhf/events/request', async (req, res) => {
  if (requireLogAgentAuth(req, res)) return;
  const orgId = String(req.query.org_id || '').trim();
  const agentName = String(req.query.agent_name || '').trim();
  const decisionPointId = String(req.query.decision_point_id || '').trim();
  if (!orgId || !agentName || !decisionPointId) {
    return res.status(400).json({ error: 'missing_required_field' });
  }
  try {
    const payload = await eventLogStore.getApprovalRequestByDecisionPoint(orgId, agentName, decisionPointId);
    if (!payload) {
      return res.status(404).json({ error: 'not_found' });
    }
    return res.json({ ok: true, event: payload });
  } catch (e) {
    console.error('[ERROR] Failed to fetch approval_request:', e.message || e);
    return res.status(500).json({ error: 'event_fetch_failed' });
  }
});

app.get('/api/rlhf/events/query', async (req, res) => {
  if (requireLogAgentAuth(req, res)) return;
  const orgId = String(req.query.org_id || '').trim();
  const agentName = String(req.query.agent_name || '').trim();
  const eventType = String(req.query.event_type || '').trim();
  const start = String(req.query.start || '').trim();
  const end = String(req.query.end || '').trim();
  if (!orgId || !agentName || !start || !end) {
    return res.status(400).json({ error: 'missing_required_field' });
  }
  if (eventType && !['approval_request', 'approval_outcome'].includes(eventType)) {
    return res.status(400).json({ error: 'invalid_event_type' });
  }
  try {
    const events = await eventLogStore.queryApprovalEvents({
      orgId,
      agentName,
      eventType: eventType || null,
      start,
      end
    });
    return res.json({ ok: true, events });
  } catch (e) {
    console.error('[ERROR] Failed to query approval events:', e.message || e);
    return res.status(500).json({ error: 'event_query_failed' });
  }
});

async function startServer() {
  try {
    await eventLogStore.init();
  } catch (err) {
    console.error('[ERROR] Failed to initialize SQLite store:', err);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`Agent Log REST service listening on http://localhost:${PORT}`);
  });
}

startServer();
