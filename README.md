# Agent Log Service

A minimal REST API for centralized logging, designed for use by multiple agent or microservice systems.

## Features
- POST /api/log endpoint for structured log ingestion
- Logs are appended as plain text to `logs/amp-mmm-yyyy.log`
- Health check at GET /health
- Easy to deploy and integrate
- Supports hot reload for development

## Usage

### Install dependencies
```
npm install
```

### Start the server
```
PORT=4000 npm start
```

Optional: configure request body size limit (default `64kb`)
```
BODY_LIMIT=128kb PORT=4000 npm start
```

### Hot reload (auto-restart on code changes)
```
npm run dev
```

### Log an event (example)
```
curl -X POST http://localhost:4000/api/log \
  -H "Content-Type: application/json" \
  -d '{
    "service": "agent-email",
    "level": "info",
    "message": "State changed to active",
    "meta": { "instance_id": "abc123" }
  }'
```

### Health check
```
curl http://localhost:4000/health
```

## Log Format
Each log entry is a single line:
```
Fri Sep 12 18:59:53 PDT 2025: [research-20250908152541] State changed to active
```
- Includes optional `[instance_id]` immediately after the timestamp.
- Newlines in inputs are stripped to keep entries single-line.

File naming uses a monthly log per config: `amp-mmm-yyyy.log`, e.g. `amp-sep-2005.log`.

## Recommendations
- Deploy this service separately from your agents.
- Use a process manager (pm2, systemd, etc.) for reliability.
- Secure the endpoint if used in production.

## License
MIT
