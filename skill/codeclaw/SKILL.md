---
name: codeclaw
description: Deploy, configure, troubleshoot, or package the codeClaw Feishu bridge for Codex. Use when Codex needs to set up Feishu long-connection delivery, tune natural-chat routing, verify reactions and progress feedback, operate multi-machine dispatch, sanitize a shareable repository, or help another user install and run codeClaw on Windows or macOS.
---

# codeClaw

## Overview

Use this skill to work on `codeClaw`, a Feishu long-connection bridge that lets users chat with Codex naturally and route selected messages into real machine tasks.

## Workflow

1. Read the repository README first to understand the current packaging and deployment shape.
2. Check `.env.example` before proposing environment variables.
3. For runtime issues, inspect `src/index.js`, `src/services/feishuLongConnectionService.js`, `src/services/intentInterpreter.js`, `src/services/chatResponder.js`, `src/services/feishuClient.js`, `src/queue/jobQueue.js`, and `src/services/executors.js`.
4. When the issue is about machine routing, also inspect `src/services/dispatchService.js`, `src/services/agentHeartbeat.js`, and the store implementations under `src/store/`.
5. Keep secrets out of git. Never copy live `.env` values into docs, examples, commits, or skills.

## Operating Rules

- Prefer Feishu long connection over public webhook mode unless the user explicitly wants webhook deployment.
- Preserve the natural-chat interaction model. Do not regress the bridge back to slash-command-only behavior.
- Treat "process feel" as a first-class feature. Preserve message reactions, human-style acknowledgements, and mid-task progress updates when changing execution flow.
- Keep the bridge safe by restricting repo roots, user ACLs, and machine targets.
- When preparing a repo for sharing, remove local logs, `.env`, machine-specific paths, and other secrets before committing.

## Common Tasks

### Install or run locally

- Copy `.env.example` to `.env`
- Fill in Feishu app credentials
- Set `DEFAULT_REPO_PATH` and `ALLOWED_REPO_ROOTS`
- Start with `EXECUTOR_TYPE=mock`
- Switch to `EXECUTOR_TYPE=codex-cli` only after chat delivery works

### Diagnose "bot has no response"

1. Check `/healthz`
2. Confirm the bridge process is still listening
3. Confirm long connection startup logs include `ws client ready`
4. Confirm the Feishu app secret is valid by testing token acquisition or the websocket endpoint
5. Inspect whether the inbound message reached `im.message.receive_v1`
6. Inspect whether the reply path, reactions, or progress messages failed after receipt

### Tune chat behavior

- Use `src/services/intentInterpreter.js` to control whether a message becomes `chat`, `help`, `agents`, `status`, or `run`
- Use `src/services/chatResponder.js` for natural replies that should not create jobs
- Keep obvious greetings, capability questions, and common knowledge queries on the `chat` path
- Keep explicit computer or repo work on the `run` path

### Tune execution feel

- Use `src/services/feishuClient.js` for message reactions and replies
- Use `src/queue/jobQueue.js` for progress message timing and lifecycle
- Use `src/services/executors.js` to surface better intermediate progress from executor output

## References

- Read `references/deployment.md` when you need a deployment checklist or release packaging guidance.
