
const express = require('express');
const fs = require('fs');
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

app.use(express.json());

// Ensure log directory exists
fs.mkdirSync(LOG_DIR, { recursive: true });

app.post('/api/log', async (req, res) => {
  const { service, level = 'info', message, timestamp, meta } = req.body;
  if (!service || !message) {
    return res.status(400).json({ error: 'Missing required fields: service, message' });
  }
  // Determine log file name: amp-mmm-yyyy.log
  const dateObj = timestamp ? new Date(timestamp) : new Date();
  const monthNames = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const mmm = monthNames[dateObj.getMonth()];
  const yyyy = dateObj.getFullYear();
  const logFileName = `amp-${mmm}-${yyyy}.log`;
  const logFilePath = path.join(LOG_DIR, logFileName);

  console.log(`Logging to ${logFilePath}`);

  // Format: 'Mon Sep 08 15:26:27 PDT 2025: [instance-Id] message'
  const dateObjForLog = timestamp ? new Date(timestamp) : new Date();
  // Manually construct: 'Wed Sep 10 12:18:19 PDT 2025' (no comma)
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = weekdays[dateObjForLog.getDay()];
  const month = months[dateObjForLog.getMonth()];
  const date = dateObjForLog.getDate().toString().padStart(2, '0');
  const hours = dateObjForLog.getHours().toString().padStart(2, '0');
  const mins = dateObjForLog.getMinutes().toString().padStart(2, '0');
  const secs = dateObjForLog.getSeconds().toString().padStart(2, '0');
  // Get timezone abbreviation
  const tzMatch = dateObjForLog.toTimeString().match(/\(([^)]+)\)$/);
  const tz = tzMatch ? tzMatch[1].split(' ').map(w => w[0]).join('') : '';
  const year = dateObjForLog.getFullYear();
  const dateStr = `${day} ${month} ${date} ${hours}:${mins}:${secs} ${tz} ${year}`;
  const instanceId = meta && meta.instance_id ? meta.instance_id : '';
  const instancePart = instanceId ? ` [${instanceId}]` : '';
  const line = `${dateStr}:${instancePart} ${message}\n`;

  try {
    // Ensure file exists before locking
    if (!fs.existsSync(logFilePath)) {
      fs.writeFileSync(logFilePath, '');
    }
    const release = await lockfile.lock(logFilePath, { retries: 5, realpath: false });
    fs.appendFileSync(logFilePath, line);
    await release();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to write log (lock)', detail: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Agent Log REST service listening on http://localhost:${PORT}`);
});
