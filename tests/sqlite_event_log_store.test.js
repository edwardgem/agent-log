const assert = require('node:assert/strict');
const { test } = require('node:test');

const { SqliteEventLogStore } = require('../store/sqlite_event_log_store');

function makeApprovalEvent(overrides = {}) {
  return {
    event_id: 'ev_01HZYA1T6D7Q1R5E9J3Q2X5D1A',
    org_id: 'O-0001ST202601091822',
    agent_name: 'payment',
    decision_point_id: 'dp_01HZYA1T6CT4Z8V0V1N3G6J7H8',
    event_type: 'approval_request',
    created_at: '2026-01-12T22:10:15Z',
    payload_json: {
      event_id: 'ev_01HZYA1T6D7Q1R5E9J3Q2X5D1A',
      event_type: 'approval_request',
      event_version: '1.0'
    },
    ...overrides
  };
}

test('appendLogEntry and listLogEntries returns ordered rows', async () => {
  const store = new SqliteEventLogStore(':memory:');
  await store.init();

  await store.appendLogEntry({
    instance_id: 'email-20260112221000',
    service: 'agent-email',
    level: 'info',
    message: 'state - active',
    username: 'tester@example.com',
    event_time: '2026-01-12T22:10:15Z',
    created_at: '2026-01-12T22:10:15Z'
  });

  const rows = await store.listLogEntries('email-20260112221000');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].message, 'state - active');
});

test('insertApprovalEvent is idempotent on org/agent/decision/type', async () => {
  const store = new SqliteEventLogStore(':memory:');
  await store.init();

  const event = makeApprovalEvent();
  await store.insertApprovalEvent(event);
  await store.insertApprovalEvent(event);

  const rows = await store.getApprovalEventsByDecisionPoint(
    event.org_id,
    event.agent_name,
    event.decision_point_id
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_type, 'approval_request');
});

test('getApprovalRequestByDecisionPoint returns parsed payload', async () => {
  const store = new SqliteEventLogStore(':memory:');
  await store.init();

  const event = makeApprovalEvent({
    payload_json: { event_id: 'ev_payload', event_type: 'approval_request' }
  });

  await store.insertApprovalEvent(event);

  const payload = await store.getApprovalRequestByDecisionPoint(
    event.org_id,
    event.agent_name,
    event.decision_point_id
  );

  assert.ok(payload);
  assert.equal(payload.event_id, 'ev_payload');
});
