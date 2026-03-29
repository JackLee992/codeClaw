import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function buildPrompt(job) {
  return [
    "You are running inside a Feishu-to-Codex bridge.",
    `Job ID: ${job.id}`,
    `Repository: ${job.repoPath}`,
    job.model ? `Requested model: ${job.model}` : "",
    "User task:",
    job.task
  ]
    .filter(Boolean)
    .join("\n");
}

export function createExecutor(config) {
  switch (config.executorType) {
    case "mock":
      return new MockExecutor();
    case "shell":
      return new ShellExecutor(config);
    case "codex-cli":
      return new CodexCliExecutor(config);
    default:
      throw new Error(`Unsupported executor type: ${config.executorType}`);
  }
}

class MockExecutor {
  async run(job, hooks = {}) {
    await emitProgress(hooks, {
      stage: "analyzing",
      message: "我先快速过一遍你的需求。"
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    await emitProgress(hooks, {
      stage: "working",
      message: "我正在整理要点并准备结果。"
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return {
      summary: `Mock 执行完成: ${job.task}`,
      rawOutput: JSON.stringify({ ok: true, jobId: job.id }, null, 2)
    };
  }
}

class ShellExecutor {
  constructor(config) {
    this.command = config.codexCommand;
    this.extraArgs = config.codexExtraArgs;
  }

  async run(job, hooks = {}) {
    return runCommand(this.command, this.extraArgs, job, job.task, hooks);
  }
}

class CodexCliExecutor {
  constructor(config) {
    this.command = config.codexCommand;
    this.model = config.codexModel;
    this.extraArgs = config.codexExtraArgs;
  }

  async run(job, hooks = {}) {
    const prompt = buildPrompt(job);
    const extra = [this.extraArgs];
    const model = job.model || this.model;
    if (model) {
      extra.push(`--model ${quoteArg(model)}`);
    }

    const outputFile = path.join(os.tmpdir(), `feishu-codex-bridge-${job.id}.txt`);
    extra.push(`--output-last-message ${quoteArg(outputFile)}`);

    try {
      const result = await runCommand(this.command, extra.join(" "), job, prompt, hooks);
      const lastMessage = await readOptionalFile(outputFile);
      return {
        ...result,
        summary: lastMessage || result.summary
      };
    } finally {
      await fs.rm(outputFile, { force: true }).catch(() => {});
    }
  }
}

async function runCommand(baseCommand, extraArgs, job, stdinText, hooks = {}) {
  const commandLine = `${baseCommand} ${extraArgs || ""}`.trim();
  const argv = shellSplit(commandLine);
  if (argv.length === 0) {
    throw new Error("执行命令为空。");
  }

  const child =
    process.platform === "win32"
      ? spawn(commandLine, {
          cwd: job.repoPath,
          shell: true,
          env: {
            ...process.env,
            FEISHU_JOB_ID: job.id,
            FEISHU_REPO_PATH: job.repoPath,
            FEISHU_TASK_TEXT: job.task,
            FEISHU_MODEL: job.model || ""
          }
        })
      : spawn(argv[0], argv.slice(1), {
          cwd: job.repoPath,
          shell: false,
          env: {
            ...process.env,
            FEISHU_JOB_ID: job.id,
            FEISHU_REPO_PATH: job.repoPath,
            FEISHU_TASK_TEXT: job.task,
            FEISHU_MODEL: job.model || ""
          }
        });

  let stdout = "";
  let stderr = "";
  let lastProgressAt = 0;
  let lineBuffer = "";

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    stdout += text;
    lineBuffer += text;
    const parts = lineBuffer.split(/\r?\n/);
    lineBuffer = parts.pop() || "";
    for (const line of parts) {
      const progress = extractProgressMessage(line);
      if (!progress) {
        continue;
      }
      const now = Date.now();
      if (now - lastProgressAt < 3000) {
        continue;
      }
      lastProgressAt = now;
      void emitProgress(hooks, {
        stage: "working",
        message: progress
      });
    }
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  if (stdinText) {
    child.stdin.write(stdinText);
  }
  child.stdin.end();

  const outcome = await Promise.race([
    once(child, "close").then(([code]) => ({ type: "close", code })),
    once(child, "error").then(([error]) => ({ type: "error", error }))
  ]);

  if (outcome.type === "error") {
    throw outcome.error;
  }

  const { code } = outcome;
  if (code !== 0) {
    throw new Error(`执行失败，退出码 ${code}\n${stderr || stdout}`);
  }

  return {
    summary: extractSummary(stdout) || "执行完成。",
    rawOutput: stdout,
    stderr
  };
}

function extractProgressMessage(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) {
    return "";
  }

  try {
    const parsed = JSON.parse(trimmed);
    const text =
      parsed?.delta?.text ||
      parsed?.text ||
      parsed?.message ||
      parsed?.content ||
      parsed?.summary ||
      "";
    return normalizeProgressText(text);
  } catch {
    return normalizeProgressText(trimmed);
  }
}

function normalizeProgressText(value) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    return "";
  }
  if (/^\{.*\}$/.test(text)) {
    return "";
  }
  if (text.length < 6) {
    return "";
  }
  if (/^(INFO|DEBUG|WARN|ERROR|\[info\]|\[debug\]|\[warn\]|\[error\])/i.test(text)) {
    return "";
  }
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function extractSummary(output) {
  const trimmed = (output || "").trim();
  if (!trimmed) {
    return "";
  }

  const lines = trimmed.split(/\r?\n/).slice(-12);
  return lines.join("\n");
}

function quoteArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function shellSplit(command) {
  const trimmed = command.trim();
  if (!trimmed) {
    return [];
  }

  return tokenize(trimmed);
}

function tokenize(input) {
  const result = [];
  let current = "";
  let quote = "";

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        result.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) {
    result.push(current);
  }

  return result;
}

async function readOptionalFile(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content.trim();
  } catch {
    return "";
  }
}

async function emitProgress(hooks, payload) {
  if (typeof hooks?.onProgress !== "function") {
    return;
  }
  await hooks.onProgress(payload);
}
