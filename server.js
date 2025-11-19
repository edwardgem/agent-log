
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const lockfile = require('proper-lockfile');
const http = require('http');

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

// Reusable formatters so we only instantiate Intl.DateTimeFormat once.
const PACIFIC_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: PACIFIC_TZ,
  weekday: 'short',
  month: 'short',
  day: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZoneName: 'short'
});

const PACIFIC_MONTH_YEAR_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: PACIFIC_TZ,
  month: 'short',
  year: 'numeric'
});

function formatPacificTimestamp(date) {
  const parts = PACIFIC_TIMESTAMP_FORMATTER.formatToParts(date);
  const lookup = (type) => {
    const part = parts.find(p => p.type === type);
    return part ? part.value : '';
  };

  const dayName = lookup('weekday');
  const monthName = lookup('month');
  const day = lookup('day');
  const hour = lookup('hour');
  const minute = lookup('minute');
  const second = lookup('second');
  const year = lookup('year') || String(date.getUTCFullYear());
  const timeZoneName = (lookup('timeZoneName') || 'PT').replace(/\s+/g, '');

  return `${dayName} ${monthName} ${day} ${hour}:${minute}:${second} ${timeZoneName} ${year}`;
}

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
let config = { log_dir: 'logs' };
try {
  const raw = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8');
  config = { ...config, ...JSON.parse(raw) };
} catch (e) {
  // Use default if config.json missing or invalid
}
const LOG_DIR = path.isAbsolute(config.log_dir) ? config.log_dir : path.join(__dirname, config.log_dir);
const BODY_LIMIT = process.env.BODY_LIMIT || config.body_limit || '64kb';

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
    console.log('[DEBUG] Lock released, triggering AMP refresh');

    // Trigger AMP refresh after successful write
    triggerAmpRefresh();
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
  // Determine log file name: amp-mmm-yyyy.log
  const dateObj = timestamp ? new Date(timestamp) : new Date();
  const isValidDate = !isNaN(dateObj.getTime());
  const safeDate = isValidDate ? dateObj : new Date();
  const monthNames = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const { month: pacificMonth, year: pacificYear } = getPacificMonthYear(safeDate);
  const mmm = pacificMonth || monthNames[safeDate.getMonth()];
  const yyyy = pacificYear || String(safeDate.getFullYear());
  const logFileName = `amp-${mmm}-${yyyy}.log`;
  const logFilePath = path.join(LOG_DIR, logFileName);

  console.log(`[DEBUG] Log file: ${logFilePath}`);

  // Format: 'Mon Sep 08 15:26:27 PDT 2025: [instance-Id] message'
  const dateStr = formatPacificTimestamp(safeDate);

  // Sanitize inputs to keep one-line logs
  const cleanMessage = clean(message);
  // Required structure: always include instance_id and username: 'Fri Sep 12 18:59:53 PDT 2025: [instance_id] message (username)'
  const line = `${dateStr}: [${instanceId}] ${cleanMessage} (${userName})\n`;
  console.log('[DEBUG] Formatted log line:', line.trim());

  // Add to debounce buffer instead of writing immediately
  debounceBuffer.push({ logFilePath, line });
  console.log(`[DEBUG] Buffer size: ${debounceBuffer.length}/${MAX_BUFFER_SIZE}`);

  // Check if we should flush immediately (max buffer size reached)
  if (debounceBuffer.length >= MAX_BUFFER_SIZE) {
    console.log('[DEBUG] Buffer full, flushing immediately');
    await flushLogBuffer();
  } else {
    // Reset/start the debounce timer
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    console.log(`[DEBUG] Starting debounce timer (${DEBOUNCE_DELAY}ms)`);
    debounceTimer = setTimeout(flushLogBuffer, DEBOUNCE_DELAY);
  }

  console.log('[DEBUG] Responding with ok: true');
  res.json({ ok: true });
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// GET /api/log/progress-all?instance_id=...
// Returns all log records for a given instance_id from amp-*.log files
app.get('/api/log/progress-all', async (req, res) => {
  const instanceId = String(req.query.instance_id || req.query.id || '').trim();
  if (!instanceId) {
    return res.status(400).json({ error: 'instance_id_required' });
  }

  try {
    const files = await fsp.readdir(LOG_DIR);
    const logFiles = files.filter(f => f.startsWith('amp-') && f.endsWith('.log'));
    const entries = [];

    const pattern = `[${instanceId}]`;
    for (const file of logFiles) {
      const fullPath = path.join(LOG_DIR, file);
      let text;
      try {
        text = await fsp.readFile(fullPath, 'utf8');
      } catch (e) {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (const rawLine of lines) {
        if (!rawLine || rawLine.indexOf(pattern) === -1) continue;
        // Expected format: "<timestamp>: [instanceId] message (username)"
        const tsPart = rawLine.split(': [')[0];
        const msgPart = rawLine.substring(rawLine.indexOf(pattern) + pattern.length).trim();
        const usernameMatch = msgPart.match(/\(([^)]+)\)\s*$/);
        const username = usernameMatch ? usernameMatch[1] : undefined;
        const message = usernameMatch ? msgPart.replace(usernameMatch[0], '').trim() : msgPart;
        let ts = null;
        try {
          const parsed = Date.parse(tsPart);
          ts = isNaN(parsed) ? null : new Date(parsed).toISOString();
        } catch (_) { ts = null; }
        entries.push({
          ts,
          message,
          username,
          source: file,
          raw: rawLine
        });
      }
    }

    // Sort by timestamp if available, else keep insertion order
    entries.sort((a, b) => {
      if (a.ts && b.ts) return a.ts.localeCompare(b.ts);
      if (a.ts) return -1;
      if (b.ts) return 1;
      return 0;
    });

    return res.json({ instance_id: instanceId, progress: entries });
  } catch (e) {
    console.error('[ERROR] progress-all failed:', e.message || e);
    return res.status(500).json({ error: 'progress_all_failed', detail: e && e.message ? e.message : String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`Agent Log REST service listening on http://localhost:${PORT}`);
});
