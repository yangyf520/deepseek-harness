# @deepseek-ai/dsh-client-ui-auth

English | [中文](README.zh.md)

Sidebar account chip for the multi-user auth gateway. Occupies `sidebar.footer.action` (the list above Settings). Reads `GET /auth/me` and renders avatar, name, and logout; when that route is absent or unauthenticated the chip renders nothing, so ordinary `dsh --profile web` is unchanged.

Logout calls `GET /auth/logout` then navigates to `/`. The node half is an empty Loader seat.

## Model Experience

None, as the package contributes browser presentation only; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Visible only behind the auth gateway** — `/auth/me` is a gateway route; a worker served without the gateway never shows the chip.
- **Logout is a full page load** — the gateway clears the cookie and the next `/` request restarts Feishu OAuth.
