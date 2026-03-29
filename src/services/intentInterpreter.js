import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseCommand } from "./commandParser.js";

const INTENT_TYPES = ["run", "status", "agents", "help", "chat", "ignore"];

export class IntentInterpreter {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
  }

  async interpret(text) {
    const fallback = parseCommand(text);
    const normalized = String(text || "").trim();
    if (!normalized) {
      return fallback;
    }

    const heuristic = heuristicIntent(normalized, fallback);
    if (heuristic) {
      return heuristic;
    }

    try {
      const interpreted = await this.interpretWithCodex(normalized);
      if (!interpreted) {
        return fallback;
      }

      return normalizeIntent(interpreted, fallback);
    } catch (error) {
      this.logger.warn("Intent interpreter fell back to rule parser.", {
        error: error instanceof Error ? error.message : String(error),
        text: normalized
      });
      return fallback;
    }
  }

  async interpretWithCodex(text) {
    const commandLine = this.config.codexCommand;
    if (!commandLine) {
      return null;
    }

    const outputFile = path.join(os.tmpdir(), `feishu-codex-intent-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const prompt = buildIntentPrompt(text, this.config.agentId);
    const extraArgs = [`--output-last-message ${quoteArg(outputFile)}`];
    const fullCommand = `${commandLine} ${extraArgs.join(" ")}`.trim();
    const argv = shellSplit(fullCommand);
    if (!argv.length) {
      return null;
    }

    const child =
      process.platform === "win32"
        ? spawn(fullCommand, {
            cwd: this.config.defaultRepoPath,
            shell: true,
            env: {
              ...process.env,
              FEISHU_INTENT_TEXT: text
            }
          })
        : spawn(argv[0], argv.slice(1), {
            cwd: this.config.defaultRepoPath,
            shell: false,
            env: {
              ...process.env,
              FEISHU_INTENT_TEXT: text
            }
          });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.stdin.write(prompt);
    child.stdin.end();

    const outcome = await Promise.race([
      once(child, "close").then(([code]) => ({ type: "close", code })),
      once(child, "error").then(([error]) => ({ type: "error", error }))
    ]);

    try {
      if (outcome.type === "error") {
        throw outcome.error;
      }
      if (outcome.code !== 0) {
        throw new Error(stderr || stdout || `intent interpreter exited with code ${outcome.code}`);
      }

      const content = await fs.readFile(outputFile, "utf8");
      return JSON.parse(extractJson(content));
    } finally {
      await fs.rm(outputFile, { force: true }).catch(() => {});
    }
  }
}

function heuristicIntent(text, fallback) {
  const normalized = text.trim();
  const lower = normalized.toLowerCase();

  if (fallback.type === "help" || fallback.type === "agents" || fallback.type === "status") {
    return fallback;
  }

  if (/^(hi|hello|hey|你好|哈喽|嗨|在吗|在嗎)$/.test(lower) || /^(你好|哈喽|嗨|在吗|在嗎)$/.test(normalized)) {
    return { type: "chat" };
  }

  if (/(你是谁|你是誰|怎么用|怎麼用|你能做什么|你能做什麼|会什么|會什麼)/.test(normalized)) {
    return { type: "chat" };
  }

  if (/(天气|天氣|温度|氣溫|下雨|晴天|阴天|颱風|台风)/.test(normalized)) {
    return { type: "chat" };
  }

  if (isLikelyGeneralQuestion(normalized) && !isLikelyExecutionRequest(normalized)) {
    return { type: "chat" };
  }

  return null;
}

function isLikelyGeneralQuestion(text) {
  return /[？?]$/.test(text) || /^(为什么|為什麼|怎么|怎麼|如何|多少|什么|什麼|能不能|可不可以)/.test(text);
}

function isLikelyExecutionRequest(text) {
  return /(帮我|幫我|请帮|請幫|检查|檢查|修改|修复|修復|实现|實現|运行|運行|执行|執行|分析|看看|看下|提交|寫|编写|編寫|生成|整理|搜索|搜尋|打开|打開|仓库|倉庫|repo|agent=|model=|状态|狀態|节点|節點)/i.test(
    text
  );
}

function buildIntentPrompt(text, currentAgentId) {
  return [
    "You are the intent router for a Feishu-to-Codex bridge.",
    "Decide what the system should do with the user's latest message.",
    "Return JSON only. No markdown, no explanation.",
    `Current default agent id: ${currentAgentId}`,
    "Allowed intent types: run, status, agents, help, chat, ignore.",
    "Use type=run only when the user is asking the connected computer/Codex to do work: coding, editing files, reading local repos, checking local changes, running commands, or other executable tasks.",
    "Use type=chat for normal conversation, general questions, greetings, explanations, brainstorming, and questions that should be answered directly in chat without creating a job.",
    "Use type=help for asking how to use the bot.",
    "Use type=agents for asking which machines/nodes are online.",
    "Use type=status for asking the status of a job and include jobId.",
    "Questions like weather, definitions, introductions, capability questions, or casual talk should usually be chat, not run.",
    "If the user includes parameters like agent=..., repo=..., model=..., extract them into the corresponding fields.",
    "For type=run, include task as clean natural-language task text without the parameter tokens.",
    "For type=chat, replyText can be empty because another responder may answer later.",
    "When unsure between run and chat, prefer chat unless the user clearly wants you to operate on the machine or repository.",
    'Return a JSON object with keys: {"type":"","task":"","repo":"","agentId":"","model":"","jobId":"","replyText":""}.',
    "Latest user message:",
    text
  ].join("\n");
}

function normalizeIntent(intent, fallback) {
  const type = INTENT_TYPES.includes(intent?.type) ? intent.type : fallback.type;
  const normalized = {
    type
  };

  if (type === "run") {
    normalized.options = {
      ...(fallback.options || {}),
      agent: String(intent?.agentId || intent?.agent || fallback.options?.agent || "").trim(),
      repo: String(intent?.repo || fallback.options?.repo || "").trim(),
      model: String(intent?.model || fallback.options?.model || "").trim()
    };
    normalized.task = String(intent?.task || fallback.task || "").trim();
    return normalized;
  }

  if (type === "status") {
    normalized.jobId = chooseJobId(intent?.jobId, fallback.jobId);
    return normalized;
  }

  if (type === "chat") {
    normalized.replyText = String(intent?.replyText || "").trim();
    if (!normalized.replyText) {
      return fallback;
    }
    return normalized;
  }

  return normalized;
}

function extractJson(value) {
  const trimmed = String(value || "").trim();
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) {
    return trimmed;
  }
  return trimmed.slice(first, last + 1);
}

function chooseJobId(modelJobId, fallbackJobId) {
  const modelValue = String(modelJobId || "").trim();
  const fallbackValue = String(fallbackJobId || "").trim();
  if (!modelValue) {
    return fallbackValue;
  }
  if (!fallbackValue) {
    return modelValue;
  }
  if (fallbackValue.includes(":") && !modelValue.includes(":")) {
    return fallbackValue;
  }
  return modelValue;
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
