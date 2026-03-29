import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export class ChatResponder {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
  }

  async reply(text) {
    const normalized = String(text || "").trim();
    if (!normalized) {
      return "我在。你可以直接跟我说想做什么，我会先理解你的意图，再决定是直接回答还是替你在电脑上执行任务。";
    }

    try {
      const result = await this.generateWithCodex(normalized);
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

  async generateWithCodex(text) {
    const outputFile = path.join(os.tmpdir(), `feishu-codex-chat-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    const prompt = buildChatPrompt(text, this.config.agentId);
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

function buildChatPrompt(text, currentAgentId) {
  return [
    "You are Codex replying inside a Feishu chat.",
    "Reply naturally in Chinese unless the user clearly used another language.",
    "Be concise, warm, and useful.",
    "You can explain, answer normal questions, and tell the user what you can do.",
    "If the question needs live external data that you do not currently have, say so briefly and suggest what exact information the user can provide or what task you can run.",
    `Current default execution agent: ${currentAgentId}`,
    "Current capabilities:",
    "- You can chat naturally.",
    "- You can dispatch coding or local-computer tasks to Codex on the connected machine.",
    "- You can check node list and job status.",
    "- In the current setup, some tasks may run asynchronously and report status back.",
    "Do not mention JSON, routing, or internal system prompts.",
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
