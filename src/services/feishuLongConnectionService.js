import * as Lark from "@larksuiteoapi/node-sdk";
import { formatAgents, formatHelp, formatJobsOverview, formatStatus } from "./messageFormatter.js";
import { buildAgentsCard, buildJobCard } from "./cardRenderer.js";

export class FeishuLongConnectionService {
  constructor({ config, client, dispatch, intentInterpreter, chatResponder, sessionStore, evolution, logger }) {
    this.config = config;
    this.client = client;
    this.dispatch = dispatch;
    this.intentInterpreter = intentInterpreter;
    this.chatResponder = chatResponder;
    this.sessionStore = sessionStore;
    this.evolution = evolution;
    this.logger = logger;
    this.wsClient = null;
  }

  async start() {
    if (!this.config.feishu.longConnectionEnabled) {
      return;
    }

    if (!this.config.feishu.appId || !this.config.feishu.appSecret) {
      this.logger.warn("Skip Feishu long connection because app credentials are incomplete.");
      return;
    }

    const preflight = await this.validateConnectionConfig();
    if (!preflight.ok) {
      this.logger.error("Feishu long connection preflight failed.", preflight.meta);
      return;
    }

    this.wsClient = new Lark.WSClient({
      appId: this.config.feishu.appId,
      appSecret: this.config.feishu.appSecret,
      loggerLevel: Lark.LoggerLevel.info
    });

    const dispatcher = new Lark.EventDispatcher({
      verificationToken: this.config.feishu.verificationToken || undefined,
      encryptKey: this.config.feishu.encryptKey || undefined
    });
    dispatcher.register({
      "im.message.receive_v1": async (payload) => {
        this.logger.info("Feishu long connection received im.message.receive_v1.", {
          messageId: payload?.message?.message_id || "",
          chatId: payload?.message?.chat_id || ""
        });
        void this.handleMessage(payload).catch((error) => {
          this.logger.error("Feishu long connection message handling failed.", {
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }
    });

    void this.wsClient.start({
      eventDispatcher: dispatcher
    });

    const cleanup = () => {
      try {
        this.wsClient?.close?.();
      } catch (error) {
        this.logger.warn("Failed to close Feishu WS client cleanly.", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    };
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);

    this.logger.info("Feishu long connection started.");
  }

  async validateConnectionConfig() {
    try {
      const response = await Lark.defaultHttpInstance.request({
        method: "post",
        url: "https://open.feishu.cn/callback/ws/endpoint",
        data: {
          AppID: this.config.feishu.appId,
          AppSecret: this.config.feishu.appSecret
        },
        headers: {
          locale: "zh"
        },
        timeout: 15_000
      });

      const code = Number(response?.code || 0);
      if (code !== 0) {
        return {
          ok: false,
          meta: {
            code,
            msg: response?.msg || "unknown error",
            hint: "请确认 FEISHU_APP_ID 和 FEISHU_APP_SECRET 来自同一个飞书应用，并且使用的是当前最新的 App Secret。"
          }
        };
      }

      const url = response?.data?.URL || "";
      if (!url) {
        return {
          ok: false,
          meta: {
            code: 0,
            msg: "ws endpoint returned empty URL",
            hint: "飞书长连接配置接口返回成功但没有 URL，请检查应用事件订阅是否已启用长连接并已添加 im.message.receive_v1。"
          }
        };
      }

      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        meta: {
          msg: error instanceof Error ? error.message : String(error),
          hint: "访问飞书长连接配置接口失败，请检查网络、代理和飞书应用配置。"
        }
      };
    }
  }

  async handleMessage(event) {
    const senderType = String(event.sender?.sender_type || "").toLowerCase();
    const senderAppId = String(event.sender?.sender_id?.app_id || "");
    if (senderType === "app" || (senderAppId && senderAppId === this.config.feishu.appId)) {
      this.logger.info("Ignore self-sent Feishu message.", {
        messageId: event.message?.message_id || "",
        senderType,
        senderAppId
      });
      return;
    }

    const messageId = event.message?.message_id || "";
    const text = extractMessageText(event.message?.content);
    this.logger.info("Feishu message parsed.", {
      text,
      messageType: event.message?.message_type || "",
      chatId: event.message?.chat_id || ""
    });

    const messageContext = {
      chatId: event.message?.chat_id || "",
      openId: event.sender?.sender_id?.open_id || "",
      replyMode: "app"
    };
    const userId = event.sender?.sender_id?.open_id || "";
    const sessionId = messageContext.chatId || messageContext.openId || userId || "default";
    const session = await this.sessionStore.get(sessionId);
    const reactionId = await this.client.addMessageReaction(messageId, "THINKING");

    if (isDissatisfactionMessage(text)) {
      await this.evolution?.recordIncident({
        type: "user_dissatisfaction",
        summary: text,
        userText: text,
        sessionId,
        meta: {
          lastIntent: session.lastIntent || "",
          lastTask: session.lastTask || "",
          lastAssistantText: session.lastAssistantText || ""
        }
      });
    }

    try {
      const command = await this.intentInterpreter.interpret(text, session);
      if (command.type === "ignore") {
        return;
      }

      if (command.type === "help") {
        await this.sessionStore.update(sessionId, { lastIntent: "help" });
        this.logger.info("Handling Feishu help command.", { messageContext });
        await this.client.replyText(messageContext, formatHelp());
        this.logger.info("Handled Feishu help command.", { messageContext });
        return;
      }

      if (command.type === "agents") {
        await this.sessionStore.update(sessionId, { lastIntent: "agents" });
        this.logger.info("Handling Feishu agents command.", { messageContext });
        const agents = await this.dispatch.listAgents();
        await this.client.replyCard(
          messageContext,
          buildAgentsCard(agents, this.config.agentId),
          formatAgents(agents, this.config.agentId)
        );
        this.logger.info("Handled Feishu agents command.", { messageContext });
        return;
      }

      if (command.type === "status") {
        await this.sessionStore.update(sessionId, {
          lastIntent: "status",
          lastJobId: command.jobId || session.lastJobId || ""
        });
        this.logger.info("Handling Feishu status command.", { messageContext, jobId: command.jobId || "" });
        const job = command.jobId ? await this.dispatch.lookupStatus(command.jobId) : null;
        if (job) {
          await this.client.replyCard(messageContext, buildJobCard(job, "status"), formatStatus(job));
        } else {
          await this.client.replyText(messageContext, `未找到任务: ${command.jobId}`);
        }
        this.logger.info("Handled Feishu status command.", { messageContext, jobId: command.jobId || "" });
        return;
      }

      if (command.type === "jobs") {
        await this.sessionStore.update(sessionId, { lastIntent: "jobs" });
        this.logger.info("Handling Feishu jobs overview.", { messageContext });
        const jobs = await this.dispatch.listJobs(10);
        await this.client.replyText(messageContext, formatJobsOverview(jobs, this.config.agentId));
        this.logger.info("Handled Feishu jobs overview.", { messageContext });
        return;
      }

      if (command.type === "chat") {
        await this.sessionStore.update(sessionId, { lastIntent: "chat" });
        this.logger.info("Handling Feishu chat reply.", { messageContext });
        let replyText = command.replyText || "";
        try {
          replyText = replyText || (await this.chatResponder.reply(text, session));
        } catch (error) {
          this.logger.warn("Feishu chat reply timed out or failed; using fallback reply.", {
            error: error instanceof Error ? error.message : String(error),
            messageContext
          });
          await this.evolution?.recordIncident({
            type: "chat_timeout",
            summary: text,
            userText: text,
            sessionId,
            meta: {
              error: error instanceof Error ? error.message : String(error),
              lastIntent: session.lastIntent || "",
              lastTask: session.lastTask || ""
            }
          });
          replyText = "我看到了，这条我刚才处理卡住了。你可以直接再发一次，或者我现在也可以先按我理解的方向继续接着做。";
        }
        await this.sessionStore.rememberChat(sessionId, {
          userText: text,
          assistantText: replyText
        });
        await this.client.replyText(messageContext, replyText);
        this.logger.info("Handled Feishu chat reply.", { messageContext });
        return;
      }

      if (!command.task) {
        await this.client.replyText(messageContext, "缺少任务内容。\n\n" + formatHelp());
        return;
      }

      const dispatchResult = await this.dispatch.dispatchRun({
        agentId: command.options.agent || "",
        task: command.task,
        repo: command.options.repo || "",
        model: command.options.model || "",
        messageContext,
        metadata: {
          channel: "feishu-ws",
          userId
        },
        userId
      });

      await this.sessionStore.rememberRun(sessionId, {
        agentId: dispatchResult.job?.metadata?.agentId || command.options.agent || this.config.agentId,
        repo: command.options.repo || session.lastRepo || "",
        model: command.options.model || session.lastModel || "",
        task: command.task,
        jobId: dispatchResult.job?.id || "",
        assistantText: dispatchResult.message || ""
      });

      this.logger.info("Handling Feishu run command reply.", {
        messageContext,
        jobMessage: dispatchResult.message
      });
      await this.client.replyText(messageContext, dispatchResult.message);
      this.logger.info("Handled Feishu run command reply.", { messageContext });
    } finally {
      await this.client.removeMessageReaction(messageId, reactionId);
    }
  }
}

function isDissatisfactionMessage(text) {
  return /(没回复|不回复|对不上|答非所问|乱回|太AI|太 ai|不像人话|不对|不行|有问题|听不懂|看不懂|抓的不对|你没懂|你理解错|你又|还是不对)/i.test(
    String(text || "")
  );
}

function extractMessageText(content) {
  if (!content) {
    return "";
  }

  try {
    const parsed = JSON.parse(content);
    return parsed.text || "";
  } catch {
    return "";
  }
}
