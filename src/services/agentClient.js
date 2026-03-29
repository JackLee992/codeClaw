export class AgentClient {
  constructor(config) {
    this.config = config;
  }

  async dispatchJob(agent, payload) {
    const response = await fetch(joinUrl(agent.baseUrl, "/internal/jobs"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-token": this.config.internalSharedToken
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`agent dispatch failed: ${response.status} ${errorBody}`);
    }

    return response.json();
  }

  async fetchJob(agent, jobId) {
    const response = await fetch(joinUrl(agent.baseUrl, `/internal/jobs/${encodeURIComponent(jobId)}`), {
      headers: {
        "x-internal-token": this.config.internalSharedToken
      }
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`agent job fetch failed: ${response.status} ${errorBody}`);
    }

    return response.json();
  }

  async heartbeat(coordinatorUrl, payload) {
    const response = await fetch(joinUrl(coordinatorUrl, "/internal/agents/heartbeat"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-token": this.config.internalSharedToken
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`heartbeat failed: ${response.status} ${errorBody}`);
    }

    return response.json();
  }
}

function joinUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}
