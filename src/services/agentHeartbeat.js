import { logger } from "../logger.js";

export class AgentHeartbeat {
  constructor({ config, client }) {
    this.config = config;
    this.client = client;
    this.timer = null;
  }

  start() {
    if (!this.config.coordinatorUrl || this.config.coordinatorUrl === this.config.baseUrl) {
      return;
    }

    const tick = async () => {
      try {
        await this.client.heartbeat(this.config.coordinatorUrl, {
          agentId: this.config.agentId,
          label: this.config.agentLabel,
          baseUrl: this.config.baseUrl,
          meta: {
            role: this.config.bridgeRole,
            executorType: this.config.executorType,
            platform: process.platform,
            arch: process.arch
          }
        });
      } catch (error) {
        logger.warn("Agent heartbeat failed.", {
          error: error instanceof Error ? error.message : String(error),
          coordinatorUrl: this.config.coordinatorUrl
        });
      }
    };

    void tick();
    this.timer = setInterval(() => {
      void tick();
    }, this.config.agentHeartbeatIntervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
