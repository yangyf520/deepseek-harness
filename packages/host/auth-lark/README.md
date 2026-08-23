# @deepseek-ai/dsh-host-auth-lark

English | [中文](README.zh.md)

Lark login gateway (`Auth`, `ctx.auth`). OAuth, cookie session, one worker per user with isolated `DSH_HOME`, reverse-proxy of `/` and `/api`. Compose with `webserver` + `credentials-local` only — not `dsh-base` or `frontend-static`.

## Start

The `lark-gateway` profile template ships with empty `bundles` (no `dsh-base`). First use creates that empty profile under `~/.dsh/profiles/lark-gateway`.

```sh
pnpm run build   # once; workers need apps/cli/lib/bin.js
pnpm dsh plugin --profile lark-gateway add <absolute-path-to-packages/host/auth-lark>   # once
pnpm dsh --profile lark-gateway
```

If `pnpm` refuses the workspace root check:

```sh
cd ~/.dsh/profiles/lark-gateway
pnpm add --ignore-workspace-root-check link:/ABS/packages/host/auth-lark
```

Set `LARK_APP_SECRET` and `LARK_AUTH_COOKIE_SECRET` in `.env`. Feishu callback: `http://127.0.0.1:3080/auth/lark/callback`. Optional `LARK_HOME_ROOT` overrides the default per-user directory (`~/.dsh-lark-users`); use a local path if that directory hangs or lives on slow storage.

After changing gateway code or `homeRoot`, visit `/auth/logout` and sign in again — OAuth codes are one-time and profile fields are filled on callback, not from an old cookie alone.

Single-user web: `pnpm dsh web` (do not install this plugin).

After login, `GET /auth/me` returns `issuer`, `subject` (Feishu `en_name` / AD account), display `name`, `openId`, and other `user_info` fields (`avatarUrl`, `unionId`, plus `email`/`mobile` when scopes allow). Per-user homes live under `homeRoot/lark/<en_name>/`.

On an old profile that still lists `dsh-base`, clear `bundles` to `[]`, then re-add the plugin.

## Model Experience

None, as the gateway never assembles a model request; the per-user worker owns sessions and tools.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **A worker for the same uid can still `cat` another user's files unless `workerCommand` confines the process** — UI and model context stay inside that worker's `DSH_HOME`; OS-level reads need bwrap/Landlock/Seatbelt or a separate Unix user.
- **Subject is Feishu `en_name`** — users without a filesystem-safe `en_name` cannot log in; old `open_id` home directories are not migrated.
- **China-region Open Platform URLs are fixed.**
- **One gateway process spawns workers** — no multi-gateway lock on `homeRoot`.
