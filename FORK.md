# dsh-ops-cron（运维 fork）

本仓库是 [Whale-Zhang/dsh-cron-tasks](https://github.com/Whale-Zhang/dsh-cron-tasks) 的 **运维 fork**，用于：

- Agent 自建定时任务（`cron_create` / `cron_list` / …）
- 按创建来源默认投递：**WhatsApp 会话 → IM**；**Web/DSH 会话 → 侧栏新会话**
- 与 [dsh-im-ops](https://github.com/hansjone/dsh-im-ops) 的 `ctx.dshIm.send(botId, targetId, text)` 打通

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

1. 包名 / cordis id / HTTP 前缀 / 侧栏文案 → `dsh-ops-cron` /「运维定时」
2. Job 增加 `delivery: { kind: 'dsh'|'im', botId?, targetId? }`
3. `cron_create` 支持 `delivery` / `im_bot_id` / `im_target_id`；未显式指定时，若当前会话能 `resolveSessionPeer` 且已有匹配投递目标 → 默认 IM
4. 开火后若 `delivery.kind === 'im'`，把 assistant 摘要经 `ctx.dshIm.send` 投回

关键告警推送仍在 **netxops**，不经过本插件。
