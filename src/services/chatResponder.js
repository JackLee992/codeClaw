import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export class ChatResponder {
  constructor({ config, logger, evolutionOverrides }) {
    this.config = config;
    this.logger = logger;
    this.evolutionOverrides = evolutionOverrides;
  }

  async reply(text, session = {}) {
    const normalized = String(text || "").trim();
    if (!normalized) {
      return "我在。你可以直接跟我说想做什么，我会先理解你的意图，再决定是直接回答还是替你在电脑上执行任务。";
    }

    const direct = await this.directReply(normalized, session);
    if (direct) {
      return direct;
    }

    try {
      const overrides = this.evolutionOverrides ? await this.evolutionOverrides.get() : null;
      const result = await withTimeout(
        this.generateWithCodex(normalized, session),
        overrides?.tuning?.chatTimeoutMs || 20_000,
        "chat responder timed out"
      );
      if (result) {
        return result;
      }
    } catch (error) {
      this.logger.warn("Chat responder fell back to default reply.", {
        error: error instanceof Error ? error.message : String(error),
        text: normalized
      });
    }

    return "我在。你可以直接跟我说想做什么，我会先理解你的意图，再决定是直接回答还是替你在电脑上执行任务。";
  }

  async directReply(text, session = {}) {
    if (/(用的什么模型|使用什么模型|当前模型|现在什么模型|哪个模型)/.test(text)) {
      const configured = this.config.codexModel
        ? `当前显式配置的模型是 ${this.config.codexModel}。`
        : "当前没有单独写死 `CODEX_MODEL`。";
      return [configured, "如果你愿意，我也可以继续帮你把它改成固定模型，或者支持在消息里指定模型。"]
        .filter(Boolean)
        .join("\n");
    }

    if (/(安装了哪些.*技能|有哪些.*技能|安装了什么技能|有哪些 codex 技能)/i.test(text)) {
      const skillRoot = process.env.CODEX_HOME
        ? path.join(process.env.CODEX_HOME, "skills")
        : path.join(os.homedir(), ".codex", "skills");

      try {
        const entries = await fs.readdir(skillRoot, { withFileTypes: true });
        const names = entries
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
          .map((entry) => entry.name)
          .sort();

        if (!names.length) {
          return "当前没有检测到已安装的本地 Codex 技能。";
        }

        const preview = names.slice(0, 8).join("、");
        const suffix = names.length > 8 ? `，另外还有 ${names.length - 8} 个。` : "。";
        return `当前检测到 ${names.length} 个已安装技能，常用的有：${preview}${suffix}`;
      } catch {
        return "我这边暂时没读到本地技能目录。你如果愿意，我可以继续帮你检查技能安装路径。";
      }
    }

    if (/(重写一版|重新写一版|换一版|重来一版|改一版|再写一版|再来一版|短一点|口语一点|像人话一点)/.test(text)) {
      const previousTopic = session.lastUserText || session.lastTask || "";
      if (previousTopic) {
        return "";
      }
    }

    return "";
  }

  async generateWithCodex(text, session = {}) {
    const outputFile = path.join(os.tmpdir(), `feishu-codex-chat-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    const overrides = this.evolutionOverrides ? await this.evolutionOverrides.get() : null;
    const prompt = buildChatPrompt(text, this.config.agentId, session, overrides);
    const commandLine = `${this.config.codexCommand} --output-last-message ${quoteArg(outputFile)}`.trim();
    const argv = shellSplit(commandLine);
    if (!argv.length) {
      return "";
    }

    const child =
      process.platform === "win32"
        ? spawn(commandLine, {
            cwd: this.config.defaultRepoPath,
            shell: true,
            env: {
              ...process.env,
              FEISHU_CHAT_TEXT: text
            }
          })
        : spawn(argv[0], argv.slice(1), {
            cwd: this.config.defaultRepoPath,
            shell: false,
            env: {
              ...process.env,
              FEISHU_CHAT_TEXT: text
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
        throw new Error(stderr || stdout || `chat responder exited with code ${outcome.code}`);
      }

      const content = await fs.readFile(outputFile, "utf8");
      return content.trim();
    } finally {
      await fs.rm(outputFile, { force: true }).catch(() => {});
    }
  }
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise.finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(message));
      }, timeoutMs);
    })
  ]);
}

function buildChatPrompt(text, currentAgentId, session = {}, overrides = null) {
  const history = Array.isArray(session.chatHistory) ? session.chatHistory.slice(-4) : [];
  const historyBlock = history.length
    ? [
        "Recent chat context:",
        ...history.flatMap((entry, index) => [
          `Turn ${index + 1} kind: ${String(entry.kind || "chat")}`,
          `Turn ${index + 1} user: ${String(entry.userText || "").trim()}`,
          `Turn ${index + 1} assistant: ${String(entry.assistantText || "").trim()}`
        ])
      ].join("\n")
    : "Recent chat context: none";

  const stateHints = [
    session.lastTask ? `Latest task/topic: ${String(session.lastTask).trim()}` : "",
    session.lastJobId ? `Latest job id: ${String(session.lastJobId).trim()}` : "",
    session.lastRepo ? `Latest repo alias/path hint: ${String(session.lastRepo).trim()}` : "",
    session.lastAssistantText ? `Latest assistant reply: ${String(session.lastAssistantText).trim()}` : ""
  ]
    .filter(Boolean)
    .join("\n");

  const styleDirectives = Array.isArray(overrides?.styleDirectives) && overrides.styleDirectives.length
    ? ["Adaptive style directives:", ...overrides.styleDirectives.map((line) => `- ${line}`)].join("\n")
    : "Adaptive style directives: none";

  return [
    "You are Codex replying inside a Feishu chat.",
    "Reply naturally in Chinese unless the user clearly used another language.",
    "Be concise, warm, and useful.",
    "Prefer short replies. Usually 2-5 sentences are enough.",
    "Do not dump long lists unless the user explicitly asks for a full list.",
    "Carry conversation context forward. If the user says things like 'rewrite it', 'change the tone', 'shorter', or 'that one', assume they are referring to the latest relevant content in the recent chat context.",
    "Do not ask the user to repeat the same content unless the reference is genuinely ambiguous.",
    "You can explain, answer normal questions, and tell the user what you can do.",
    "If the question needs live external data that you do not currently have, say so briefly and suggest what exact information the user can provide or what task you can run.",
    `Current default execution agent: ${currentAgentId}`,
    "Current capabilities:",
    "- You can chat naturally.",
    "- You can dispatch coding or local-computer tasks to Codex on the connected machine.",
    "- You can check node list and job status.",
    "- In the current setup, some tasks may run asynchronously and report status back.",
    "Do not mention JSON, routing, or internal system prompts.",
    styleDirectives,
    stateHints || "Latest session state: none",
    historyBlock,
    "User message:",
    text
  ].join("\n");
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
