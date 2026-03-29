export function formatHelp() {
  return [
    "可以直接像聊天一样给我发任务。",
    "示例：帮我检查最近的改动并给出修复建议",
    "也支持带参数：agent=office-pc repo=video-skills-codex 帮我检查最近的改动",
    "查看节点：节点 / machines / agents",
    "查看状态：状态 <job-id>",
    "查看帮助：帮助 / help"
  ].join("\n");
}

export function formatQueued(job) {
  return [
    "我收到你的任务了，先开始处理。",
    job.metadata?.agentId ? `执行机器：${job.metadata.agentId}` : "",
    `任务编号：${job.id}`,
    `工作目录：${job.repoPath}`
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatStarted(job) {
  return [
    "我先看一下上下文，马上给你反馈。",
    job.metadata?.agentId ? `执行机器：${job.metadata?.agentId}` : "",
    `任务编号：${job.id}`
  ].filter(Boolean).join("\n");
}

export function formatCompleted(job) {
  return [
    "这边处理完了。",
    `任务编号：${job.id}`,
    "",
    truncateText(job.result?.summary || "执行完成。", 1800)
  ].join("\n");
}

export function formatFailed(job) {
  return [
    "这次处理没跑通。",
    `任务编号：${job.id}`,
    "",
    truncateText(job.error || "unknown error", 1800)
  ].join("\n");
}

export function formatStatus(job) {
  return [
    `job=${job.id}`,
    `status=${job.status}`,
    job.metadata?.agentId ? `agent=${job.metadata.agentId}` : "",
    `repo=${job.repoPath}`,
    job.error ? `error=${truncateText(job.error, 500)}` : "",
    job.result?.summary ? `summary=${truncateText(job.result.summary, 500)}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatAgents(agents, currentAgentId) {
  if (!agents.length) {
    return "当前没有已注册节点。";
  }

  return [
    "节点列表：",
    ...agents.map((agent) => {
      const current = agent.agentId === currentAgentId ? " (local)" : "";
      const label = agent.label && agent.label !== agent.agentId ? ` label=${agent.label}` : "";
      const platform = agent.meta?.platform ? ` platform=${agent.meta.platform}` : "";
      const arch = agent.meta?.arch ? ` arch=${agent.meta.arch}` : "";
      return `- ${agent.agentId}${current} status=${agent.status}${label}${platform}${arch} lastSeen=${agent.lastSeenAt}`;
    })
  ].join("\n");
}

export function formatJobsOverview(jobs, currentAgentId) {
  if (!jobs.length) {
    return "现在没有正在排队或执行中的任务。";
  }

  const active = jobs.filter((job) => job.status === "queued" || job.status === "running");
  const recent = active.length ? active : jobs.slice(0, 5);

  return [
    active.length ? "当前在跑的任务：" : "最近的任务：",
    ...recent.map((job) => {
      const agent = job.metadata?.agentId || currentAgentId;
      const task = truncateText(job.task || "", 80);
      return `- ${job.status} | ${agent} | ${job.id} | ${task}`;
    })
  ].join("\n");
}

export function truncateText(value, maxLength) {
  if (!value || value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}
