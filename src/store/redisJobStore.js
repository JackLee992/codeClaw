import path from "node:path";
import { randomUUID } from "node:crypto";

function normalizeRepoPath(repoPath) {
  return path.resolve(repoPath).replace(/\\/g, "/");
}

export class RedisJobStore {
  constructor({ redis, prefix }) {
    this.redis = redis;
    this.prefix = prefix;
  }

  async create(input) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const job = {
      id,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      error: null,
      result: null,
      ...input,
      repoPath: normalizeRepoPath(input.repoPath)
    };

    await this.redis.multi()
      .set(this.jobKey(id), JSON.stringify(job))
      .zadd(this.jobsKey(), Date.parse(now), id)
      .exec();
    return job;
  }

  async update(id, patch) {
    const existing = await this.get(id);
    if (!existing) {
      return null;
    }

    const next = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString()
    };

    await this.redis.set(this.jobKey(id), JSON.stringify(next));
    return next;
  }

  async get(id) {
    const raw = await this.redis.get(this.jobKey(id));
    return raw ? JSON.parse(raw) : null;
  }

  async list(limit = 100) {
    const ids = await this.redis.zrevrange(this.jobsKey(), 0, Math.max(0, limit - 1));
    if (!ids.length) {
      return [];
    }

    const rows = await this.redis.mget(ids.map((id) => this.jobKey(id)));
    return rows.filter(Boolean).map((item) => JSON.parse(item));
  }

  jobKey(id) {
    return `${this.prefix}:job:${id}`;
  }

  jobsKey() {
    return `${this.prefix}:jobs`;
  }
}
