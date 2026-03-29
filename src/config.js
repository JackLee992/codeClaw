import os from "node:os";
import dotenv from "dotenv";

dotenv.config({ override: true });

function splitList(value) {
  return (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export const config = {
  port: Number(process.env.PORT || 8787),
  baseUrl: process.env.BASE_URL || "http://localhost:8787",
  bridgeSharedToken: process.env.BRIDGE_SHARED_TOKEN || "",
  internalSharedToken: process.env.INTERNAL_SHARED_TOKEN || process.env.BRIDGE_SHARED_TOKEN || "",
  bridgeRole: process.env.BRIDGE_ROLE || "hybrid",
  agentId: process.env.AGENT_ID || os.hostname().toLowerCase(),
  agentLabel: process.env.AGENT_LABEL || os.hostname(),
  coordinatorUrl: process.env.COORDINATOR_URL || "",
  agentHeartbeatIntervalMs: Number(process.env.AGENT_HEARTBEAT_INTERVAL_MS || 15_000),
  agentStaleAfterMs: Number(process.env.AGENT_STALE_AFTER_MS || 45_000),
  redisUrl: process.env.REDIS_URL || "",
  redisKeyPrefix: process.env.REDIS_KEY_PREFIX || "feishu-codex-bridge",
  feishu: {
    appId: process.env.FEISHU_APP_ID || "",
    appSecret: process.env.FEISHU_APP_SECRET || "",
    verificationToken: process.env.FEISHU_VERIFICATION_TOKEN || "",
    encryptKey: process.env.FEISHU_ENCRYPT_KEY || "",
    longConnectionEnabled: (process.env.FEISHU_LONG_CONNECTION_ENABLED || "true").toLowerCase() === "true"
  },
  defaultRepoPath: process.env.DEFAULT_REPO_PATH || process.cwd(),
  allowedRepoRoots: splitList(process.env.ALLOWED_REPO_ROOTS || process.cwd()),
  acl: {
    allowedUsers: splitList(process.env.ACL_ALLOWED_USERS),
    adminUsers: splitList(process.env.ACL_ADMIN_USERS),
    allowedAgentIds: splitList(process.env.ACL_ALLOWED_AGENT_IDS),
    allowedRepos: splitList(process.env.ACL_ALLOWED_REPOS),
    userRules: parseJsonObject(process.env.ACL_USER_RULES_JSON)
  },
  jobTimeoutMs: Number(process.env.JOB_TIMEOUT_MS || 30 * 60 * 1000),
  executorType: process.env.EXECUTOR_TYPE || "codex-cli",
  codexCommand: process.env.CODEX_COMMAND || "codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox",
  codexModel: process.env.CODEX_MODEL || "",
  codexExtraArgs: process.env.CODEX_EXTRA_ARGS || ""
};

function parseJsonObject(value) {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
