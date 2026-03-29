import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseCommand } from "./commandParser.js";

const INTENT_TYPES = ["run", "status", "agents", "jobs", "help", "chat", "ignore"];

export class IntentInterpreter {
  constructor({ config, logger, evolutionOverrides }) {
    this.config = config;
    this.logger = logger;
    this.evolutionOverrides = evolutionOverrides;
  }

  async interpret(text, session = {}) {
    const fallback = parseCommand(text);
    const normalized = String(text || "").trim();
    if (!normalized) {
      return fallback;
    }

    const overrides = this.evolutionOverrides ? await this.evolutionOverrides.get() : null;
    const heuristic = heuristicIntent(normalized, fallback, session, overrides);
    if (heuristic) {
      return applySessionDefaults(heuristic, session);
    }

    try {
      const interpreted = await this.interpretWithCodex(normalized, session, overrides);
      if (!interpreted) {
        return fallback;
      }

      return applySessionDefaults(normalizeIntent(interpreted, fallback), session);
    } catch (error) {
      this.logger.warn("Intent interpreter fell back to rule parser.", {
        error: error instanceof Error ? error.message : String(error),
        text: normalized
      });
      return applySessionDefaults(fallback, session);
    }
  }

  async interpretWithCodex(text, session = {}, overrides = null) {
    const commandLine = this.config.codexCommand;
    if (!commandLine) {
      return null;
    }

    const outputFile = path.join(os.tmpdir(), `feishu-codex-intent-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const prompt = buildIntentPrompt(text, this.config.agentId, session, overrides);
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

function heuristicIntent(text, fallback, session = {}, overrides = null) {
  const normalized = text.trim();
  const lower = normalized.toLowerCase();
  const learned = overrides?.learnedPhrases || {};

  if (fallback.type === "help" || fallback.type === "agents" || fallback.type === "status") {
    return fallback;
  }

  if (matchesLearnedPhrase(normalized, learned.agents)) {
    return { type: "agents" };
  }

  if (matchesLearnedPhrase(normalized, learned.jobs)) {
    return { type: "jobs" };
  }

  if (matchesLearnedPhrase(normalized, learned.chat)) {
    return { type: "chat" };
  }

  const recentRunIntent = detectRecentRunIntent(normalized, session);
  if (recentRunIntent) {
    return recentRunIntent;
  }

  if (/(几个设备在线|几台设备在线|几个机器在线|几台机器在线|多少设备在线|多少机器在线|多少节点在线|当前在线设备|当前在线机器|当前在线节点|在线的设备|在线的机器|在线的节点)/.test(normalized)) {
    return { type: "agents" };
  }

  if (/(任务执行情况|执行情况|哪些任务在跑|哪些任务正在跑|现在有哪些任务|当前有哪些任务|当前任务|任务概览|任务总览|汇报.*任务|总结.*任务)/.test(normalized)) {
    return { type: "jobs" };
  }

  if (/(明明有.*任务|有在执行的任务|有任务在跑|怎么没有任务|为什么没有任务)/.test(normalized)) {
    return { type: "jobs" };
  }

  if (/(用的什么模型|使用什么模型|当前模型|现在什么模型|哪个模型)/.test(normalized)) {
    return { type: "chat" };
  }

  if (/(安装了哪些.*技能|有哪些.*技能|现在安装了哪些.*skill|安装了什么技能|有哪些 codex 技能)/i.test(normalized)) {
    return { type: "chat" };
  }

  if (/^(hi|hello|hey|你好|哈喽|嗨|在吗|在嗎)$/.test(lower) || /^(你好|哈喽|嗨|在吗|在嗎)$/.test(normalized)) {
    return { type: "chat" };
  }

  if (/(你是谁|你是誰|怎么用|怎麼用|你能做什么|你能做什麼|会什么|會什麼)/.test(normalized)) {
    return { type: "chat" };
  }

  if (/(天气|天氣|温度|氣溫|下雨|晴天|阴天|颱風|台风)/.test(normalized) && !isStrongExecutionRequest(normalized)) {
    return { type: "chat" };
  }

  if (isFollowUpTurn(normalized, learned.followUps)) {
    if (session.lastIntent === "chat") {
      return { type: "chat" };
    }
    if (session.lastIntent === "run" && isRunFollowUpText(normalized)) {
      return {
        type: "run",
        task: mergeFollowUpTask(normalized, session),
        options: {
          ...(fallback.options || {})
        }
      };
    }
    return { type: "chat" };
  }

  if (isStrongExecutionRequest(normalized)) {
    return {
      ...fallback,
      type: "run",
      task: String(fallback.task || normalized).trim(),
      options: {
        ...(fallback.options || {})
      }
    };
  }

  if (isLikelyGeneralCreationRequest(normalized) && !isLikelyExecutionRequest(normalized)) {
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
  return /(本地|电脑|電腦|机器|機器|节点|節點|agent=|repo=|model=|仓库|倉庫|项目|項目|代码|代碼|代码库|代碼庫|git|commit|pr\b|pull request|分支|branch|目录|目錄|文件|檔案|日志|日誌|终端|終端|shell|命令行|command|运行脚本|跑脚本|启动服务|啟動服務|查看改动|查看改動|最近改动|最近改動|diff|测试|測試|单测|單測|构建|構建|编译|編譯|修 bug|修复 bug|修復 bug|报错|報錯|排查|状态|狀態|任务状态|任務狀態|浏览器|瀏覽器|chrome|edge|firefox|壁纸|壁紙|墙纸|牆紙|桌面|截图|截圖|截屏|屏幕|螢幕|窗口|視窗|网页|網頁|网站|網站|资源管理器|檔案總管|powershell|cmd|设置|設置|原图|原圖|原文件)/i.test(
    text
  );
}

function isLikelyGeneralCreationRequest(text) {
  return /(写|寫|写一篇|寫一篇|写个|寫個|润色|潤色|改写|改寫|总结|總結|概括|文案|稿子|脚本|腳本|朋友圈|小红书|小紅書|抖音|微博|标题|標題|热点|熱點|方案|提纲|提綱|邮件|郵件|回复|回覆|翻译|翻譯|介绍|介紹|说明|說明)/i.test(
    text
  );
}

function isFollowUpTurn(text, learnedFollowUps = []) {
  return (
    /^(继续|接着|然后|那就|按刚才|照刚才|沿用刚才|还是刚才|再来|再写|重写|重新写|改一下|改一版|换一版|再短一点|短一点|口语一点|像人话一点|就按这个|按这个来|就这个|这版不行|上一版不行|你自己重写|换回|换成|恢复|发给我|直接发|发到聊天|不要卡片|别发卡片|不要截图|就发原图)/.test(
      text
    ) || matchesLearnedPhrase(text, learnedFollowUps)
  );
}

function detectRecentRunIntent(text, session = {}) {
  const lastJobId = String(session.lastJobId || "").trim();
  const lastIntent = String(session.lastIntent || "").trim();

  if (lastJobId && /(执行.*慢|怎么.*慢|为什么.*慢|还没好|怎么还没|什么时候好|进展|卡住|还在跑|还在执行|做到哪|到哪一步|完成了吗|好了没|为什么还没|为什么这么久)/.test(text)) {
    return {
      type: "status",
      jobId: lastJobId
    };
  }

  if (lastIntent === "run" && isRunFollowUpText(text)) {
    return {
      type: "run",
      task: mergeFollowUpTask(text, session)
    };
  }

  return null;
}

function isRunFollowUpText(text) {
  return /(继续|接着|按刚才|照刚才|沿用|用刚才|改成|改一下|补充|优化|重写|重做|再来一版|换回|换成|恢复|恢复成|发给我|发到聊天|直接发|直接回|不要卡片|别发卡片|不要截图|别截图|原图|原文件|壁纸|墙纸|桌面|浏览器|chrome|edge)/i.test(
    text
  );
}

function isStrongExecutionRequest(text) {
  if (!isLikelyExecutionRequest(text)) {
    return false;
  }

  if (/agent=|repo=|model=/.test(text)) {
    return true;
  }

  if (/(打开|开一下|启动|关闭|关掉|停止|查看|看看|检查|查一下|搜一下|搜一搜|搜索|截图|截屏|发给我|发到聊天|找出来|找回|换成|换回|恢复|设置|修改|安装|卸载|运行|执行|处理|修一下|修复|排查|帮我打开|帮我看|帮我查|帮我处理|继续处理|继续刚才)/.test(text)) {
    return true;
  }

  if (/(浏览器|chrome|edge|firefox|壁纸|墙纸|桌面|截图|截屏|原图|原文件|窗口|网页|网站|资源管理器|powershell|cmd|终端|日志|文件|服务|进程)/i.test(text)) {
    return true;
  }

  return false;
}

function matchesLearnedPhrase(text, phrases = []) {
  return (Array.isArray(phrases) ? phrases : []).some((phrase) => phrase && text.includes(phrase));
}

function buildIntentPrompt(text, currentAgentId, session = {}, overrides = null) {
  const sessionHints = [
    session.lastIntent ? `Last intent: ${session.lastIntent}` : "",
    session.lastTask ? `Last task/topic: ${session.lastTask}` : "",
    session.lastUserText ? `Last user text: ${session.lastUserText}` : "",
    session.lastAssistantText ? `Last assistant reply: ${session.lastAssistantText}` : "",
    session.sessionSummary ? `Session summary: ${session.sessionSummary}` : "",
    overrides?.learnedPhrases?.agents?.length ? `Learned agents phrases: ${overrides.learnedPhrases.agents.join(" | ")}` : "",
    overrides?.learnedPhrases?.jobs?.length ? `Learned jobs phrases: ${overrides.learnedPhrases.jobs.join(" | ")}` : "",
    overrides?.learnedPhrases?.chat?.length ? `Learned chat phrases: ${overrides.learnedPhrases.chat.join(" | ")}` : "",
    overrides?.learnedPhrases?.followUps?.length ? `Learned follow-up phrases: ${overrides.learnedPhrases.followUps.join(" | ")}` : ""
  ]
    .filter(Boolean)
    .join("\n");

  return [
    "You are the intent router for a Feishu-to-Codex bridge.",
    "Decide what the system should do with the user's latest message.",
    "Return JSON only. No markdown, no explanation.",
    `Current default agent id: ${currentAgentId}`,
    "Allowed intent types: run, status, agents, jobs, help, chat, ignore.",
    "Use type=run only when the user is asking the connected computer/Codex to do work: coding, editing files, reading local repos, checking local changes, running commands, or other executable tasks.",
    "Use type=chat for normal conversation, general questions, greetings, explanations, brainstorming, and questions that should be answered directly in chat without creating a job.",
    "Use type=help for asking how to use the bot.",
    "Use type=agents for asking which machines/nodes are online.",
    "Use type=status for asking the status of a job and include jobId.",
    "Use type=jobs for asking about currently running, queued, or recent tasks in general without a specific job id.",
    "Questions like weather, definitions, introductions, capability questions, or casual talk should usually be chat, not run.",
    "If the user includes parameters like agent=..., repo=..., model=..., extract them into the corresponding fields.",
    "For type=run, include task as clean natural-language task text without the parameter tokens.",
    "For type=chat, replyText can be empty because another responder may answer later.",
    "If the user is obviously following up on the immediately previous conversation, preserve that continuity instead of treating it as a brand new unrelated request.",
    "When unsure between run and chat, prefer chat unless the user clearly wants you to operate on the machine or repository.",
    'Return a JSON object with keys: {"type":"","task":"","repo":"","agentId":"","model":"","jobId":"","replyText":""}.',
    sessionHints || "Session hints: none",
    "Latest user message:",
    text
  ].join("\n");
}

function mergeFollowUpTask(text, session) {
  const base = String(session.lastTask || session.lastUserText || "").trim();
  if (!base) {
    return text;
  }
  return `${base}\n\n补充要求：${text}`.trim();
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
    return normalized;
  }

  return normalized;
}

function applySessionDefaults(intent, session) {
  if (intent?.type !== "run") {
    return intent;
  }

  return {
    ...intent,
    options: {
      ...(intent.options || {}),
      agent: String(intent.options?.agent || session.lastAgentId || "").trim(),
      repo: String(intent.options?.repo || session.lastRepo || "").trim(),
      model: String(intent.options?.model || session.lastModel || "").trim()
    }
  };
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
