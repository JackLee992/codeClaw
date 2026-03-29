# codeClaw Deployment Notes

## Single-Machine Deployment

Use this shape when one machine both receives Feishu messages and executes Codex tasks.

- `BRIDGE_ROLE=hybrid`
- `COORDINATOR_URL=` empty
- `AGENT_ID` unique on the local network
- `FEISHU_LONG_CONNECTION_ENABLED=true`

## Multi-Machine Deployment

Use one coordinator plus one or more workers.

Coordinator:

- receives Feishu messages
- keeps the visible online node list
- dispatches remote jobs

Worker:

- runs the same service
- points `COORDINATOR_URL` at the coordinator
- shares `INTERNAL_SHARED_TOKEN`
- has its own `AGENT_ID`

## Packaging Checklist

Before publishing:

- exclude `.env`
- exclude `logs/`
- exclude `node_modules/`
- remove machine-specific IPs from docs unless they are examples
- replace local repo paths with placeholders
- keep `.env.example` generic
- ensure README explains Feishu app setup and long connection requirements

## Runtime Checklist

- confirm `http://127.0.0.1:8787/healthz`
- confirm startup logs include `ws client ready`
- confirm Feishu inbound message logs appear
- confirm reaction add/remove logs appear
- confirm chat replies and execution feedback both return to Feishu
