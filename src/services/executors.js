import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PERSISTENT_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_PERSISTENT_SESSIONS = 50;

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

export function createExecutor(config, deps = {}) {
  switch (config.executorType) {
    case "mock":
      return new MockExecutor();
    case "shell":
      return new ShellExecutor(config);
    case "codex-cli":
      return new CodexCliExecutor(config, deps);
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
  constructor(config, { logger } = {}) {
    this.command = config.codexCommand;
    this.model = config.codexModel;
    this.extraArgs = config.codexExtraArgs;
    this.logger = logger;
    this.sessions = new Map();
  }

  async run(job, hooks = {}) {
    const fastPathPlan = buildFastPathPlan(job);
    if (fastPathPlan) {
      this.logger?.info?.("Fast-path executor selected.", {
        jobId: job.id,
        actions: fastPathPlan.actions.map((action) => action.type)
      });
      await emitProgress(hooks, {
        stage: "working",
        message: "我直接走快速通道处理这个桌面任务。"
      });
      return runFastPathPlan(fastPathPlan, job, this.logger);
    }

    return this.runWithPersistentSession(job, hooks);
  }

  async runWithPersistentSession(job, hooks = {}) {
    this.pruneSessions();

    const prompt = buildPrompt(job);
    const extra = [this.extraArgs];
    const model = job.model || this.model;
    if (model) {
      extra.push(`--model ${quoteArg(model)}`);
    }

    const outputFile = path.join(os.tmpdir(), `feishu-codex-bridge-${job.id}.txt`);
    extra.push(`--output-last-message ${quoteArg(outputFile)}`);

    const sessionKey = getPersistentSessionKey(job, model);
    const existingSession = sessionKey ? this.sessions.get(sessionKey) : null;
    const command = existingSession?.threadId ? withResumeThread(this.command, existingSession.threadId) : this.command;

    if (existingSession?.threadId) {
      this.logger?.info?.("Reusing Codex session for job.", {
        jobId: job.id,
        threadId: existingSession.threadId,
        sessionKey
      });
    }

    try {
      let result;
      try {
        result = await runCommand(command, extra.join(" "), job, prompt, hooks);
      } catch (error) {
        if (!existingSession?.threadId) {
          throw error;
        }

        this.sessions.delete(sessionKey);
        this.logger?.warn?.("Persistent Codex session failed; retrying with a fresh session.", {
          jobId: job.id,
          threadId: existingSession.threadId,
          error: error instanceof Error ? error.message : String(error)
        });
        result = await runCommand(this.command, extra.join(" "), job, prompt, hooks);
      }

      const threadId = String(result.threadId || existingSession?.threadId || "").trim();
      if (sessionKey && threadId) {
        this.sessions.set(sessionKey, {
          threadId,
          lastUsedAt: Date.now()
        });
        this.enforceSessionLimit();
      }

      const lastMessage = await readOptionalFile(outputFile);
      return {
        ...result,
        summary: lastMessage || result.summary
      };
    } finally {
      await fs.rm(outputFile, { force: true }).catch(() => {});
    }
  }

  pruneSessions() {
    const now = Date.now();
    for (const [key, value] of this.sessions.entries()) {
      if (now - Number(value.lastUsedAt || 0) > PERSISTENT_SESSION_TTL_MS) {
        this.sessions.delete(key);
      }
    }
  }

  enforceSessionLimit() {
    if (this.sessions.size <= MAX_PERSISTENT_SESSIONS) {
      return;
    }

    const oldest = [...this.sessions.entries()].sort((a, b) => Number(a[1].lastUsedAt || 0) - Number(b[1].lastUsedAt || 0));
    while (this.sessions.size > MAX_PERSISTENT_SESSIONS && oldest.length > 0) {
      const entry = oldest.shift();
      if (!entry) {
        break;
      }
      this.sessions.delete(entry[0]);
    }
  }
}

async function runFastPathPlan(plan, job, logger) {
  const summaries = [];
  const rawOutputs = [];

  for (const action of plan.actions) {
    const result = await runFastPathAction(action, job, logger);
    summaries.push(result.summary);
    rawOutputs.push(JSON.stringify(result.details, null, 2));
  }

  return {
    summary: summaries.join("\n"),
    rawOutput: rawOutputs.join("\n\n"),
    stderr: ""
  };
}

async function runFastPathAction(action, job, logger) {
  switch (action.type) {
    case "restore_wallpaper":
      return runRestoreWallpaperAction(action, job, logger);
    case "show_desktop":
      return runShowDesktopAction(job, logger);
    case "open_chrome":
      return runOpenChromeAction(job, logger);
    case "open_chrome_search":
      return runOpenChromeSearchAction(action, job, logger);
    default:
      throw new Error(`Unsupported fast-path action: ${action.type}`);
  }
}

async function runRestoreWallpaperAction(action, job, logger) {
  const script = `
function Resolve-NormalizedPath([string]$value) {
  if (-not $value) { return '' }
  try {
    return (Resolve-Path -LiteralPath $value -ErrorAction Stop).Path
  } catch {
    return ''
  }
}

$stepsBack = ${Number(action.stepsBack || 1)}
$current = Resolve-NormalizedPath ((Get-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop').WallPaper)
$history = Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Wallpapers'
$candidateNames = 'BackgroundHistoryPath0','BackgroundHistoryPath1','BackgroundHistoryPath2','BackgroundHistoryPath3','BackgroundHistoryPath4'
$candidates = New-Object 'System.Collections.Generic.List[string]'
foreach ($name in $candidateNames) {
  $resolved = Resolve-NormalizedPath $history.$name
  if (-not $resolved) { continue }
  if ($current -and $resolved -ieq $current) { continue }
  if (-not $candidates.Contains($resolved)) {
    [void]$candidates.Add($resolved)
  }
}

if ($candidates.Count -lt $stepsBack) {
  throw "没有足够的历史壁纸可以切回。"
}

$target = $candidates[$stepsBack - 1]
Add-Type @'
using System.Runtime.InteropServices;
public class WallpaperBridge {
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)]
  public static extern int SystemParametersInfo(int uAction, int uParam, string lpvParam, int fuWinIni);
}
'@
[void][WallpaperBridge]::SystemParametersInfo(20, 0, $target, 3)
Start-Sleep -Milliseconds 1000
$verified = (Get-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop').WallPaper
@{
  ok = $true
  action = 'restore_wallpaper'
  target = $target
  verified = $verified
  stepsBack = $stepsBack
} | ConvertTo-Json -Compress
`.trim();

  const result = await runProcess("pwsh", ["-NoProfile", "-Command", script], {
    cwd: getFastPathCwd(job),
    logger
  });
  const payload = safeParseJson(result.stdout);
  if (!payload?.ok) {
    throw new Error("快速切换壁纸失败。");
  }

  return {
    summary: `已通过快速通道把壁纸切换到：${payload.target}`,
    details: payload
  };
}

async function runShowDesktopAction(job, logger) {
  const script = `
$shell = New-Object -ComObject Shell.Application
$shell.MinimizeAll()
@{
  ok = $true
  action = 'show_desktop'
} | ConvertTo-Json -Compress
`.trim();

  const result = await runProcess("pwsh", ["-NoProfile", "-Command", script], {
    cwd: getFastPathCwd(job),
    logger
  });
  const payload = safeParseJson(result.stdout);
  if (!payload?.ok) {
    throw new Error("快速显示桌面失败。");
  }

  return {
    summary: "已通过快速通道切到桌面显示。",
    details: payload
  };
}

async function runOpenChromeSearchAction(action, job, logger) {
  const searchUrl =
    action.engine === "baidu"
      ? `https://www.baidu.com/s?wd=${encodeURIComponent(action.query)}`
      : `https://www.google.com/search?q=${encodeURIComponent(action.query)}`;
  const script = `
$chromeCandidates = @(
  "$env:ProgramFiles\\Google\\Chrome\\Application\\chrome.exe",
  "$env:ProgramFiles(x86)\\Google\\Chrome\\Application\\chrome.exe",
  "$env:LocalAppData\\Google\\Chrome\\Application\\chrome.exe"
)
$chromePath = $chromeCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $chromePath) {
  $cmd = Get-Command chrome.exe -ErrorAction SilentlyContinue
  if ($cmd) { $chromePath = $cmd.Source }
}
if (-not $chromePath) {
  throw "未找到 Chrome。"
}
Start-Process -FilePath $chromePath -ArgumentList @('${escapeForPowerShellSingleQuote(searchUrl)}')
@{
  ok = $true
  action = 'open_chrome_search'
  chromePath = $chromePath
  url = '${escapeForPowerShellSingleQuote(searchUrl)}'
} | ConvertTo-Json -Compress
`.trim();

  const result = await runProcess("pwsh", ["-NoProfile", "-Command", script], {
    cwd: getFastPathCwd(job),
    logger
  });
  const payload = safeParseJson(result.stdout);
  if (!payload?.ok) {
    throw new Error("快速打开 Chrome 搜索失败。");
  }

  return {
    summary: `已通过快速通道打开 Chrome，并搜索：${action.query}`,
    details: payload
  };
}

async function runOpenChromeAction(job, logger) {
  const script = `
$chromeCandidates = @(
  "$env:ProgramFiles\\Google\\Chrome\\Application\\chrome.exe",
  "$env:ProgramFiles(x86)\\Google\\Chrome\\Application\\chrome.exe",
  "$env:LocalAppData\\Google\\Chrome\\Application\\chrome.exe"
)
$chromePath = $chromeCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $chromePath) {
  $cmd = Get-Command chrome.exe -ErrorAction SilentlyContinue
  if ($cmd) { $chromePath = $cmd.Source }
}
if (-not $chromePath) {
  throw "未找到 Chrome。"
}
Start-Process -FilePath $chromePath
@{
  ok = $true
  action = 'open_chrome'
  chromePath = $chromePath
} | ConvertTo-Json -Compress
`.trim();

  const result = await runProcess("pwsh", ["-NoProfile", "-Command", script], {
    cwd: getFastPathCwd(job),
    logger
  });
  const payload = safeParseJson(result.stdout);
  if (!payload?.ok) {
    throw new Error("快速打开 Chrome 失败。");
  }

  return {
    summary: "已通过快速通道打开 Chrome。",
    details: payload
  };
}

function buildFastPathPlan(job) {
  const normalized = normalizeTaskText(job.task);
  if (!normalized) {
    return null;
  }

  const latestDirective = extractLatestDirective(normalized);
  const actions = buildFastPathActions(latestDirective || normalized);
  if (actions.length > 0) {
    return { actions };
  }

  if (latestDirective && latestDirective !== normalized) {
    return null;
  }

  return null;
}

function buildFastPathActions(text) {
  const actions = [];

  const wallpaperAction = buildWallpaperAction(text);
  if (wallpaperAction) {
    actions.push(wallpaperAction);
  }

  const chromeAction = buildChromeSearchAction(text);
  if (chromeAction) {
    actions.push(chromeAction);
  }

  if (shouldShowDesktop(text) && !actions.some((action) => action.type === "show_desktop")) {
    actions.push({ type: "show_desktop" });
  }

  return dedupeActions(actions);
}

function buildWallpaperAction(text) {
  if (!/(壁纸|壁紙|墙纸|牆紙|桌面背景)/i.test(text)) {
    return null;
  }
  if (!/(换回|恢复|改回|切回|还原|原来的|之前的|上一张|上一个|前一张|前一个)/.test(text)) {
    return null;
  }

  return {
    type: "restore_wallpaper",
    stepsBack: inferWallpaperStepsBack(text)
  };
}

function inferWallpaperStepsBack(text) {
  if (/(更早|再往前|更前面|不是上一张|不是上一个|不是前一张|不是前一个|真正之前|更之前)/.test(text)) {
    return 2;
  }
  return 1;
}

function buildChromeSearchAction(text) {
  if (!/(chrome|浏览器|瀏覽器)/i.test(text)) {
    return null;
  }
  if (!/(打开|打開|启动|啟動|开一下|開一下)/.test(text)) {
    return null;
  }

  const query = extractSearchQuery(text);
  if (!query) {
    return {
      type: "open_chrome"
    };
  }

  return {
    type: "open_chrome_search",
    query,
    engine: /百度/.test(text) ? "baidu" : "google"
  };
}

function shouldShowDesktop(text) {
  return /(显示桌面|顯示桌面|切到桌面|切到桌面显示|桌面显示一下|画面切到桌面|最小化窗口|最小化所有窗口|显示一下桌面)/.test(text);
}

function extractSearchQuery(text) {
  const match = text.match(/(?:搜索|搜一下|搜一搜|搜)\s*([^，。,.；;]+)/);
  if (!match) {
    return "";
  }

  return String(match[1] || "")
    .replace(/^(一下|一搜)/, "")
    .replace(/(完成后.*|然后.*|并且.*|再.*)$/g, "")
    .trim();
}

function normalizeTaskText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractLatestDirective(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return "";
  }

  const parts = normalized
    .split(/补充要求[:：]/)
    .map((part) => part.trim())
    .filter(Boolean);

  return parts.length ? parts[parts.length - 1] : normalized;
}

