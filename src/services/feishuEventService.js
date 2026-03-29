import { parseCommand } from "./commandParser.js";
import { decryptFeishuPayload } from "./feishuCrypto.js";
import { formatAgents, formatHelp, formatStatus } from "./messageFormatter.js";
import { buildAgentsCard, buildJobCard } from "./cardRenderer.js";

export class FeishuEventService {
  constructor({ config, client, dispatch }) {
    this.config = config;
    this.client = client;
    this.dispatch = dispatch;
  }

  async handle(req, res) {
    const body = this.normalizePayload(req.body || {});

    if (body.type === "url_verification") {
      return res.json({ challenge: body.challenge });
    }

    this.verify(body);

    const event = body.event || {};
    if (body.type !== "event_callback" || event.type !== "im.message.receive_v1") {
      return res.json({ code: 0 });
    }

    const text = extractMessageText(event.message);
    const command = parseCommand(text);
    const messageContext = {
      chatId: event.message?.chat_id || "",
      openId: event.sender?.sender_id?.open_id || "",
      replyMode: "app"
    };

    if (command.type === "ignore") {
      return res.json({ code: 0 });
    }

    if (command.type === "help") {
      await this.client.replyText(messageContext, formatHelp());
      return res.json({ code: 0 });
    }

    if (command.type === "agents") {
      const agents = await this.dispatch.listAgents();
      await this.client.replyCard(
        messageContext,
        buildAgentsCard(agents, this.config.agentId),
        formatAgents(agents, this.config.agentId)
      );
      return res.json({ code: 0 });
    }

    if (command.type === "status") {
      const job = command.jobId ? await this.dispatch.lookupStatus(command.jobId) : null;
      const text = job ? formatStatus(job) : `未找到任务: ${command.jobId}`;

      if (job) {
        await this.client.replyCard(messageContext, buildJobCard(job, "status"), text);
      } else {
        await this.client.replyText(messageContext, text);
      }
      return res.json({ code: 0 });
    }

    if (!command.task) {
      await this.client.replyText(messageContext, "缺少任务内容。\n\n" + formatHelp());
      return res.json({ code: 0 });
    }

    const dispatchResult = await this.dispatch.dispatchRun({
      agentId: command.options.agent || "",
      task: command.task,
      repo: command.options.repo || "",
      model: command.options.model || "",
      messageContext,
      metadata: {
        channel: "feishu-app",
        userId: event.sender?.sender_id?.open_id || ""
      },
      userId: event.sender?.sender_id?.open_id || ""
    });

    await this.client.replyText(messageContext, dispatchResult.message);

    return res.json({ code: 0 });
  }

  normalizePayload(body) {
    if (body.encrypt) {
      return decryptFeishuPayload(this.config.feishu.encryptKey, body.encrypt);
    }

    return body;
  }

  verify(body) {
    const token = this.config.feishu.verificationToken;
    if (token && body.header?.token && body.header.token !== token) {
      throw new Error("飞书 verification token 不匹配。");
    }
  }
}

function extractMessageText(message) {
  if (!message?.content) {
    return "";
  }

  try {
    const parsed = JSON.parse(message.content);
    return parsed.text || "";
  } catch {
    return "";
  }
}
