import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export class AudioTranscriptionService {
  constructor({ config, client, logger }) {
    this.config = config;
    this.client = client;
    this.logger = logger;
  }

  isEnabled() {
    return Boolean(this.config.audio?.transcriptionEnabled);
  }

  async transcribeFeishuAudio({ messageId, fileKey, duration = "", language = "zh" }) {
    if (!this.isEnabled()) {
      throw new Error("audio transcription is disabled");
    }

    if (!messageId || !fileKey) {
      throw new Error("missing messageId or fileKey for audio transcription");
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeclaw-audio-"));
    const downloadedPath = path.join(tempDir, "feishu-audio.ogg");
    const wavPath = path.join(tempDir, "feishu-audio.wav");

    try {
      // Feishu voice messages are downloaded through the generic file resource type.
      await this.client.downloadMessageResource(messageId, fileKey, downloadedPath, "file");
      await runCommand("ffmpeg", ["-y", "-i", downloadedPath, "-ac", "1", "-ar", "16000", wavPath], this.logger);
      const result = await runCommand(
        this.config.audio.pythonCommand,
        [
          path.join(process.cwd(), "scripts", "transcribe_audio.py"),
          "--audio-path",
          wavPath,
          "--model-path",
          this.config.audio.whisperModelPath,
          "--language",
          language
        ],
        this.logger,
        {
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8"
        }
      );

      const payload = safeParseJson(result.stdout);
      const text = String(payload?.text || "").trim();
      if (!text) {
        throw new Error("transcription returned empty text");
      }

      this.logger.info("Audio transcription completed.", {
        messageId,
        duration,
        textPreview: text.slice(0, 120)
      });

      return {
        text,
        meta: {
          duration,
          language
        }
      };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function safeParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function runCommand(command, args, logger, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...envOverrides
      }
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      logger?.warn?.("Audio transcription command failed.", {
        command,
        args,
        code,
        stderr: stderr.slice(-1000)
      });
      reject(new Error(`${command} exited with code ${code}: ${stderr || stdout}`.trim()));
    });
  });
}
