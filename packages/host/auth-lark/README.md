# @deepseek-ai/dsh-host-auth-lark

English | [中文](README.zh.md)

Feishu / Lark OAuth login provider for [`auth-gateway`](../auth-gateway/). Proves identity, maps `en_name` to `subject`, calls `ctx.auth.establish`. Does not own cookies, workers, or reverse-proxy.

## Start

```sh
pnpm run build
pnpm dsh plugin --profile lark-gateway add <absolute-path-to-packages/host/auth-lark>
pnpm dsh --profile lark-gateway
```

`.env`: `LARK_APP_SECRET`, `LARK_AUTH_COOKIE_SECRET`. Callback: `http://127.0.0.1:3080/auth/lark/callback`. Optional `LARK_HOME_ROOT`. Homes: `homeRoot/lark/<en_name>/`.

## Model Experience

None, as this package never assembles a model request; the per-user worker owns sessions and tools.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Subject is Feishu `en_name`** — users without a filesystem-safe `en_name` cannot log in.
- **China-region Open Platform URLs are fixed.**
- **Isolation limits** — see [`auth-gateway`](../auth-gateway/README.md#known-limitations-and-deferred-work).
