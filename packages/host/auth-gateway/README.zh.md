# @deepseek-ai/dsh-host-auth-gateway

[English](README.md) | 中文

多用户认证网关（`Auth`，`ctx.auth`）。Cookie 会话、按 `(issuer, subject)` 起独立 `DSH_HOME` 的 worker、反向代理 `/` 与 `/api`。登录提供方在证明身份后调用 `establish`。只组合 `webserver` + `credentials-local`。

## 启动

与登录提供方一起安装（飞书：添加 [`auth-lark`](../auth-lark/)，其 patch 会挂上本网关）：

```sh
pnpm run build
pnpm dsh plugin --profile lark-gateway add <absolute-path-to-packages/host/auth-lark>
pnpm dsh --profile lark-gateway
```

配置：`homeRoot`（绝对路径）、`cookieSecretEnv`，可选 `workerCommand`、`workerReadyTimeoutMs`。用户目录：`homeRoot/<issuer>/<subject>/`。

## 用户隔离

登录后按 principal 路由并隔离 `DSH_HOME`，与具体登录提供方无关。每个用户的文件工作区是 `homeRoot/<issuer>/<subject>/projects/`（worker 的 `cwd`、`DSH_CWD` 与 sandbox `workspaceRoot` 均指向该目录）。默认是应用层隔离（L2）。操作系统级读取需要 `workerCommand`。Harness 仓库源码目录不是用户工作区边界。

## Model Experience

None, as the gateway never assembles a model request; the per-user worker owns sessions and tools.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **同一 uid 的工人仍可能 `cat` 别人的文件，除非 `workerCommand` 限制该进程。**
- **未登录重定向使用第一个已注册登录路径** — 尚无多 issuer 选择页。
- **由一个网关进程拉起工人** — `homeRoot` 上没有多网关锁。