function dedupeActions(actions) {
  const seen = new Set();
  const result = [];

  for (const action of actions) {
    const key = JSON.stringify(action);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(action);
  }

  return result;
}

function getPersistentSessionKey(job, model) {
  const conversationId = String(job?.messageContext?.chatId || job?.messageContext?.openId || "").trim();
  if (!conversationId) {
    return "";
  }

  return [conversationId, String(job.repoPath || "").trim(), String(model || "").trim()].join("::");
}

function withResumeThread(commandLine, threadId) {
  const normalized = String(commandLine || "").trim();
  if (!normalized) {
    return normalized;
  }

  if (/^codex\s+exec\b/i.test(normalized)) {
    return normalized.replace(/^codex\s+exec\b/i, `codex exec resume ${quoteArg(threadId)}`);
  }

  return `${normalized} resume ${quoteArg(threadId)}`.trim();
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
  let threadId = "";

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    stdout += text;
    lineBuffer += text;
    const parts = lineBuffer.split(/\r?\n/);
    lineBuffer = parts.pop() || "";
    for (const line of parts) {
      const parsed = safeParseJson(line);
      if (!threadId && parsed?.type === "thread.started" && parsed?.thread_id) {
        threadId = String(parsed.thread_id);
      }

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
    stderr,
    threadId
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

async function runProcess(command, args, { cwd, logger, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: cwd || os.homedir(),
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        ...(env || {})
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      logger?.warn?.("Fast-path command failed.", {
        command,
        args,
        code,
        stderr: stderr.slice(-1000)
      });
      reject(new Error(`${command} exited with code ${code}: ${stderr || stdout}`.trim()));
    });
  });
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

function safeParseJson(value) {
  try {
    return JSON.parse(String(value || "").trim());
  } catch {
    return null;
  }
}

function escapeForPowerShellSingleQuote(value) {
  return String(value || "").replace(/'/g, "''");
}

function getFastPathCwd(job) {
  const home = os.homedir();
  return home || job.repoPath || process.cwd();
}
