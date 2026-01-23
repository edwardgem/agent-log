class EventLogStore {
  async init() {
    throw new Error('Not implemented');
  }

  async appendLogEntry(_entry) {
    throw new Error('Not implemented');
  }

  async listLogEntries(_instanceId) {
    throw new Error('Not implemented');
  }

  async insertApprovalEvent(_event) {
    throw new Error('Not implemented');
  }

  async getApprovalEventsByDecisionPoint(_orgId, _agentName, _decisionPointId) {
    throw new Error('Not implemented');
  }

  async getApprovalRequestByDecisionPoint(_orgId, _agentName, _decisionPointId) {
    throw new Error('Not implemented');
  }
}

module.exports = { EventLogStore };
