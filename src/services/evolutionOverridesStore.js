import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_OVERRIDES = {
  version: 1,
  updatedAt: "",
  learnedPhrases: {
    agents: [],
    jobs: [],
    chat: [],
    followUps: []
  },
  styleDirectives: [],
  tuning: {
    chatTimeoutMs: 20_000
  }
};

export class EvolutionOverridesStore {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    this.cache = null;
  }

  async ensureReady() {
    const filePath = this.filePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    try {
      await fs.access(filePath);
    } catch {
      await fs.writeFile(filePath, `${JSON.stringify(DEFAULT_OVERRIDES, null, 2)}\n`, "utf8");
    }
    await this.load();
  }

  async load() {
    try {
      const content = await fs.readFile(this.filePath(), "utf8");
      const parsed = JSON.parse(content);
      this.cache = normalizeOverrides(parsed);
      return this.cache;
    } catch (error) {
      this.logger.warn("Failed to load evolution overrides; using defaults.", {
        error: error instanceof Error ? error.message : String(error)
      });
      this.cache = structuredClone(DEFAULT_OVERRIDES);
      return this.cache;
    }
  }

  async get() {
    if (!this.cache) {
      await this.ensureReady();
    }
    return this.cache;
  }

  async update(mutator) {
    const current = await this.get();
    const next = normalizeOverrides(await mutator(structuredClone(current)));
    next.updatedAt = new Date().toISOString();
    this.cache = next;
    await fs.writeFile(this.filePath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
    this.logger.info("Evolution overrides updated.", {
      filePath: this.filePath(),
      updatedAt: next.updatedAt
    });
    return next;
  }

  filePath() {
    return this.config.evolution.overridesPath;
  }
}

function normalizeOverrides(input) {
  const base = structuredClone(DEFAULT_OVERRIDES);
  const learned = input?.learnedPhrases || {};
  return {
    version: Number(input?.version || base.version),
    updatedAt: String(input?.updatedAt || ""),
    learnedPhrases: {
      agents: normalizeStringList(learned.agents),
      jobs: normalizeStringList(learned.jobs),
      chat: normalizeStringList(learned.chat),
      followUps: normalizeStringList(learned.followUps)
    },
    styleDirectives: normalizeStringList(input?.styleDirectives),
    tuning: {
      chatTimeoutMs: normalizeTimeout(input?.tuning?.chatTimeoutMs, base.tuning.chatTimeoutMs)
    }
  };
}

function normalizeStringList(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))].slice(
    0,
    100
  );
}

function normalizeTimeout(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 5_000 || parsed > 60_000) {
    return fallback;
  }
  return parsed;
}
