import { truncateText } from "./messageFormatter.js";

export function buildJobCard(job, kind) {
  const titleMap = {
    queued: "Codex 任务已入队",
    started: "Codex 任务已开始",
    done: "Codex 任务已完成",
    failed: "Codex 任务失败",
    status: "Codex 任务状态"
  };

  const body = kind === "failed" ? job.error || "unknown error" : job.result?.summary || job.task || "";
  const notes = [
    `job: ${job.id}`,
    job.metadata?.agentId ? `agent: ${job.metadata.agentId}` : "",
    `status: ${job.status}`,
    `repo: ${job.repoPath}`
  ]
    .filter(Boolean)
    .join("\n");

  return {
    config: {
      wide_screen_mode: true
    },
    header: {
      template: kind === "failed" ? "red" : kind === "done" ? "green" : "blue",
      title: {
        tag: "plain_text",
        content: titleMap[kind] || "Codex 任务更新"
      }
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `**摘要**\n${escapeMarkdown(truncateText(body || "等待结果中。", 1200))}`
        }
      },
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `**详情**\n${escapeMarkdown(notes)}`
        }
      }
    ]
  };
}

export function buildAgentsCard(agents, currentAgentId) {
  const lines = agents.map((agent) => {
    const current = agent.agentId === currentAgentId ? " (local)" : "";
    const platform = agent.meta?.platform ? ` · ${escapeMarkdown(agent.meta.platform)}` : "";
    const arch = agent.meta?.arch ? `/${escapeMarkdown(agent.meta.arch)}` : "";
    return `- **${escapeMarkdown(agent.agentId)}**${current} · ${agent.status}${platform}${arch} · ${escapeMarkdown(agent.label || "")}`;
  });

  return {
    config: {
      wide_screen_mode: true
    },
    header: {
      template: "wathet",
      title: {
        tag: "plain_text",
        content: "Codex 节点列表"
      }
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: lines.length ? lines.join("\n") : "当前没有已注册节点。"
        }
      }
    ]
  };
}

function escapeMarkdown(value) {
  return String(value || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
