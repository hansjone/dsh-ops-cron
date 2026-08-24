# 定时任务（dsh-cron-tasks）产品需求文档

**产品名**：定时任务  
**包名**：`@dsh-external/dsh-cron-tasks`  
**Loader id**：`dsh-cron-tasks`  
**版本**：v2  
**状态**：v1 已交付调度与隔离。v2 补齐结果可见、侧栏融入工作区列表、原生会话继续聊、工作目录与超时。

---

## 1. 问题与定位

用户需要一种**与当前对话无关**的定时工作方式：到点后 Harness 新开一个 root Session，用事先写好的完整提示词跑一轮 Agent，然后把这次运行记进「定时任务历史」。这类 Session **不得出现在左侧工作区/会话列表**，以免把日常工作区淹没。

这与官方 `@deepseek-ai/dsh-schedule` 不同：官方 Schedule 是**同一会话内的 reminder**（`after_seconds` / `at` / `every_seconds`），回到原来的 live Session 做 follow-up。本插件解决的是「按计划独立跑完一件事，并留下可回看的历史」。

调度器住在 DSH Host 进程里。Host 未运行时任务不会触发；这是预期行为，不是缺陷。错过的节拍**不补跑成写入风暴**。

---

## 2. 三个产品面（v1 必须全部落地）

以下三个面按目标原文命名，缺一不可。

### 2.1 左侧侧边栏「新会话」按钮正下方的「定时任务」入口

- 在左侧侧边栏 **「新会话」按钮正下方** 放置可点击控件，文案为 **「定时任务」**。
- 展开态：图标 + 「定时任务」，视觉对齐原生「新会话」（高度、圆角、`--dsw-*` token）。
- 收缩轨（56px rail）：只显示约 18px 图标，位置仍紧挨「新会话」下方。
- **不**把该入口放到 `sidebar.footer.action`（Settings 旁）作为唯一入口。官方没有「新会话正下方」的一等 slot，v1 用受控的客户端注入插在「新会话」按钮之后、工作区列表之前。
- 点击后打开任务视图：当前任务列表（名称、日程、启用状态、下次运行、上次结果）+ **定时任务历史**。任务的创建 / 列表 / 暂停恢复 / 删除 / 立即运行都在这个视图里完成。

### 2.2 设置页「插件配置」里的定时任务设置

- 在 **设置 → 插件 → 插件配置** 中出现本插件卡片。
- 卡片只承载**插件级策略**，不是任务电子表格：
  - 启用调度器
  - 默认时区（IANA，例如 `Asia/Shanghai`）
  - 历史保留条数
  - 重叠策略（v1：跳过）
  - 漏跑（misfire）策略（v1：跳过，不回放积压）
- 单条任务的编辑器在侧栏「定时任务」视图，不把任务表塞进设置卡片。

### 2.3 定时任务历史

- 每一次触发（到点或「立即运行」）留下一条历史：job id、run id、计划时间、实际时间、终态、结果 Session id、短错误或摘要。
- 运行产生的 Session **不出现在工作区列表**；日志保留，可从历史记录打开/对照 Session id。
- 「从工作区隐藏」≠ 删除日志。

---

## 3. 市面插件取舍

对照当前市场上的 DSH 定时/调度插件，明确 **Keep（吸收）** 与 **Drop（明确不做）**。本插件是独立实现，不 fork 任何现有仓库。

