export class AccessControl {
  constructor(config) {
    this.config = config;
  }

  assertCanDispatch({ userId, agentId, repoRef, repoPath }) {
    const acl = this.config.acl;
    if (!hasAnyAcl(acl)) {
      return;
    }

    if (!userId) {
      throw new Error("当前已启用权限控制，缺少 userId。");
    }

    if (matches(userId, acl.adminUsers)) {
      return;
    }

    if (acl.allowedUsers.length && !matches(userId, acl.allowedUsers)) {
      throw new Error(`用户没有访问权限: ${userId}`);
    }

    const userRule = acl.userRules[userId] || {};
    const allowedAgents = listFromRule(userRule.agents, acl.allowedAgentIds);
    const allowedRepos = listFromRule(userRule.repos, acl.allowedRepos);

    if (agentId && allowedAgents.length && !matches(agentId, allowedAgents)) {
      throw new Error(`用户无权调度节点: ${agentId}`);
    }

    if (allowedRepos.length && !repoMatches(repoRef, repoPath, allowedRepos)) {
      throw new Error(`用户无权访问仓库: ${repoRef || repoPath || "unknown"}`);
    }
  }
}

function hasAnyAcl(acl) {
  return (
    acl.allowedUsers.length > 0 ||
    acl.adminUsers.length > 0 ||
    acl.allowedAgentIds.length > 0 ||
    acl.allowedRepos.length > 0 ||
    Object.keys(acl.userRules).length > 0
  );
}

function listFromRule(ruleValue, fallback) {
  if (Array.isArray(ruleValue)) {
    return ruleValue;
  }

  return fallback;
}

function matches(value, list) {
  return list.includes("*") || list.includes(value);
}

function repoMatches(repoRef, repoPath, allowedRepos) {
  if (allowedRepos.includes("*")) {
    return true;
  }

  return allowedRepos.some((entry) => {
    if (repoRef && repoRef === entry) {
      return true;
    }

    if (repoPath) {
      const normalizedPath = normalize(repoPath);
      const normalizedEntry = normalize(entry);
      return normalizedPath === normalizedEntry || normalizedPath.startsWith(`${normalizedEntry}/`);
    }

    return false;
  });
}

function normalize(value) {
  return String(value || "").replace(/\\/g, "/").toLowerCase();
}
