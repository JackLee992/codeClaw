import os from "node:os";
import path from "node:path";
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
  codexExtraArgs: process.env.CODEX_EXTRA_ARGS || "",
  audio: {
    transcriptionEnabled: (process.env.AUDIO_TRANSCRIPTION_ENABLED || "true").toLowerCase() === "true",
    pythonCommand: process.env.AUDIO_TRANSCRIPTION_PYTHON || "python",
    whisperModelPath:
      process.env.AUDIO_WHISPER_MODEL_PATH ||
      path.join(
        os.homedir(),
        ".cache",
        "huggingface",
        "hub",
        "models--openai--whisper-large-v3-turbo",
        "snapshots",
        "41f01f3fe87f28c78e2fbf8b568835947dd65ed9"
      )
  },
  evolution: {
    enabled: (process.env.EVOLUTION_ENABLED || "true").toLowerCase() === "true",
    dataDir: process.env.EVOLUTION_DATA_DIR || path.join(process.cwd(), "logs", "evolution"),
    overridesPath: process.env.EVOLUTION_OVERRIDES_PATH || path.join(process.cwd(), "src", "generated", "evolution-overrides.json"),
    analyzeDelayMs: Number(process.env.EVOLUTION_ANALYZE_DELAY_MS || 15_000),
    analyzeIncidentLimit: Number(process.env.EVOLUTION_ANALYZE_INCIDENT_LIMIT || 20)
  }
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