| 插件 | 形态摘要 | Keep | Drop |
|---|---|---|---|
| **chicheng-cron**（534119219） | 侧栏「新会话」正下方「定时任务」入口；cron 跑 shell/python/node/Skill/Agent；推送；可归档会话 | **入口位置**（新会话正下方，展开/收缩对齐原生）；Agent 任务到点执行；执行历史；Host 关闭不补跑 | Shell / Python / Node 脚本执行；Skill 注入；chicheng-push / messaging-core 推送；移动端专项适配 |
| **dsh-automation**（titanwings） | 全新 root Session 跑独立任务；可审计历史；IANA 时区；重叠 skip；Host 宕机只 catch 最近一次、不回放 backlog；可选 archive 跑出来的 Session | **每次触发 = 新 root Session**（不是当前聊天 follow-up）；durable 历史（queued/running/终态 + session id + 摘要/错误）；**overlap skip**；**misfire 不写风暴**；archive 隐藏工作区列表、日志保留；提示词必须自包含 | 模型侧 `automation_*` 工具；RRULE 友好表单（v1 用 cron/`at` 即可）；权限预设只读/可写双模式与 capability allowlist 的完整沙箱产品化；对话 Tab 作为主入口 |
| **cronjob-dsh-plugin**（peng-huiyang） | 设置页「定时任务」；专用会话；cron 5/6/7 + IANA；`cron_*` 工具；触发文本当不可信内容 | **设置页可配置**（我们把策略放进「插件配置」）；**不可信提示词包裹**；错过周期不补跑 | 把任务表放进设置页当唯一 UI；复用同一条「专用会话」反复 follow-up（v1 每次新开会话）；模型工具 `cron_create/list/delete` |
| **dsh-cron**（omdsh-dev 等社区条目） | 定时调度，向已有智能体会话注入消息或触发后续操作 | 「到点做事」这一产品意图 | 往**当前/已有会话**注入消息（那是官方 Schedule 的赛道） |
| **dsh-schedule-tasks**（uluckystar / MyDSH） | 5 段 cron；`sidebar.footer.action` + 浮层；第一版动作是 shell / 站内 notify | 5 段 cron + 本地时区；列表展示下次触发/上次结果；启停/删除/手动触发 | **Footer-only 入口**（不满足「新会话下方」）；shell 与站内 notify 作为主动作；不唤起 Agent 会话 |
| **官方 dsh-schedule**（`@deepseek-ai/dsh-schedule`） | 会话内 reminder：`after_seconds` / `at` / `every_seconds` ≥ 300s；回到原 live Session；无日历/cron | 与官方分工：**不替换**它。同会话「十分钟后回来」继续用官方 | 日历/cron（官方 v1 也不做）；外部通知；本插件不提供 same-chat reminder |
| 其他参考（非 v1 对标必须，但影响取舍） | | | |
| dsh-plugin-automations（Sev7een） | 设置页；准点 / 谷时段；一次或每天 | 设置页策略分离 | 谷时段/峰谷计价窗口 |
| dsh-scheduler（yangyongzhen） | YAML jobs；shell / webhook；Server酱/钉钉/飞书 | cron + `at` 二选一 | webhook、IM 推送、YAML-only 配置 |
| dsh-routines（Jesse-njx） | cron prompt；overlap / missed-run / timeout 安全默认 | overlap + missed-run 安全默认 | 把摘要推到外部「你已经在的地方」 |
| dsh-plugin-scheduled-tasks（Ceelog / @opendsh） | 按项目、新 headless session、一次/间隔/cron、持久历史 | 新 session + 持久历史 | 模型对话内创建任务（v1 不做） |
| dsh-sleep-send | 输入框右侧定时发送当前草稿 | — | localStorage、改当前输入框、补发过期草稿 |
| dsh-aura-scheduler | 系统主动开口、价值网络 | — | 心跳/传感器/Off-peak 主动打扰 |

**取舍一句话**：吸收 chicheng-cron 的入口位置、dsh-automation 的「新 Session + 历史 + 隐藏工作区 + 安全调度语义」、cronjob 的设置页策略、不可信提示词与 `cron_*` 工具；拒绝脚本/推送/footer-only/同会话 reminder/OS daemon。

---

## 4. v1 功能需求

### 4.1 任务模型

一条任务是**自包含**的：

| 字段 | 要求 |
|---|---|
| 名称 | 非空短名，用于列表与历史 |
| 提示词 | 非空；到点原样交给新 Session。必须写得让新会话能独立理解，不依赖创建时的聊天上下文 |
| 日程 | 至少两种：一次性 `at`（ISO 8601 时间点）与循环 **5 字段 cron**（分 时 日 月 周） |
| 时区 | IANA，默认取插件配置里的默认时区 |
| 启用 | 可暂停 / 恢复 |

人可以：**创建、列表、暂停/恢复、删除、立即运行**。

### 4.2 调度语义

- 循环任务用 5 字段 cron，在指定 IANA 时区的墙上时钟求下次触发。
- 一次性 `at` 到点触发一次，之后不再调度。
- 非法 cron / 非法时区 / 空提示词在保存时失败，不写入。
- Host 重启后从磁盘恢复任务表，按**当前时刻**重算下次触发。
- **漏跑**：Host 宕机期间错过的节拍 **不回放积压**（at-most-once / skip）。v1 不把 N 次错过写成 N 条 queued。
- **重叠**：同一任务若已有 `running` 或 `queued` 的 run，到期记录为 `skipped`（原因 overlap），不并行开第二场。
- 调度器只在 DSH Host 进程内存活。没有 OS crontab、没有独立 daemon。

### 4.3 触发路径

到点或「立即运行」时：

