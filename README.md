# dsh-cron-tasks

[English](#english) · [中文](#zhongwen)

A DeepSeek Harness (`dsh`) plugin for **scheduled tasks**. Sidebar entry under **New Session**, plugin settings, isolated run history, and model-facing `cron_*` tools.

![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-7c3aed)
![license](https://img.shields.io/badge/license-MIT-blue)

<a id="zhongwen"></a>

## 中文

到点后 **新开一条会话** 跑事先写好的提示词，记进侧栏「定时任务」历史。这类会话不会淹没日常工作区列表。

这不是官方同会话 reminder（`@deepseek-ai/dsh-schedule`），也不是系统 `crontab`。调度器住在 DSH Host 里：Host 没在跑就不会触发。

### 安装

需要已安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。一条命令装进网页端和桌面端：

```sh
dsh plugin --profile web add github:Whale-Zhang/dsh-cron-tasks
dsh plugin --profile desktop add github:Whale-Zhang/dsh-cron-tasks
```

装完后**重启对应 profile**（`dsh web` 或 Desktop）。用下面命令应能看到 `dsh-cron-tasks`：

```sh
dsh --profile web --dump-config
```

### 卸载

```sh
dsh plugin --profile web remove @dsh-external/dsh-cron-tasks
dsh plugin --profile desktop remove @dsh-external/dsh-cron-tasks
```

### 做什么

- 左侧 **「新会话」正下方** 的 **「定时任务」** 入口：创建、暂停/恢复、删除、立即运行、搜索
- **设置 → 插件 → 插件配置** 里的调度策略（启用、默认时区、历史保留、重叠/漏跑）
- 每次触发新开 root Session；点历史记录打开原生对话，可以继续聊
- 每个任务可指定 **模型**（钉死后不跟着聊天模型变，额度可预期）
- 工作目录可下拉已有工作区，或自定义路径
- 也可在对话里对 AI 说「帮我建一个定时任务」（skill `scheduled-tasks` + `cron_create`）

### 日程

- 一次性 `at`，或循环 5 字段 cron，IANA 时区（默认 `Asia/Shanghai`）
- 「一分钟后」用 `after_minutes`，不要叠 `at` / `hour` / `expr`
- 重叠：同一任务已有进行中的运行则跳过
- 漏跑：Host 宕机期间错过的节拍 **不补跑**

### 开发

```sh
node --test test/*.test.js
```

本地 `file:` 安装（开发用，不要用 `link:`）：

```sh
dsh plugin --profile web add file:$HOME/.dsh/plugins/dsh-cron-tasks
```

产品契约见 [docs/PRD.md](docs/PRD.md)。实现经验见 [docs/NOTES.md](docs/NOTES.md)。

---

<a id="english"></a>

## English

At the scheduled time, Harness **opens a fresh root session**, runs a self-contained prompt, and records the run in the **Scheduled tasks** sidebar. Those sessions stay out of the ordinary workspace list.

This is not the official same-chat reminder (`@deepseek-ai/dsh-schedule`) and not OS crontab. The scheduler lives in the DSH Host process; nothing fires while Host is down.

### Install

Requires [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

```sh
dsh plugin --profile web add github:Whale-Zhang/dsh-cron-tasks
dsh plugin --profile desktop add github:Whale-Zhang/dsh-cron-tasks
```

Restart the profile after installing. `dsh --profile web --dump-config` should list `dsh-cron-tasks`.

### Uninstall

```sh
dsh plugin --profile web remove @dsh-external/dsh-cron-tasks
dsh plugin --profile desktop remove @dsh-external/dsh-cron-tasks
```

### What it does

- Sidebar entry **under New Session**: create, pause/resume, delete, run now, search
- Scheduler policy in **Settings → Plugins → Plugin configuration**
- Each fire is a new root session; open a history row to continue in the native chat
- Each job can pin a **model** so quota does not follow the chat selector
- Working directory: existing workspace or a custom path
- Ask the agent to create a job (`scheduled-tasks` skill + `cron_create`)

### Schedule

- One-shot `at` or 5-field cron, IANA time zone (default `Asia/Shanghai`)
- “In N minutes” → `after_minutes`
- Overlap: skip if the same job is already running
- Misfire: missed beats while Host was down are **not** replayed

### License

MIT
