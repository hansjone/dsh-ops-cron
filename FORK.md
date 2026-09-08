# dsh-ops-cron（运维 fork）

本仓库是 [Whale-Zhang/dsh-cron-tasks](https://github.com/Whale-Zhang/dsh-cron-tasks) 的 **运维 fork**，用于：

- Agent 自建定时任务（`cron_create` / `cron_list` / …）
- 按创建来源默认投递：**WhatsApp 会话 → IM**；**Web/DSH 会话 → 侧栏新会话**
- 与 [dsh-im-ops](https://github.com/hansjone/dsh-im-ops) 的 `ctx.dshIm.send(botId, targetId, text)` 打通
- 可选会话镜像（默认关闭）：`mirrorToSession` / `mirror_to_session=true` 时才把摘要写入创建时的有效会话（Web / WhatsApp 绑定会话）

不要与上游 `@dsh-external/dsh-cron-tasks` 装进同一 profile（工具名冲突）。

## 安装

```powershell
# 建议顺序：先 im，再 cron
dsh plugin --profile web add -w "github:hansjone/dsh-im-ops"
dsh plugin --profile web add -w "github:hansjone/dsh-ops-cron"
# 重启 dsh web
```

本地开发：

```powershell
dsh plugin --profile web add -w "D:\project\chatgpt\dsh-ops-cron"
```

## 相对上游的改动

1. 包名 / cordis id / HTTP 前缀仍为 `dsh-ops-cron`；侧栏产品文案为「定时任务」
2. Job 增加 `delivery: { kind: 'dsh'|'im', botId?, targetId? }`
3. Job 增加 `origin: { kind: 'web'|'im', sessionId?, peer? }`（创建时钉死；IM 开火时优先按 `conversationKey` 解析当前绑定会话）
4. Job 增加 `mirrorToSession: boolean`（默认 `false`；侧栏勾选 / `cron_create` 的 `mirror_to_session`）
5. `cron_create` 支持 `delivery` / `im_bot_id` / `im_target_id`；未显式指定时，若当前会话能 `resolveSessionPeer` 且已有匹配投递目标 → 默认 IM
6. 开火后若 `delivery.kind === 'im'`，把 assistant 摘要经 `ctx.dshIm.send` 投回
7. 开火终态且 `mirrorToSession === true` 时，把同构摘要镜像进有效会话（`agents.get` 或 `agents.resume` 后 `session.append`，不另开一轮模型；不用 `agents.create`，避免覆盖已有会话）

## 执行会话 vs 有效会话

| 角色 | 是什么 | 用途 |
|------|--------|------|
| 执行会话 | 每次开火新建的 root Session（侧栏历史可打开） | 跑 Agent、保留工具轨迹 |
| 有效会话 | 创建时的 Web 会话，或 WhatsApp/IM `conversationKey` 当前绑定的 Session | 用户日常追问所在处；仅当 `mirrorToSession` 开启时才写入摘要 |

`dshIm.send` 只保证平台侧可见，不会自动写 Harness 会话日志；镜像是 cron 层可选的额外一步。

关键告警推送仍在 **netxops**，不经过本插件。
