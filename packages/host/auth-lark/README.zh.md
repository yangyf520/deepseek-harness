# @deepseek-ai/dsh-host-auth-lark

[English](README.md) | 中文

飞书 / Lark OAuth 登录提供方，配合 [`auth-gateway`](../auth-gateway/)。证明身份、将 `en_name` 映射为 `subject`，调用 `ctx.auth.establish`。不管理 cookie、worker 或反向代理。

## 启动

```sh
pnpm run build
pnpm dsh plugin --profile lark-gateway add <absolute-path-to-packages/host/auth-lark>
pnpm dsh --profile lark-gateway
```

`.env`：`LARK_APP_SECRET`、`LARK_AUTH_COOKIE_SECRET`。回调：`http://127.0.0.1:3080/auth/lark/callback`。可选 `LARK_HOME_ROOT`。用户目录：`homeRoot/lark/<en_name>/`。

## Model Experience

None, as this package never assembles a model request; the per-user worker owns sessions and tools.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **主体是飞书 `en_name`** — 没有可作目录名的 `en_name` 时无法登录。
- **中国区 Open Platform URL 固定。**
- **隔离能力上限** — 见 [`auth-gateway`](../auth-gateway/README.md#known-limitations-and-deferred-work)。