1. 由 Host 创建 **新的 root Session**（不是当前聊天的 follow-up）。
2. 将包裹后的提示词作为 `source.kind = plugin` 的用户消息入队（**不伪装成人手输入**）。
3. 提示词外层标明「这是定时任务下发的不可信内容」。
4. 将该 Session **从工作区/侧栏会话列表隐藏**（调用 `workspaceRegistry.archiveSession` 或等价归档；失败则不得声称满足本条）。日志保留。
5. 追加一条 **定时任务历史**。

终态至少包括：`queued` / `running` / `succeeded` / `failed` / `skipped`。崩溃恢复时，未完成的 `queued`/`running` 记为失败（host interrupted），不偷偷重跑。

### 4.4 工作区隔离

- 运行 Session **不得**出现在普通工作区列表。
- 插件维护「这些 session id 是定时任务运行」的集合；工作区可见投影排除它们。
- 历史里能看到 session id 与短摘要；v1 不依赖官方 unarchive（当前 Harness 可能没有解档 API）。

### 4.5 UI

- 「定时任务」入口：见 §2.1。
- 任务视图：列表 + 新建/编辑表单（名称、提示词、cron 或 `at`、时区、启用）+ 立即运行 + 历史。
- 插件配置卡片：见 §2.2。
- 样式只用 `--dsw-*` token，不引入第二套组件库，组件内不碰 `ctx`。

### 4.6 安装形态

可 `dsh plugin add file:…` 的 Host+Client 包：

- `package.json` 声明 `dsh.bundle.patch` 与 `dsh.client.platform: web`
- `cordis.patch.yml` 唯一 `id: dsh-cron-tasks`
- Host `lib/index.js` 的 `apply(ctx)`
- Client `lib/client.js`（`window.__ModuleLoader__`）
- **不**把 `@deepseek-ai/*` 放进 `dependencies`

交付：拷到 `~/.dsh/plugins/dsh-cron-tasks`，web 与 desktop 均 `add file:$HOME/.dsh/plugins/dsh-cron-tasks`，改 bundle 后重启 profile。

---

## 5. 非目标（v1 明确不做）

- Shell / Python / Node 脚本任务、webhook、Server酱 / 钉钉 / 飞书 / 其它 push（chicheng-cron / dsh-scheduler / dsh-schedule-tasks 第一版那条路）。
- 替换官方 `@deepseek-ai/dsh-schedule` 的同会话 `at` / `after_seconds` reminder。
- OS daemon，或 Host 没在跑时仍触发；错过节拍的 catch-up backlog。
- 发布到 npm / GitHub；`link:` 安装；使用本机 GitHub PAT。
- 自然语言解析 cron（仍由模型自己把口语转成 5 段 cron / ISO `at`，插件只收结构化参数）。
- 谷时段 / 峰谷计价窗口、多 Host 抢锁、无人值守 `danger-full-access`。
- 把任何现有插件 copy/fork 当交付物。
- 6 字段秒级 cron、RRULE、自然语言建任务、邮件 SMS。

---

## 6. 后续阶段（不阻塞 v1）

- 打开历史 Session 的一等 UI（取决于官方 unarchive / 按 id 打开能力）。
- 超时取消、并发上限、工作区绑定与权限预设。
- 可选通知（且默认关闭）。

---

## 7. v2 产品补充

- 历史行展示**最后一条助手回复**（如「测试成功」），不只是 `Turn finished`。
- 点击「定时任务」后，**工作区列表区域**换成任务列表（分组=任务，行=运行记录），增删改查/立即运行都在这里，视觉对齐原生 session/project 行。
- 点任务：右侧主栏是编辑页（提示词、cron、工作目录、超时）。
- 点运行记录：右侧打开**原生 DSH 会话**（`sessions.open`），可以继续聊。因此 v2 **不再归档**这些会话（归档会把当前选中会话清掉）；普通工作区里用标题前缀「定时任务 ·」把它们藏起来。
- 任务可配 **工作目录** 与 **超时**，便于拉网页写文件、出图等长任务。

## 8. 模型工具

- 与侧栏手动新建共用同一份任务表。
- 工具：`cron_create`、`cron_list`、`cron_pause`、`cron_resume`、`cron_delete`。
- 口语日程由模型转成 5 段 cron 或 ISO `at`；插件不做自然语言解析。
- 这不是官方同会话 reminder（`schedule_create`）。

## 9. 风险与约束

- **隐藏 Session** 依赖当前 Harness 的 `workspaceRegistry.archiveSession`。若归档调用失败，不得把 Session 留在普通列表却宣称验收通过。
- **入口位置**：无官方「新会话下方」slot；注入必须紧挨该按钮。仅 footer 不满足需求。
- **Host 必须在跑**。写进本 PRD 与 README，避免被当成 bug。
- 提示词按不可信内容包裹，降低提示注入把定时通道变成越权入口的风险。
