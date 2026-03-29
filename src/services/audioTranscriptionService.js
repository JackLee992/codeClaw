import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const WORKER_REQUEST_TIMEOUT_MS = 120_000;

export class AudioTranscriptionService {
  constructor({ config, client, logger }) {
    this.config = config;
    this.client = client;
    this.logger = logger;
    this.worker = null;
    this.workerRequestChain = Promise.resolve();
    this.workerRequestId = 0;
  }

  isEnabled() {
    return Boolean(this.config.audio?.transcriptionEnabled);
  }

  async warmUp() {
    if (!this.isEnabled()) {
      return;
    }

    await this.ensureWorker();
  }

  async close() {
    const worker = this.worker;
    if (!worker) {
      return;
    }

    this.worker = null;
    worker.closed = true;
    this.stopWorker(worker);
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
      const downloadStartedAt = Date.now();
      // Feishu voice messages are downloaded through the generic file resource type.
      await this.client.downloadMessageResource(messageId, fileKey, downloadedPath, "file");
      const downloadMs = Date.now() - downloadStartedAt;

      const normalizeStartedAt = Date.now();
      await runCommand("ffmpeg", ["-y", "-i", downloadedPath, "-ac", "1", "-ar", "16000", wavPath], this.logger);
      const normalizeMs = Date.now() - normalizeStartedAt;

      const transcribeStartedAt = Date.now();
      const payload = await withTimeout(
        this.enqueueWorkerRequest({
          audioPath: wavPath,
          language
        }),
        WORKER_REQUEST_TIMEOUT_MS,
        "audio transcription worker timed out"
      );
      const transcribeMs = Date.now() - transcribeStartedAt;

      const text = String(payload?.text || "").trim();
      if (!text) {
        throw new Error("transcription returned empty text");
      }

      this.logger.info("Audio transcription completed.", {
        messageId,
        duration,
        textPreview: text.slice(0, 120),
        downloadMs,
        normalizeMs,
        transcribeMs,
        workerPid: this.worker?.child?.pid || 0
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

  async enqueueWorkerRequest({ audioPath, language }) {
    const run = async () => {
      const worker = await this.ensureWorker();
      return this.sendWorkerRequest(worker, {
        audioPath,
        language
      });
    };

    const requestPromise = this.workerRequestChain.then(run, run);
    this.workerRequestChain = requestPromise.catch(() => {});
    return requestPromise;
  }

  async ensureWorker() {
    if (this.worker) {
      return this.worker.readyPromise;
    }

    const scriptPath = path.join(process.cwd(), "scripts", "transcribe_audio.py");
    const startedAt = Date.now();
    const child = spawn(
      this.config.audio.pythonCommand,
      [scriptPath, "--worker", "--model-path", this.config.audio.whisperModelPath],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8"
        }
      }
    );

    let resolveReady;
    let rejectReady;
    const readyPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const worker = {
      child,
      readyPromise,
      resolveReady,
      rejectReady,
      stdoutBuffer: "",
      stderrBuffer: "",
      pending: new Map(),
      ready: false,
      startedAt,
      closed: false
    };

    this.worker = worker;

    child.stdout.on("data", (chunk) => {
      worker.stdoutBuffer += chunk.toString();
      const lines = worker.stdoutBuffer.split(/\r?\n/);
      worker.stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        this.handleWorkerLine(worker, line);
      }
    });

    child.stderr.on("data", (chunk) => {
      worker.stderrBuffer += chunk.toString();
      worker.stderrBuffer = worker.stderrBuffer.slice(-4000);
    });

    child.on("error", (error) => {
      this.handleWorkerFailure(worker, error);
    });

    child.on("close", (code, signal) => {
      const details = [
        `audio transcription worker exited`,
        code !== null ? `code=${code}` : "",
        signal ? `signal=${signal}` : "",
        worker.stderrBuffer ? `stderr=${worker.stderrBuffer.trim()}` : ""
      ]
        .filter(Boolean)
        .join(" ");
      this.handleWorkerFailure(worker, new Error(details));
    });

    return readyPromise;
  }

  handleWorkerLine(worker, line) {
    const trimmed = String(line || "").trim();
    if (!trimmed) {
      return;
    }

    const payload = safeParseJson(trimmed);
    if (!payload) {
      this.logger.warn("Audio transcription worker emitted non-JSON line.", {
        line: trimmed.slice(0, 300)
      });
      return;
    }

    if (payload.event === "ready") {
      worker.ready = true;
      this.logger.info("Audio transcription worker ready.", {
        pid: worker.child.pid || 0,
        startupMs: Date.now() - worker.startedAt,
        device: payload.device || "",
        dtype: payload.dtype || ""
      });
      worker.resolveReady(worker);
      return;
    }

    const requestId = String(payload.id || "").trim();
    if (!requestId) {
      this.logger.warn("Audio transcription worker returned a response without request id.", {
        payload
      });
      return;
    }

    const pending = worker.pending.get(requestId);
    if (!pending) {
      this.logger.warn("Audio transcription worker returned an unknown request id.", {
        requestId
      });
      return;
    }

    worker.pending.delete(requestId);
    if (payload.ok) {
      pending.resolve(payload);
      return;
    }

    pending.reject(new Error(String(payload.error || "audio transcription worker failed")));
  }

  handleWorkerFailure(worker, error) {
    if (worker.closed) {
      return;
    }

    worker.closed = true;
    if (this.worker === worker) {
      this.worker = null;
    }

    this.stopWorker(worker);

    worker.rejectReady(error);
    for (const pending of worker.pending.values()) {
      pending.reject(error);
    }
    worker.pending.clear();

    this.logger.warn("Audio transcription worker stopped.", {
      error: error instanceof Error ? error.message : String(error)
    });
  }

  stopWorker(worker) {
    try {
      worker.child.stdin.end();
    } catch {}
    try {
      worker.child.stdin.destroy();
    } catch {}
    try {
      worker.child.kill();
    } catch {}
  }

  sendWorkerRequest(worker, { audioPath, language }) {
    const requestId = `audio-${Date.now()}-${(this.workerRequestId += 1)}`;

    return new Promise((resolve, reject) => {
      worker.pending.set(requestId, {
        resolve,
        reject
      });

      const payload = JSON.stringify({
        id: requestId,
        audio_path: audioPath,
        language
      });

      worker.child.stdin.write(`${payload}\n`, "utf8", (error) => {
        if (!error) {
          return;
        }

        worker.pending.delete(requestId);
        reject(error);
      });
    });
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

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise.finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(message));
      }, timeoutMs);
    })
  ]);
}
