export class MemorySessionStore {
  constructor() {
    this.sessions = new Map();
  }

  async get(sessionId) {
    return this.sessions.get(sessionId) || createEmptySession(sessionId);
  }

  async update(sessionId, patch) {
    const existing = await this.get(sessionId);
    const next = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString()
    };
    this.sessions.set(sessionId, next);
    return next;
  }

  async rememberRun(sessionId, details) {
    const existing = await this.get(sessionId);
    const next = {
      ...existing,
      lastIntent: "run",
      lastAgentId: details.agentId || existing.lastAgentId || "",
      lastRepo: details.repo || existing.lastRepo || "",
      lastModel: details.model || existing.lastModel || "",
      lastTask: details.task || existing.lastTask || "",
      lastJobId: details.jobId || existing.lastJobId || "",
      lastUserText: details.task || existing.lastUserText || "",
      lastAssistantText: details.assistantText || existing.lastAssistantText || "",
      sessionSummary: buildSessionSummary({
        existing,
        currentUserText: details.task || "",
        currentAssistantText: details.assistantText || "",
        kind: "run"
      }),
      chatHistory: compactHistory([
        ...(existing.chatHistory || []),
        {
          userText: details.task || "",
          assistantText: details.assistantText || "",
          at: new Date().toISOString(),
          kind: "run"
        }
      ]),
      recentJobIds: compactRecent([details.jobId, ...(existing.recentJobIds || [])]),
      updatedAt: new Date().toISOString()
    };
    this.sessions.set(sessionId, next);
    return next;
  }

  async rememberChat(sessionId, details) {
    const existing = await this.get(sessionId);
    const history = compactHistory([
      ...(existing.chatHistory || []),
      {
        userText: details.userText || "",
        assistantText: details.assistantText || "",
        at: new Date().toISOString(),
        kind: details.kind || "chat"
      }
    ]);

    const next = {
      ...existing,
      lastIntent: "chat",
      lastUserText: details.userText || existing.lastUserText || "",
      lastAssistantText: details.assistantText || existing.lastAssistantText || "",
      sessionSummary: buildSessionSummary({
        existing,
        currentUserText: details.userText || "",
        currentAssistantText: details.assistantText || "",
        kind: details.kind || "chat"
      }),
      chatHistory: history,
      updatedAt: new Date().toISOString()
    };
    this.sessions.set(sessionId, next);
    return next;
  }
}

function createEmptySession(sessionId) {
  return {
    sessionId,
    lastIntent: "",
    lastAgentId: "",
    lastRepo: "",
    lastModel: "",
    lastTask: "",
    lastJobId: "",
    lastUserText: "",
    lastAssistantText: "",
    sessionSummary: "",
    chatHistory: [],
    recentJobIds: [],
    updatedAt: new Date().toISOString()
  };
}

function compactRecent(values) {
  return [...new Set(values.filter(Boolean))].slice(0, 10);
}

function compactHistory(entries) {
  return entries
    .filter((entry) => entry && (entry.userText || entry.assistantText))
    .slice(-20);
}

function buildSessionSummary({ existing, currentUserText, currentAssistantText, kind }) {
  const parts = [
    existing.lastTask ? `最近任务主题：${existing.lastTask}` : "",
    currentUserText ? `当前用户诉求：${currentUserText}` : "",
    currentAssistantText ? `最近回复重点：${compactText(currentAssistantText, 180)}` : "",
    kind ? `最近交互类型：${kind}` : ""
  ].filter(Boolean);

  return compactText(parts.join("；"), 400);
}

function compactText(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}
