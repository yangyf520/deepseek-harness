# @deepseek-ai/dsh-host-auth-gateway

English | [中文](README.zh.md)

Multi-user auth gateway (`Auth`, `ctx.auth`). Cookie session, one worker per `(issuer, subject)` with isolated `DSH_HOME`, reverse-proxy of `/` and `/api`. Login providers call `establish` after proving identity. Compose with `webserver` + `credentials-local` only.

## Start

Installed with a login provider (Feishu: add [`auth-lark`](../auth-lark/), which mounts this gateway in its patch):

```sh
pnpm run build
pnpm dsh plugin --profile lark-gateway add <absolute-path-to-packages/host/auth-lark>
pnpm dsh --profile lark-gateway
```

Config: `homeRoot` (absolute), `cookieSecretEnv`, optional `workerCommand`, `workerReadyTimeoutMs`. Homes: `homeRoot/<issuer>/<subject>/`.

## User isolation

After login, routing and `DSH_HOME` are keyed by principal — independent of which provider authenticated. Each user's file workspace is `homeRoot/<issuer>/<subject>/projects/` (the worker's `cwd`, `DSH_CWD`, and sandbox `workspaceRoot`). Default is application-layer isolation (L2). OS-level reads need `workerCommand`. The Harness repository checkout is not a user workspace boundary.

## Model Experience

None, as the gateway never assembles a model request; the per-user worker owns sessions and tools.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Same-uid workers can still `cat` other users' files unless `workerCommand` confines the process.**
- **Unauthenticated redirect uses the first registered login path** — no multi-issuer chooser yet.
- **One gateway process spawns workers** — no multi-gateway lock on `homeRoot`.
