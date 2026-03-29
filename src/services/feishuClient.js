import { logger } from "../logger.js";
import * as Lark from "@larksuiteoapi/node-sdk";

export class FeishuClient {
  constructor(config) {
    this.config = config;
    this.tenantAccessToken = "";
    this.tenantAccessTokenExpiresAt = 0;
    this.sdkClient = null;
  }

  async replyText(messageContext, text) {
    return this.replyMessage(messageContext, { text });
  }

  async replyCard(messageContext, card, fallbackText = "Codex 任务状态已更新。") {
    return this.replyMessage(messageContext, {
      text: fallbackText,
      card
    });
  }

  async addMessageReaction(messageId, emojiType = "THINKING") {
    if (!messageId) {
      return "";
    }

    try {
      const client = this.getSdkClient();
      const response = await client.im.v1.messageReaction.create({
        path: {
          message_id: messageId
        },
        data: {
          reaction_type: {
            emoji_type: emojiType
          }
        }
      });

      const reactionId = response?.data?.reaction_id || "";
      logger.info("Feishu reaction added.", {
        messageId,
        emojiType,
        reactionId
      });
      return reactionId;
    } catch (error) {
      logger.warn("Failed to add Feishu reaction.", {
        messageId,
        emojiType,
        error: error instanceof Error ? error.message : String(error)
      });
      return "";
    }
  }

  async removeMessageReaction(messageId, reactionId) {
    if (!messageId || !reactionId) {
      return;
    }

    try {
      const client = this.getSdkClient();
      await client.im.v1.messageReaction.delete({
        path: {
          message_id: messageId,
          reaction_id: reactionId
        }
      });
      logger.info("Feishu reaction removed.", {
        messageId,
        reactionId
      });
    } catch (error) {
      logger.warn("Failed to remove Feishu reaction.", {
        messageId,
        reactionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async replyMessage(messageContext, payload) {
    if (messageContext.replyMode === "none") {
      logger.info("Skip reply because replyMode is none.", { messageContext });
      return;
    }

    if (messageContext.replyMode === "webhook") {
      return this.postWebhookReply(messageContext.replyWebhook, payload);
    }

    if (!messageContext.openId && !messageContext.chatId) {
      logger.warn("Skip Feishu reply because no target is available.", { messageContext, payload });
      return;
    }

    const token = await this.getTenantAccessToken();
    const body = this.buildAppBody(messageContext, payload);

    const receiveIdType = messageContext.chatId ? "chat_id" : "open_id";
    const response = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      }
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Feishu reply failed: ${response.status} ${errorBody}`);
    }

    const responseBody = await response.text();
    logger.info("Feishu reply sent.", {
      receiveIdType,
      target: messageContext.chatId || messageContext.openId,
      responseBody
    });
  }

  buildAppBody(messageContext, payload) {
    const base = {
      receive_id: messageContext.chatId || messageContext.openId
    };

    if (payload.card) {
      return {
        ...base,
        msg_type: "interactive",
        content: JSON.stringify(payload.card)
      };
    }

    return {
      ...base,
      msg_type: "text",
      content: JSON.stringify({ text: payload.text || "" })
    };
  }

  async postWebhookReply(webhookUrl, payload) {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(
        payload.card
          ? {
              msg_type: "interactive",
              card: payload.card
            }
          : {
              msg_type: "text",
              content: {
                text: payload.text || ""
              }
            }
      )
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Feishu webhook reply failed: ${response.status} ${errorBody}`);
    }
  }

  async getTenantAccessToken() {
    const now = Date.now();
    if (this.tenantAccessToken && now < this.tenantAccessTokenExpiresAt - 60_000) {
      return this.tenantAccessToken;
    }

    if (!this.config.appId || !this.config.appSecret) {
      throw new Error("FEISHU_APP_ID / FEISHU_APP_SECRET 未配置，无法主动回推飞书消息。");
    }

    const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        app_id: this.config.appId,
        app_secret: this.config.appSecret
      })
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Feishu auth failed: ${response.status} ${errorBody}`);
    }

    const payload = await response.json();
    if (payload.code !== 0) {
      throw new Error(`Feishu auth failed: ${payload.msg || "unknown error"}`);
    }

    this.tenantAccessToken = payload.tenant_access_token;
    this.tenantAccessTokenExpiresAt = Date.now() + Number(payload.expire || 7200) * 1000;
    return this.tenantAccessToken;
  }

  getSdkClient() {
    if (!this.sdkClient) {
      if (!this.config.appId || !this.config.appSecret) {
        throw new Error("FEISHU_APP_ID / FEISHU_APP_SECRET 未配置，无法调用飞书 SDK。");
      }

      this.sdkClient = new Lark.Client({
        appId: this.config.appId,
        appSecret: this.config.appSecret
      });
    }

    return this.sdkClient;
  }
}
