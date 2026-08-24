# dsh-cron-tasks

DeepSeek Harness 插件：**定时任务**。

- 左侧侧边栏 **「新会话」按钮正下方** 的 **「定时任务」** 入口：查看、创建、暂停/恢复、删除、立即运行
- **设置 → 插件 → 插件配置** 里的调度策略（启用、默认时区、历史保留、重叠/漏跑）
- 到点后 **新开 root Session** 跑自包含提示词；运行会话 **不出现在工作区列表**，只留在 **定时任务历史**

产品契约见 [docs/PRD.md](docs/PRD.md)。本轮实现经验见 [docs/NOTES.md](docs/NOTES.md)。

## 行为

- 日程：一次性 `at`（ISO 8601）或循环 5 字段 cron，IANA 时区
- 重叠：同一任务已有 `queued`/`running` 则记 `skipped`，不开第二场
- 漏跑：Host 宕机期间错过的节拍 **不补跑**（不是 OS daemon）
- 提示词按不可信内容包裹，消息来源是 `plugin`，不伪装成人手输入

## 安装

```sh
# 拷到运行时目录后再 file: 安装（不要用 link:）
dsh plugin --profile web add file:$HOME/.dsh/plugins/dsh-cron-tasks
dsh plugin --profile desktop add file:$HOME/.dsh/plugins/dsh-cron-tasks
```

改 bundle 后 **重启** 对应 profile。`dsh --profile web --dump-config` 应能看到 `id: dsh-cron-tasks`。

## 开发

```sh
node --test test/*.test.js
```
