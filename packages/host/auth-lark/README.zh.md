# @deepseek-ai/dsh-host-auth-lark

[English](README.md) | 中文

飞书登录网关（`Auth`，`ctx.auth`）。OAuth、cookie 会话、按用户 `DSH_HOME` 起 worker、反向代理 `/` 与 `/api`。只组合 `webserver` + `credentials-local`，不要挂 `dsh-base` 或 `frontend-static`。

## 启动

`lark-gateway` profile 模板自带空 `bundles`（不含 `dsh-base`）。首次使用会在 `~/.dsh/profiles/lark-gateway` 创建该空 profile。

```sh
pnpm run build   # 首次；worker 需要 apps/cli/lib/bin.js
pnpm dsh plugin --profile lark-gateway add <absolute-path-to-packages/host/auth-lark>   # 首次
pnpm dsh --profile lark-gateway
```

若 `pnpm` 因 workspace 根检查失败：

```sh
cd ~/.dsh/profiles/lark-gateway
pnpm add --ignore-workspace-root-check link:/ABS/packages/host/auth-lark
```

`.env`：`LARK_APP_SECRET`、`LARK_AUTH_COOKIE_SECRET`。飞书回调：`http://127.0.0.1:3080/auth/lark/callback`。可选 `LARK_HOME_ROOT` 覆盖默认用户目录（`~/.dsh-lark-users`）；若该目录在慢盘或访问卡住，请改成本地路径。

更新网关代码或 `homeRoot` 后，先访问 `/auth/logout` 再重新登录——授权码只能用一次，用户名等字段在 callback 写入，旧 cookie 不会自动补齐。

单用户 Web：`pnpm dsh web`（不装本插件）。

登录后 `GET /auth/me` 返回 `issuer`、`subject`（飞书 `en_name` / AD 账号）、展示名 `name`、`openId`，以及其它 `user_info` 字段（`avatarUrl`、`unionId`；开通权限时还有 `email`、`mobile`）。用户目录在 `homeRoot/lark/<en_name>/`。

旧 profile 若仍含 `dsh-base`，将 `bundles` 清为 `[]` 后重装插件。

## Model Experience

None, as the gateway never assembles a model request; the per-user worker owns sessions and tools.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **同一 uid 的工人仍可能 `cat` 别人的文件，除非 `workerCommand` 限制该进程** — UI 和模型上下文留在该工人的 `DSH_HOME` 内；操作系统级读取需要 bwrap/Landlock/Seatbelt 或单独的 Unix 用户。
- **主体是飞书 `en_name`** — 没有可作目录名的 `en_name` 时无法登录；旧的 `open_id` 用户目录不会自动迁移。
- **中国区开放平台地址是固定的。**
- **由一个网关进程拉起工人** — `homeRoot` 上没有多网关锁。
