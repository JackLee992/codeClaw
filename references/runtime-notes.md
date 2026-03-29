# Runtime Notes

This document summarizes the current Feishu bridge runtime architecture after
recent performance work, and it also records the main limitations that remain.

## Current Runtime Shape

### Voice Transcription

- Feishu voice messages are downloaded through the message resource API using
  resource type `file`.
- Audio is normalized with `ffmpeg` to mono `16k wav`.
- A persistent Python worker keeps the local Whisper pipeline warm so repeated
  voice messages avoid model cold-start cost.
- The bridge logs per-step transcription timing such as `downloadMs`,
  `normalizeMs`, and `transcribeMs`.

Relevant files:

- `src/services/audioTranscriptionService.js`
- `scripts/transcribe_audio.py`

### Intent Routing

- The bridge first applies heuristic intent routing for obvious local-computer
  actions, job-status questions, and common follow-up phrases.
- If heuristics are not confident enough, the bridge falls back to a Codex
  intent-routing prompt.
- Follow-up turns are currently represented by appending `补充要求：...` to the
  previous run task.

Relevant file:

- `src/services/intentInterpreter.js`

### Execution

- The executor now has two layers:
  - A fast-path desktop executor for a small set of deterministic actions.
  - A general Codex executor for everything else.
- The fast-path currently covers:
  - restoring recent wallpaper history
  - showing the desktop
  - opening Chrome
  - opening Chrome and searching a query
- General Codex execution reuses prior `codex exec` sessions through
  `codex exec resume` when the same chat keeps working in the same repo/model
  context.

Relevant file:

- `src/services/executors.js`

### Queueing

- Jobs still execute serially inside one local bridge process.
- When a newer job arrives in the same chat, queued-but-not-started older jobs
  can be marked as superseded and removed from the pending queue.
- Already running jobs are not preempted.

Relevant file:

- `src/queue/jobQueue.js`

## Current Limitations

### 1. Follow-up Semantics Are Still String-Based

The bridge still models many follow-up instructions by concatenating them onto
 the previous task text. This is simple and fast, but vague short commands can
inherit more context than intended.

Examples:

- `换前一张壁纸啊`
- `切换壁纸`
- `打开微信`

These are often clear to a human but may still depend too much on previous
task text inside the current bridge.

### 2. Fast-Path Desktop Coverage Is Narrow

The fast-path executor only understands a few hard-coded desktop actions. It is
not yet a broad desktop automation layer.

Known missing areas include:

- opening apps beyond Chrome
- explicit file sending flows
- screenshot capture and upload flows
- richer wallpaper selection semantics
- multi-step desktop workflows outside the small built-in set

### 3. Wallpaper Restore Uses System History, Not User Intent Memory

Wallpaper restore currently operates on Windows wallpaper history ordering.
That means a request like "换回我自己的壁纸" may still resolve to the previous
history entry rather than the wallpaper the user subjectively means.

This is especially visible when the system wallpaper history includes generated
wallpapers, theme wallpapers, or prior temporary files.

### 4. Persistent Codex Session Reuse Can Leak Old Context

`codex exec resume` improves speed for repeated tasks, but it also means later
requests can inherit conversational state from earlier jobs in the same chat.
That is good for iterative coding work, but risky for short desktop commands.

### 5. Running Jobs Are Not Yet Preempted

Queued jobs can be superseded, but once a job is already running it is allowed
to finish. This keeps execution safer, but it can still make the latest user
request feel delayed when the previous running job is now obsolete.

### 6. Logs Are Still Not Ideal for Chinese Debugging

Some `textPreview` log entries can still appear garbled in Windows terminal
logs. The runtime behavior may still be correct, but the logs are harder to
inspect than they should be.

## Practical Guidance

Right now the bridge works best when:

- desktop commands are explicit and concrete
- the user names the final desired action directly
- follow-up instructions avoid ambiguous shorthand
- deterministic desktop actions are moved into fast-path handlers over time

## Recommended Next Steps

When optimization work resumes, the highest-value next steps are:

1. Replace string-based follow-up merging with structured follow-up overrides.
2. Split desktop-automation state from long-running Codex coding sessions.
3. Expand fast-path desktop coverage beyond wallpaper/desktop/Chrome.
4. Add optional preemption for obsolete running jobs in the same chat.
5. Improve diagnostic logging for Chinese text and final action selection.
