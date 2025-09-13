
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const lockfile = require('proper-lockfile');

const app = express();
const PORT = process.env.PORT || 4000;

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
  const { service, level = 'info', message, timestamp, meta } = req.body;
  if (!service || !message) {
    return res.status(400).json({ error: 'Missing required fields: service, message' });
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

  if (process.env.DEBUG) {
    console.log(`Logging to ${logFilePath}`);
  }

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
  const clean = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim();
  const instanceId = meta && meta.instance_id ? clean(meta.instance_id) : '';
  const instancePart = instanceId ? ` [${instanceId}]` : '';
  const cleanMessage = clean(message);
  // Required structure: 'Fri Sep 12 18:59:53 PDT 2025: [instance_id] message'
  const line = `${dateStr}:${instancePart} ${cleanMessage}\n`;

  try {
    // Ensure file exists before locking (atomic create-or-append)
    const fh = await fsp.open(logFilePath, 'a');
    await fh.close();

    // Acquire an inter-process lock with retries and stale protection
    const release = await lockfile.lock(logFilePath, {
      realpath: false,
      stale: 5000,
      retries: { retries: 10, factor: 1.4, minTimeout: 50, maxTimeout: 500 },
    });
    try {
      await fsp.appendFile(logFilePath, line, 'utf8');
    } finally {
      await release();
    }
    res.json({ ok: true });
  } catch (err) {
    const status = /lock/i.test(err.message) ? 503 : 500;
    res.status(status).json({ error: 'Failed to write log', detail: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Agent Log REST service listening on http://localhost:${PORT}`);
});
