import os from "node:os";
import Redis from "ioredis";
import { logger } from "../logger.js";
import { MemoryJobStore } from "./memoryJobStore.js";
import { MemoryAgentStore } from "./memoryAgentStore.js";
import { RedisJobStore } from "./redisJobStore.js";
import { RedisAgentStore } from "./redisAgentStore.js";

export async function createStores(config) {
  const localAgent = {
    agentId: config.agentId,
    label: config.agentLabel,
    baseUrl: config.baseUrl,
    meta: {
      role: config.bridgeRole,
      executorType: config.executorType,
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname()
    }
  };

  if (!config.redisUrl) {
    return {
      kind: "memory",
      jobStore: new MemoryJobStore(),
      agentStore: new MemoryAgentStore({
        staleAfterMs: config.agentStaleAfterMs,
        localAgent
      }),
      redis: null
    };
  }

  try {
    const redis = new Redis(config.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 2
    });
    await redis.connect();
    await redis.ping();

    const jobStore = new RedisJobStore({
      redis,
      prefix: config.redisKeyPrefix
    });
    const agentStore = new RedisAgentStore({
      redis,
      prefix: config.redisKeyPrefix,
      staleAfterMs: config.agentStaleAfterMs,
      localAgent
    });
    await agentStore.init();

    logger.info("Redis store enabled.", {
      redisUrl: redactRedisUrl(config.redisUrl),
      prefix: config.redisKeyPrefix
    });

    return {
      kind: "redis",
      jobStore,
      agentStore,
      redis
    };
  } catch (error) {
    logger.warn("Redis unavailable, falling back to memory store.", {
      error: error instanceof Error ? error.message : String(error)
    });

    return {
      kind: "memory",
      jobStore: new MemoryJobStore(),
      agentStore: new MemoryAgentStore({
        staleAfterMs: config.agentStaleAfterMs,
        localAgent
      }),
      redis: null
    };
  }
}

function redactRedisUrl(redisUrl) {
  return redisUrl.replace(/:\/\/.*@/, "://***@");
}
