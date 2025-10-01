
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const lockfile = require('proper-lockfile');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 4000;

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

  const { service, level = 'info', message, timestamp, instance_id } = req.body;
  // Sanitize helper first so we can validate instance_id after trimming
  const clean = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim();

  // Validate required fields including top-level instance_id
  const instanceId = clean(instance_id);
  console.log('[DEBUG] Parsed fields:', { service, level, instanceId, hasMessage: !!message });

  if (!service || !message || !instanceId) {
    console.error('[ERROR] Missing required fields:', { service: !!service, message: !!message, instanceId: !!instanceId });
    return res.status(400).json({ error: 'Missing required fields: service, message, instance_id' });
  }
  // Determine log file name: amp-mmm-yyyy.log
  const dateObj = timestamp ? new Date(timestamp) : new Date();
  const isValidDate = !isNaN(dateObj.getTime());
  const safeDate = isValidDate ? dateObj : new Date();
  const monthNames = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const mmm = monthNames[safeDate.getMonth()];
  const yyyy = safeDate.getFullYear();
  const logFileName = `amp-${mmm}-${yyyy}.log`;
  const logFilePath = path.join(LOG_DIR, logFileName);

  console.log(`[DEBUG] Log file: ${logFilePath}`);

  // Format: 'Mon Sep 08 15:26:27 PDT 2025: [instance-Id] message'
  const dateObjForLog = safeDate;
  // Format: 'Wed Sep 10 12:18:19 PDT 2025' (no comma)
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = weekdays[dateObjForLog.getDay()];
  const month = months[dateObjForLog.getMonth()];
  const date = dateObjForLog.getDate().toString().padStart(2, '0');
  const hours = dateObjForLog.getHours().toString().padStart(2, '0');
  const mins = dateObjForLog.getMinutes().toString().padStart(2, '0');
  const secs = dateObjForLog.getSeconds().toString().padStart(2, '0');
  // Get timezone abbreviation (fallback to empty)
  const tzMatch = dateObjForLog.toTimeString().match(/\(([^)]+)\)$/);
  const tz = tzMatch ? tzMatch[1].split(' ').map(w => w[0]).join('') : '';
  const year = dateObjForLog.getFullYear();
  const dateStr = `${day} ${month} ${date} ${hours}:${mins}:${secs} ${tz} ${year}`;

  // Sanitize inputs to keep one-line logs
  const cleanMessage = clean(message);
  // Required structure: always include instance_id: 'Fri Sep 12 18:59:53 PDT 2025: [instance_id] message'
  const line = `${dateStr}: [${instanceId}] ${cleanMessage}\n`;
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

app.listen(PORT, () => {
  console.log(`Agent Log REST service listening on http://localhost:${PORT}`);
});
