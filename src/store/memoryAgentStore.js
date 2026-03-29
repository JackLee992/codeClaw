export class MemoryAgentStore {
  constructor({ staleAfterMs, localAgent }) {
    this.staleAfterMs = staleAfterMs;
    this.agents = new Map();
    if (localAgent) {
      void this.upsertHeartbeat(localAgent);
    }
  }

  async upsertHeartbeat(input) {
    const now = new Date().toISOString();
    const existing = this.agents.get(input.agentId);
    const next = {
      agentId: input.agentId,
      label: input.label || input.agentId,
      baseUrl: input.baseUrl || existing?.baseUrl || "",
      meta: input.meta || existing?.meta || {},
      lastSeenAt: now,
      createdAt: existing?.createdAt || now
    };

    this.agents.set(input.agentId, next);
    return this.toView(next);
  }

  async get(agentId) {
    const agent = this.agents.get(agentId);
    return agent ? this.toView(agent) : null;
  }

  async list() {
    return [...this.agents.values()]
      .map((agent) => this.toView(agent))
      .sort((a, b) => a.agentId.localeCompare(b.agentId));
  }

  isOnline(lastSeenAt) {
    return Date.now() - Date.parse(lastSeenAt) <= this.staleAfterMs;
  }

  toView(agent) {
    return {
      ...agent,
      status: this.isOnline(agent.lastSeenAt) ? "online" : "offline"
    };
  }
}
