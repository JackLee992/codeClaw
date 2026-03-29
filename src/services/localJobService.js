import { resolveRepoPath } from "./repoResolver.js";

export class LocalJobService {
  constructor({ config, store, queue }) {
    this.config = config;
    this.store = store;
    this.queue = queue;
  }

  async createAndQueue({ task, repo, repoPath, model, messageContext, metadata }) {
    const resolvedRepoPath = resolveRepoPath(repoPath || repo, this.config);
    const job = await this.store.create({
      task,
      repoPath: resolvedRepoPath,
      model: model || "",
      messageContext,
      metadata: {
        ...(metadata || {}),
        agentId: this.config.agentId
      }
    });

    this.queue.enqueue(job);
    return {
      job,
      resolvedRepoPath
    };
  }
}
