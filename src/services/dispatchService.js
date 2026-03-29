import { resolveRepoPath } from "./repoResolver.js";
import { formatQueued, formatStatus } from "./messageFormatter.js";

export class DispatchService {
  constructor({ config, localJobs, agentStore, agentClient, accessControl }) {
    this.config = config;
    this.localJobs = localJobs;
    this.agentStore = agentStore;
    this.agentClient = agentClient;
    this.accessControl = accessControl;
  }

  async dispatchRun({ agentId, task, repo, repoPath, model, messageContext, metadata, userId }) {
    const targetAgentId = agentId || this.config.agentId;
    if (targetAgentId === this.config.agentId) {
      const resolvedRepoPath = resolveRepoPath(repoPath || repo, this.config);
      this.accessControl.assertCanDispatch({
        userId,
        agentId: targetAgentId,
        repoRef: repo,
        repoPath: resolvedRepoPath
      });
      const created = await this.localJobs.createAndQueue({
        task,
        repoPath: resolvedRepoPath,
        model,
        messageContext,
        metadata
      });

      return {
        job: created.job,
        message: formatQueued(created.job)
      };
    }

    this.accessControl.assertCanDispatch({
      userId,
      agentId: targetAgentId,
      repoRef: repo,
      repoPath: repoPath || ""
    });

    const agent = await this.agentStore.get(targetAgentId);
    if (!agent) {
      throw new Error(`未找到节点: ${targetAgentId}`);
    }

    if (agent.status !== "online") {
      throw new Error(`节点离线: ${targetAgentId}`);
    }

    const response = await this.agentClient.dispatchJob(agent, {
      task,
      repo,
      repoPath,
      model,
      messageContext,
      metadata: {
        ...(metadata || {}),
        requestedAgentId: targetAgentId
      }
    });

    const remoteJob = response.job;
    const compositeId = `${targetAgentId}:${remoteJob.id}`;
    return {
      job: {
        ...remoteJob,
        id: compositeId,
        metadata: {
          ...(remoteJob.metadata || {}),
          remoteJobId: remoteJob.id,
          agentId: targetAgentId
        }
      },
      message: [`任务已转发`, `agent=${targetAgentId}`, `job=${compositeId}`, `repo=${remoteJob.repoPath}`].join("\n")
    };
  }

  async lookupStatus(jobRef) {
    const parsed = parseJobRef(jobRef, this.config.agentId);
    if (parsed.agentId === this.config.agentId) {
      return this.localJobs.store.get(parsed.jobId);
    }

    const agent = await this.agentStore.get(parsed.agentId);
    if (!agent) {
      throw new Error(`未找到节点: ${parsed.agentId}`);
    }

    const response = await this.agentClient.fetchJob(agent, parsed.jobId);
    return {
      ...response.job,
      id: `${parsed.agentId}:${response.job.id}`
    };
  }

  async listAgents() {
    return this.agentStore.list();
  }
}

function parseJobRef(jobRef, defaultAgentId) {
  const value = String(jobRef || "").trim();
  if (!value.includes(":")) {
    return {
      agentId: defaultAgentId,
      jobId: value
    };
  }

  const [agentId, ...rest] = value.split(":");
  return {
    agentId,
    jobId: rest.join(":")
  };
}
