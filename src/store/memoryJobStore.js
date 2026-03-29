import path from "node:path";
import { randomUUID } from "node:crypto";

function normalizeRepoPath(repoPath) {
  return path.resolve(repoPath).replace(/\\/g, "/");
}

export class MemoryJobStore {
  constructor() {
    this.jobs = new Map();
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

    this.jobs.set(id, job);
    return job;
  }

  async update(id, patch) {
    const existing = this.jobs.get(id);
    if (!existing) {
      return null;
    }

    const next = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString()
    };

    this.jobs.set(id, next);
    return next;
  }

  async get(id) {
    return this.jobs.get(id) || null;
  }

  async list(limit = 100) {
    return [...this.jobs.values()]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, limit);
  }
}
