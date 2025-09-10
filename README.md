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
Mon Sep 08 15:26:27 PDT 2025: [research-20250908152541] state - active
```
If no instance_id is present, the brackets are omitted.

## Recommendations
- Deploy this service separately from your agents.
- Use a process manager (pm2, systemd, etc.) for reliability.
- Secure the endpoint if used in production.

## License
MIT
