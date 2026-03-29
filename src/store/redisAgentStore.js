export class RedisAgentStore {
  constructor({ redis, prefix, staleAfterMs, localAgent }) {
    this.redis = redis;
    this.prefix = prefix;
    this.staleAfterMs = staleAfterMs;
    this.localAgent = localAgent;
  }

  async init() {
    if (this.localAgent) {
      await this.upsertHeartbeat(this.localAgent);
    }
  }

  async upsertHeartbeat(input) {
    const now = new Date().toISOString();
    const existing = await this.getRaw(input.agentId);
    const next = {
      agentId: input.agentId,
      label: input.label || input.agentId,
      baseUrl: input.baseUrl || existing?.baseUrl || "",
      meta: input.meta || existing?.meta || {},
      lastSeenAt: now,
      createdAt: existing?.createdAt || now
    };

    await this.redis.multi()
      .set(this.agentKey(input.agentId), JSON.stringify(next))
      .sadd(this.agentsKey(), input.agentId)
      .exec();
    return this.toView(next);
  }

  async get(agentId) {
    const agent = await this.getRaw(agentId);
    return agent ? this.toView(agent) : null;
  }

  async list() {
    const ids = await this.redis.smembers(this.agentsKey());
    if (!ids.length) {
      return [];
    }

    const rows = await this.redis.mget(ids.map((id) => this.agentKey(id)));
    return rows
      .filter(Boolean)
      .map((row) => this.toView(JSON.parse(row)))
      .sort((a, b) => a.agentId.localeCompare(b.agentId));
  }

  async getRaw(agentId) {
    const raw = await this.redis.get(this.agentKey(agentId));
    return raw ? JSON.parse(raw) : null;
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

  agentKey(agentId) {
    return `${this.prefix}:agent:${agentId}`;
  }

  agentsKey() {
    return `${this.prefix}:agents`;
  }
}
