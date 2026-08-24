# @deepseek-ai/dsh-client-ui-auth

[English](README.md) | 中文

多用户认证网关的侧栏账号条。占用 `sidebar.footer.action`（Settings 上方的 list）。读取 `GET /auth/me`，渲染头像、姓名和退出；该路由不存在或未登录时不渲染，因此普通 `dsh --profile web` 外观不变。

退出调用 `GET /auth/logout` 然后跳到 `/`。node 半边是空的 Loader seat。

## 模型体验

无，因为本包只贡献浏览器呈现；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与暂缓事项

- **仅在认证网关后可见** — `/auth/me` 是网关路由；没有网关的 worker 不会显示该条。
- **退出是整页跳转** — 网关清 cookie 后，下一次 `/` 会重新走飞书 OAuth。
