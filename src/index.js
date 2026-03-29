import express from "express";
import os from "node:os";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { createStores } from "./store/storeFactory.js";
import { FeishuClient } from "./services/feishuClient.js";
import { FeishuEventService } from "./services/feishuEventService.js";
import { IngestService } from "./services/ingestService.js";
import { LocalJobService } from "./services/localJobService.js";
import { AgentClient } from "./services/agentClient.js";
import { AgentHeartbeat } from "./services/agentHeartbeat.js";
import { DispatchService } from "./services/dispatchService.js";
import { FeishuLongConnectionService } from "./services/feishuLongConnectionService.js";
import { createExecutor } from "./services/executors.js";
import { JobQueue } from "./queue/jobQueue.js";
import { AccessControl } from "./services/accessControl.js";
import { IntentInterpreter } from "./services/intentInterpreter.js";
import { ChatResponder } from "./services/chatResponder.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const runtime = await createRuntime();
const {
  store,
  agentStore,
  dispatch,
  localJobs,
  ingestService,
  feishuEvents,
  feishuLongConnection,
  heartbeat,
  storeKind
} = runtime;

app.get("/healthz", async (_req, res) => {
  res.json({
    ok: true,
    executorType: config.executorType,
    defaultRepoPath: config.defaultRepoPath,
    agentId: config.agentId,
    storeKind,
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname()
  });
});

app.get("/jobs/:jobId", async (req, res) => {
  const job = await store.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({
      code: 404,
      msg: "job not found"
    });
  }

  return res.json(job);
});

app.get("/agents", async (_req, res) => {
  res.json({
    agents: await agentStore.list(),
    currentAgentId: config.agentId
  });
});

app.get("/internal/jobs/:jobId", async (req, res) => {
  if (!verifyInternalToken(req, res)) {
    return;
  }

  const job = await store.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({
      code: 404,
      msg: "job not found"
    });
  }

  return res.json({ job });
});

app.post("/internal/jobs", async (req, res) => {
  if (!verifyInternalToken(req, res)) {
    return;
  }

  try {
    const created = await localJobs.createAndQueue({
      task: req.body?.task || "",
      repo: req.body?.repo || "",
      repoPath: req.body?.repoPath || "",
      model: req.body?.model || "",
      messageContext: req.body?.messageContext || { replyMode: "none" },
      metadata: req.body?.metadata || {}
    });

    res.json({
      code: 0,
      job: created.job
    });
  } catch (error) {
    res.status(400).json({
      code: 1,
      msg: error instanceof Error ? error.message : "unknown error"
    });
  }
});

app.post("/internal/agents/heartbeat", async (req, res) => {
  if (!verifyInternalToken(req, res)) {
    return;
  }

  const agent = await agentStore.upsertHeartbeat({
    agentId: req.body?.agentId || "",
    label: req.body?.label || "",
    baseUrl: req.body?.baseUrl || "",
    meta: req.body?.meta || {}
  });

  res.json({
    code: 0,
    agent
  });
});

app.post("/ingest/message", async (req, res) => {
  try {
    await ingestService.handle(req, res);
  } catch (error) {
    logger.error("Failed to ingest message.", {
      error: error instanceof Error ? error.message : String(error),
      body: req.body
    });
    res.status(400).json({
      code: 1,
      msg: error instanceof Error ? error.message : "unknown error"
    });
  }
});

app.post("/webhooks/feishu/events", async (req, res) => {
  try {
    await feishuEvents.handle(req, res);
  } catch (error) {
    logger.error("Failed to handle Feishu event.", {
      error: error instanceof Error ? error.message : String(error),
      body: req.body
    });
    res.status(400).json({
      code: 1,
      msg: error instanceof Error ? error.message : "unknown error"
    });
  }
});

app.listen(config.port, () => {
  logger.info("Feishu Codex Bridge is listening.", {
    port: config.port,
    executorType: config.executorType,
    agentId: config.agentId,
    healthz: `${config.baseUrl}/healthz`,
    webhook: `${config.baseUrl}/webhooks/feishu/events`,
    storeKind
  });
  heartbeat.start();
  void feishuLongConnection.start();
});

function verifyInternalToken(req, res) {
  if (!config.internalSharedToken) {
    return true;
  }

  const headerToken = req.header("x-internal-token") || "";
  if (headerToken !== config.internalSharedToken) {
    res.status(401).json({
      code: 401,
      msg: "invalid internal token"
    });
    return false;
  }

  return true;
}

async function createRuntime() {
  const { jobStore, agentStore, kind } = await createStores(config);
  const client = new FeishuClient(config.feishu);
  const agentClient = new AgentClient(config);
  const executor = createExecutor(config);
  const intentInterpreter = new IntentInterpreter({
    config,
    logger
  });
  const chatResponder = new ChatResponder({
    config,
    logger
  });
  const queue = new JobQueue({
    executor,
    store: jobStore,
    client,
    timeoutMs: config.jobTimeoutMs
  });
  const localJobs = new LocalJobService({
    config,
    store: jobStore,
    queue
  });
  const accessControl = new AccessControl(config);
  const dispatch = new DispatchService({
    config,
    localJobs,
    agentStore,
    agentClient,
    accessControl
  });
  const feishuEvents = new FeishuEventService({
    config,
    client,
    dispatch
  });
  const ingestService = new IngestService({
    config,
    store: jobStore,
    dispatch,
    intentInterpreter,
    chatResponder
  });
  const feishuLongConnection = new FeishuLongConnectionService({
    config,
    client,
    dispatch,
    intentInterpreter,
    chatResponder,
    logger
  });
  const heartbeat = new AgentHeartbeat({
    config,
    client: agentClient
  });

  return {
    store: jobStore,
    agentStore,
    client,
    localJobs,
    dispatch,
    ingestService,
    feishuEvents,
    feishuLongConnection,
    heartbeat,
    storeKind: kind
  };
}
