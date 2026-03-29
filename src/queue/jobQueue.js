import { logger } from "../logger.js";
import { formatCompleted, formatFailed, formatStarted } from "../services/messageFormatter.js";
import { buildJobCard } from "../services/cardRenderer.js";

export class JobQueue {
  constructor({ executor, store, client, timeoutMs, evolution }) {
    this.executor = executor;
    this.store = store;
    this.client = client;
    this.timeoutMs = timeoutMs;
    this.evolution = evolution;
    this.items = [];
    this.running = false;
    this.enqueueChain = Promise.resolve();
  }

  enqueue(job) {
    this.enqueueChain = this.enqueueChain
      .then(() => this.enqueueInternal(job))
      .catch((error) => {
        logger.error("Failed to enqueue job.", {
          jobId: job.id,
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }

  async enqueueInternal(job) {
    const superseded = await this.supersedeQueuedJobs(job);
    this.items.push(job.id);
    logger.info("Job queued.", {
      jobId: job.id,
      repoPath: job.repoPath,
      supersededJobIds: superseded
    });
    void this.pump();
  }

  async pump() {
    if (this.running) {
      return;
    }

    this.running = true;

    while (this.items.length > 0) {
      const jobId = this.items.shift();
      if (!jobId) {
        continue;
      }

      const job = await this.store.get(jobId);
      if (!job) {
        continue;
      }

      await this.runJob(job);
    }

    this.running = false;
  }

  async runJob(job) {
    logger.info("Job started.", { jobId: job.id, repoPath: job.repoPath });
    const running = await this.store.update(job.id, {
      status: "running",
      startedAt: new Date().toISOString()
    });

    await this.safeReply(running || job, {
      text: formatStarted(running || job),
      card: buildJobCard(running || job, "started")
    });

    try {
      const progressReporter = createProgressReporter({
        job: running || job,
        client: this.client
      });
      const result = await withTimeout(
        this.executor.run(job, {
          onProgress: async (progress) => {
            await progressReporter(progress);
          }
        }),
        this.timeoutMs
      );
      const completed = await this.store.update(job.id, {
        status: "done",
        completedAt: new Date().toISOString(),
        result
      });

      logger.info("Job completed.", { jobId: job.id });

      await this.safeReply(completed, {
        text: formatCompleted(completed),
        card: buildJobCard(completed, "done")
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = await this.store.update(job.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error: message
      });

      logger.error("Job failed.", { jobId: job.id, error: message });
      await this.evolution?.recordIncident({
        type: "job_failure",
        summary: `任务失败: ${job.task || job.id}`,
        userText: job.task || "",
        jobId: job.id,
        sessionId: job.messageContext?.chatId || job.messageContext?.openId || "",
        meta: {
          error: message,
          repoPath: job.repoPath,
          agentId: job.metadata?.agentId || ""
        }
      });
      await this.safeReply(failed, {
        text: formatFailed(failed),
        card: buildJobCard(failed, "failed")
      });
    }
  }

  async supersedeQueuedJobs(job) {
    const sessionKey = getJobSessionKey(job);
    if (!sessionKey) {
      return [];
    }

    const candidates = await this.store.list(200);
    const superseded = candidates.filter((candidate) => {
      if (!candidate || candidate.id === job.id) {
        return false;
      }
      if (candidate.status !== "queued") {
        return false;
      }
      return getJobSessionKey(candidate) === sessionKey;
    });

    if (!superseded.length) {
      return [];
    }

    const supersededIds = new Set(superseded.map((candidate) => candidate.id));
    this.items = this.items.filter((id) => !supersededIds.has(id));

    await Promise.all(
      superseded.map((candidate) =>
        this.store.update(candidate.id, {
          status: "superseded",
          completedAt: new Date().toISOString(),
          result: {
            summary: `已被同一会话中的较新任务替代：${job.id}`
          }
        })
      )
    );

    logger.info("Superseded queued jobs for same session.", {
      sessionKey,
      jobId: job.id,
      supersededJobIds: [...supersededIds]
    });

    return [...supersededIds];
  }

  async safeReply(job, payload) {
    try {
      await this.client.replyMessage(job.messageContext, payload);
    } catch (error) {
      logger.error("Failed to reply to Feishu.", {
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error)
      });
      await this.evolution?.recordIncident({
        type: "reply_failure",
        summary: `任务回复失败: ${job.task || job.id}`,
        userText: job.task || "",
        jobId: job.id,
        sessionId: job.messageContext?.chatId || job.messageContext?.openId || "",
        meta: {
          error: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }
}

function getJobSessionKey(job) {
  const chatId = String(job?.messageContext?.chatId || "").trim();
  if (chatId) {
    return `chat:${chatId}`;
  }

  const openId = String(job?.messageContext?.openId || "").trim();
  if (openId) {
    return `open:${openId}`;
  }

  return "";
}

function createProgressReporter({ job, client }) {
  let lastSentAt = 0;
  let lastMessage = "";

  return async (progress) => {
    const message = String(progress?.message || "").trim();
    if (!message) {
      return;
    }

    const now = Date.now();
    if (message === lastMessage) {
      return;
    }
    if (now - lastSentAt < 3000) {
      return;
    }

    lastSentAt = now;
    lastMessage = message;

    try {
      await client.replyText(job.messageContext, message);
    } catch (error) {
      logger.warn("Failed to send progress update.", {
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };
}

async function withTimeout(promise, timeoutMs) {
  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`任务超时，超过 ${timeoutMs}ms。`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}
