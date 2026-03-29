import fs from "node:fs";
import path from "node:path";

function normalize(value) {
  return path.resolve(value).replace(/\\/g, "/").toLowerCase();
}

export function resolveRepoPath(repoArg, config) {
  const raw = (repoArg || "").trim();
  const candidate = raw
    ? path.isAbsolute(raw)
      ? raw
      : path.join(config.defaultRepoPath, raw)
    : config.defaultRepoPath;

  const resolved = path.resolve(candidate);

  if (!fs.existsSync(resolved)) {
    throw new Error(`仓库路径不存在: ${resolved}`);
  }

  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`仓库路径不是目录: ${resolved}`);
  }

  const normalized = normalize(resolved);
  const allowed = config.allowedRepoRoots.some((root) => {
    const normalizedRoot = normalize(root);
    return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`);
  });

  if (!allowed) {
    throw new Error(`仓库路径不在允许范围内: ${resolved}`);
  }

  return resolved;
}
