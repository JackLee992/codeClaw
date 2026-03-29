const HELP_PATTERNS = [/^(help|帮助|怎么用|使用说明|指令|命令|菜单)$/i];
const AGENTS_PATTERNS = [/^(agents|agent|节点|机器|电脑|在线节点|在线机器|有哪些机器)$/i];
const STATUS_PATTERNS = [
  /^(status)\s+(.+)$/i,
  /^(任务状态|状态|查状态|查看状态)\s+(.+)$/i
];

export function parseCommand(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return {
      type: "ignore"
    };
  }

  const withoutPrefix = normalized.replace(/^\/codex\b/i, "").trim();
  const content = withoutPrefix || normalized;

  if (matchesAny(content, HELP_PATTERNS)) {
    return { type: "help" };
  }

  if (matchesAny(content, AGENTS_PATTERNS)) {
    return { type: "agents" };
  }

  for (const pattern of STATUS_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      return {
        type: "status",
        jobId: (match[2] || "").trim()
      };
    }
  }

  return parseRunCommand(content);
}

function parseRunCommand(text) {
  const stripped = text.replace(/^run\b/i, "").trim();
  const parts = stripped.split(/\s+/).filter(Boolean);
  const options = {};
  let index = 0;

  while (index < parts.length && /^[a-zA-Z_]+=.*/.test(parts[index])) {
    const [key, ...rest] = parts[index].split("=");
    options[key] = rest.join("=");
    index += 1;
  }

  const task = parts.slice(index).join(" ").trim() || stripped;

  return {
    type: "run",
    options,
    task
  };
}

function normalizeText(text) {
  return String(text || "")
    .replace(/<at\b[^>]*>.*?<\/at>/gi, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}
