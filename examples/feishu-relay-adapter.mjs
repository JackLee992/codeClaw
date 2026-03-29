import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

const {
  PORT = "8809",
  BRIDGE_BASE_URL = "http://127.0.0.1:8787",
  BRIDGE_SHARED_TOKEN = "",
  RELAY_SHARED_SECRET = ""
} = process.env;

app.post("/feishu/relay", async (req, res) => {
  try {
    verifyRelaySecret(req);

    const body = req.body || {};
    const text = extractText(body);
    const userId = body.user_id || body.sender?.id || "";
    const chatId = body.chat_id || body.chat?.id || "";
    const replyWebhook = body.reply_webhook || "";

    if (!text) {
      return res.status(400).json({
        code: 400,
        msg: "missing text"
      });
    }

    const response = await fetch(`${BRIDGE_BASE_URL.replace(/\/$/, "")}/ingest/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-token": BRIDGE_SHARED_TOKEN
      },
      body: JSON.stringify({
        token: BRIDGE_SHARED_TOKEN,
        channel: "feishu-relay",
        userId,
        chatId,
        text,
        replyWebhook
      })
    });

    const payload = await response.json();
    return res.status(response.ok ? 200 : 400).json(payload);
  } catch (error) {
    return res.status(400).json({
      code: 1,
      msg: error instanceof Error ? error.message : "unknown error"
    });
  }
});

app.listen(Number(PORT), () => {
  console.log(`Feishu relay adapter listening on :${PORT}`);
});

function verifyRelaySecret(req) {
  if (!RELAY_SHARED_SECRET) {
    return;
  }

  const incoming = req.header("x-relay-secret") || "";
  if (incoming !== RELAY_SHARED_SECRET) {
    throw new Error("invalid relay secret");
  }
}

function extractText(body) {
  if (typeof body.text === "string") {
    return body.text.trim();
  }

  if (typeof body.content === "string") {
    try {
      const parsed = JSON.parse(body.content);
      return typeof parsed.text === "string" ? parsed.text.trim() : "";
    } catch {
      return "";
    }
  }

  return "";
}
