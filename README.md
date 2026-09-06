# dsh-ops-cron

Scheduled-task plugin for DeepSeek Harness (fork of [dsh-cron-tasks](https://github.com/Whale-Zhang/dsh-cron-tasks)).

- Sidebar **定时任务** under New Session
- Agent tools: `cron_create` / `cron_list` / `cron_pause` / `cron_resume` / `cron_delete`
- Per-job delivery: **DSH** (new root session) or **IM** (`ctx.dshIm.send`)
- After each fire, mirrors the summary into the **origin effective session** (creator Web chat or WhatsApp peer binding) so follow-ups share context

See [FORK.md](FORK.md) for install notes. Do **not** install upstream `@dsh-external/dsh-cron-tasks` in the same profile.

## Install

```sh
dsh plugin --profile web add -w "github:hansjone/dsh-im-ops"
dsh plugin --profile web add -w "github:hansjone/dsh-ops-cron"
# restart dsh web
```

## Delivery defaults

| Created from | Default delivery | Effective-session mirror |
|--------------|------------------|--------------------------|
| WhatsApp / IM session | `im` → reuse or **auto-create** a 投递目标 for that chat (group→group, DM→DM) | Live session for that `conversationKey` (latest binding) |
| Web / plain DSH session | `dsh` → sidebar history session | Creator session pinned as `origin.sessionId` |
| Explicit `delivery` / `im_bot_id`+`im_target_id` | as specified | Same mirror rules when `origin` / peer can be resolved |

You usually do **not** need to paste botId/targetId when creating from WhatsApp — omit `delivery` and the job binds to the current chat.

**Execution session ≠ effective session.** Each fire still opens a fresh root Session for the Agent turn (visible under 定时任务 history). The mirrored notice is what makes the WhatsApp/Web chat you actually use able to continue from the result.

## Agent preset

| Source | Behavior |
|--------|----------|
| Explicit `agent_preset` / sidebar field | pinned on the job |
| WhatsApp / IM create (omit) | inherit chat/group override → bot preset → Host default |
| Sidebar leave empty | Host default at each fire |

Scheduled runs mount `job.agentPreset` (or Host default when empty).

## License

MIT (upstream MIT retained).
