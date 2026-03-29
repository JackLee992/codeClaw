import { formatAgents, formatHelp, formatStatus } from "./messageFormatter.js";

export class IngestService {
  constructor({ config, store, dispatch, intentInterpreter, chatResponder }) {
    this.config = config;
    this.store = store;
    this.dispatch = dispatch;
    this.intentInterpreter = intentInterpreter;
    this.chatResponder = chatResponder;
  }

  async handle(req, res) {
    this.verify(req);

    const text = String(req.body?.text || "").trim();
    const command = await this.intentInterpreter.interpret(text);
    if (command.type === "ignore") {
      return res.status(400).json({
        code: 400,
        msg: "missing text"
      });
    }

    if (command.type === "help") {
      return res.json({
        code: 0,
        message: formatHelp()
      });
    }

    if (command.type === "agents") {
      const agents = await this.dispatch.listAgents();
      return res.json({
        code: 0,
        agents,
        message: formatAgents(agents, this.config.agentId)
      });
    }

    if (command.type === "status") {
      const job = command.jobId ? await this.dispatch.lookupStatus(command.jobId) : null;
      return res.json({
        code: 0,
        job: job || null,
        message: job ? formatStatus(job) : `未找到任务: ${command.jobId}`
      });
    }

    if (command.type === "chat") {
      return res.json({
        code: 0,
        message: command.replyText || (await this.chatResponder.reply(text))
      });
    }

    if (!command.task) {
      return res.status(400).json({
        code: 400,
        msg: "missing task text",
        help: formatHelp()
      });
    }

    const { job, message } = await this.dispatch.dispatchRun({
      agentId: req.body?.agentId || command.options.agent || "",
      task: command.task,
      repo: command.options.repo || "",
      repoPath: req.body?.repoPath || "",
      model: req.body?.model || command.options.model || "",
      messageContext: {
        replyMode: req.body?.replyWebhook ? "webhook" : "none",
        replyWebhook: req.body?.replyWebhook || "",
        chatId: req.body?.chatId || "",
        openId: req.body?.openId || ""
      },
      metadata: {
        channel: req.body?.channel || "relay",
        userId: req.body?.userId || ""
      },
      userId: req.body?.userId || ""
    });
    return res.json({
      code: 0,
      job,
      message
    });
  }

  verify(req) {
    if (!this.config.bridgeSharedToken) {
      return;
    }

    const headerToken = req.header("x-bridge-token") || "";
    const bodyToken = req.body?.token || "";
    if (headerToken !== this.config.bridgeSharedToken && bodyToken !== this.config.bridgeSharedToken) {
      throw new Error("bridge token mismatch");
    }
  }
}
