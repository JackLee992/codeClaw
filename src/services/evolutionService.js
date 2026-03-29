import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export class EvolutionService {
  constructor({ config, logger, evolutionOverrides }) {
    this.config = config;
    this.logger = logger;
    this.evolutionOverrides = evolutionOverrides;
    this.analyzeTimer = null;
    this.analyzing = false;
  }

  async ensureReady() {
    if (!this.config.evolution?.enabled) {
      return;
    }

    await fs.mkdir(this.config.evolution.dataDir, { recursive: true });
  }

  async recordIncident(incident) {
    if (!this.config.evolution?.enabled) {
      return;
    }

    await this.ensureReady();
    const entry = {
      id: `incident-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      time: new Date().toISOString(),
      ...incident
    };

    await fs.appendFile(this.incidentsPath(), `${JSON.stringify(entry)}\n`, "utf8");
    this.logger.warn("Evolution incident recorded.", {
      type: entry.type,
      summary: entry.summary || "",
      sessionId: entry.sessionId || ""
    });

    await this.applyLearning(entry);
    this.scheduleAnalyze();
  }

  async getLatestReport() {
    try {
      return await fs.readFile(this.reportPath(), "utf8");
    } catch {
      return "";
    }
  }

  async getRecentIncidents(limit = 20) {
    try {
      const content = await fs.readFile(this.incidentsPath(), "utf8");
      return content
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .slice(-limit);
    } catch {
      return [];
    }
  }

  scheduleAnalyze() {
    if (!this.config.evolution?.enabled) {
      return;
    }

    if (this.analyzeTimer) {
      clearTimeout(this.analyzeTimer);
    }

    this.analyzeTimer = setTimeout(() => {
      this.analyzeTimer = null;
      void this.generateReport();
    }, this.config.evolution.analyzeDelayMs);
  }

  async generateReport() {
    if (!this.config.evolution?.enabled || this.analyzing) {
      return;
    }

    this.analyzing = true;
    try {
      await this.ensureReady();
      const incidents = await this.getRecentIncidents(this.config.evolution.analyzeIncidentLimit);
      const report = incidents.length ? await this.buildReport(incidents) : defaultEmptyReport();
      await fs.writeFile(this.reportPath(), report, "utf8");
      this.logger.info("Evolution report updated.", {
        incidentCount: incidents.length,
        reportPath: this.reportPath()
      });
    } catch (error) {
      this.logger.error("Failed to generate evolution report.", {
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.analyzing = false;
    }
  }

  async buildReport(incidents) {
    const heuristic = buildHeuristicReport(incidents);
    if (!this.config.codexCommand) {
      return heuristic;
    }

    const prompt = buildAnalysisPrompt(incidents, heuristic);
    const outputFile = path.join(
      os.tmpdir(),
      `codeclaw-evolution-${Date.now()}-${Math.random().toString(36).slice(2)}.md`
    );
    const commandLine = `${this.config.codexCommand} --output-last-message ${quoteArg(outputFile)}`.trim();
    const argv = shellSplit(commandLine);
    if (!argv.length) {
      return heuristic;
    }

    const child =
      process.platform === "win32"
        ? spawn(commandLine, {
            cwd: this.config.defaultRepoPath,
            shell: true,
            env: process.env
          })
        : spawn(argv[0], argv.slice(1), {
            cwd: this.config.defaultRepoPath,
            shell: false,
            env: process.env
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
        throw new Error(stderr || stdout || `evolution analyzer exited with code ${outcome.code}`);
      }

      const generated = await fs.readFile(outputFile, "utf8");
      return generated.trim() || heuristic;
    } catch (error) {
      this.logger.warn("Evolution analysis fell back to heuristic report.", {
        error: error instanceof Error ? error.message : String(error)
      });
      return heuristic;
    } finally {
      await fs.rm(outputFile, { force: true }).catch(() => {});
    }
  }

  incidentsPath() {
    return path.join(this.config.evolution.dataDir, "incidents.jsonl");
  }

  reportPath() {
    return path.join(this.config.evolution.dataDir, "latest-report.md");
  }

  async applyLearning(incident) {
    if (!this.evolutionOverrides) {
      return;
    }

    const learnedMutation = deriveLearningMutation(incident);
    if (!learnedMutation) {
      return;
    }

    await this.evolutionOverrides.update(async (current) => {
      const next = structuredClone(current);
      for (const phrase of learnedMutation.learnedPhrases?.agents || []) {
        next.learnedPhrases.agents.push(phrase);
      }
      for (const phrase of learnedMutation.learnedPhrases?.jobs || []) {
        next.learnedPhrases.jobs.push(phrase);
      }
      for (const phrase of learnedMutation.learnedPhrases?.chat || []) {
        next.learnedPhrases.chat.push(phrase);
      }
      for (const phrase of learnedMutation.learnedPhrases?.followUps || []) {
        next.learnedPhrases.followUps.push(phrase);
      }
      for (const directive of learnedMutation.styleDirectives || []) {
        next.styleDirectives.push(directive);
      }
      if (learnedMutation.tuning?.chatTimeoutMs) {
        next.tuning.chatTimeoutMs = learnedMutation.tuning.chatTimeoutMs;
      }
      return next;
    });
  }
}

function deriveLearningMutation(incident) {
  const text = String(incident?.userText || incident?.summary || "").trim();
  const lower = text.toLowerCase();
  const mutation = {
    learnedPhrases: {
      agents: [],
      jobs: [],
      chat: [],
      followUps: []
    },
    styleDirectives: [],
    tuning: {}
  };

  if (!text) {
    return null;
  }

  if (/(设备在线|机器在线|节点在线|几台设备|几个设备|几台机器|多少机器|多少设备)/.test(text)) {
    mutation.learnedPhrases.agents.push(text);
  }

  if (/(任务执行情况|哪些任务在跑|当前任务|任务概览|任务总览|汇报.*任务)/.test(text)) {
    mutation.learnedPhrases.jobs.push(text);
  }

  if (/(重写一版|重新写一版|换一版|改一版|再短一点|口语一点|像人话一点|按刚才|照刚才|继续写|接着写)/.test(text)) {
    mutation.learnedPhrases.followUps.push(text);
  }

  if (incident.type === "user_dissatisfaction") {
    if (/(太ai|太 ai|不像人话|看不懂|听不懂|太官话|太书面)/i.test(lower)) {
      mutation.styleDirectives.push("Prefer colloquial Chinese and natural spoken phrasing over formal AI-sounding prose.");
      mutation.styleDirectives.push("When rewriting, prefer directly giving a revised version instead of asking the user to resend the same content.");
    }
    if (/(对不上|答非所问|乱回|没懂|理解错)/i.test(lower)) {
      mutation.styleDirectives.push("For follow-up turns, strongly anchor to the latest relevant topic before starting a new line of response.");
    }
  }

  if (incident.type === "chat_timeout") {
    mutation.tuning.chatTimeoutMs = 12000;
    mutation.styleDirectives.push("When the answer may take too long, reply with a shorter direct answer first.");
  }

  const hasChanges =
    mutation.learnedPhrases.agents.length ||
    mutation.learnedPhrases.jobs.length ||
    mutation.learnedPhrases.chat.length ||
    mutation.learnedPhrases.followUps.length ||
    mutation.styleDirectives.length ||
    mutation.tuning.chatTimeoutMs;

  return hasChanges ? mutation : null;
}

function buildHeuristicReport(incidents) {
  const groups = groupBy(incidents, (incident) => incident.type || "unknown");
  const lines = [
    "# codeClaw Evolution Report",
    "",
    `- Generated at: ${new Date().toISOString()}`,
    `- Incident count: ${incidents.length}`,
    "",
    "## Incident Summary"
  ];

  for (const [type, items] of Object.entries(groups)) {
    lines.push(`- ${type}: ${items.length}`);
  }

  lines.push("", "## Recent Incidents");
  for (const incident of incidents.slice(-10)) {
    lines.push(
      `- [${incident.time}] ${incident.type || "unknown"}: ${incident.summary || incident.userText || "no summary"}`
    );
  }

  lines.push("", "## Suggested Focus");
  if (groups.chat_timeout?.length) {
    lines.push("- Add stronger chat timeout fallback and shorter generation prompts.");
  }
  if (groups.user_dissatisfaction?.length) {
    lines.push("- Review dissatisfaction samples and tighten follow-up/context-carry behavior.");
  }
  if (groups.route_mismatch?.length) {
    lines.push("- Add or refine routing heuristics for the misclassified message patterns.");
  }
  if (groups.job_failure?.length) {
    lines.push("- Inspect executor failures and improve progress/error surfacing.");
  }
  if (lines[lines.length - 1] === "## Suggested Focus") {
    lines.push("- No strong pattern yet; keep collecting incidents.");
  }

  return lines.join("\n");
}

function buildAnalysisPrompt(incidents, heuristic) {
  return [
    "You are improving codeClaw, a Feishu-to-Codex bridge.",
    "Analyze the recent incidents and produce a concise Markdown report.",
    "Focus on practical changes to routing, context carry, timeout handling, and response style.",
    "Do not propose risky autonomous self-modification.",
    "Prefer recommendations that can be implemented in the bridge codebase safely.",
    "Structure the report with these sections:",
    "1. Top Failure Patterns",
    "2. Likely Root Causes",
    "3. Recommended Fixes",
    "4. Suggested Test Prompts",
    "Use Chinese.",
    "",
    "Heuristic baseline report:",
    heuristic,
    "",
    "Recent incidents JSON:",
    JSON.stringify(incidents, null, 2)
  ].join("\n");
}

function groupBy(items, keyFn) {
  return items.reduce((acc, item) => {
    const key = keyFn(item);
    acc[key] ||= [];
    acc[key].push(item);
    return acc;
  }, {});
}

function defaultEmptyReport() {
  return [
    "# codeClaw Evolution Report",
    "",
    `- Generated at: ${new Date().toISOString()}`,
    "- Incident count: 0",
    "",
    "## Incident Summary",
    "- 暂时还没有采集到体验事故。",
    "",
    "## Suggested Focus",
    "- 继续收集聊天超时、误路由、用户不满反馈和任务失败样本。"
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
