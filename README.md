# dsh-ops-cron

Ops fork of [dsh-cron-tasks](https://github.com/Whale-Zhang/dsh-cron-tasks) for DeepSeek Harness.

- Sidebar **运维定时** under New Session
- Agent tools: `cron_create` / `cron_list` / `cron_pause` / `cron_resume` / `cron_delete`
- Per-job delivery: **DSH** (new root session) or **IM** (`ctx.dshIm.send`)

See [FORK.md](FORK.md) for install notes. Do **not** install upstream `@dsh-external/dsh-cron-tasks` in the same profile.

## Install

```sh
dsh plugin --profile web add -w "github:hansjone/dsh-im-ops"
dsh plugin --profile web add -w "github:hansjone/dsh-ops-cron"
# restart dsh web
```

## Delivery defaults

| Created from | Default delivery |
|--------------|------------------|
| WhatsApp / IM session (peer resolved + matching 投递目标) | `im` → that `botId`+`targetId` |
| Web / plain DSH session | `dsh` → sidebar history session |
| Explicit `delivery` / `im_bot_id`+`im_target_id` | as specified |

Create IM targets first in IM → 投递设置 → 复制调用参数 when you need a stable target for WhatsApp.

## License

MIT (upstream MIT retained).
