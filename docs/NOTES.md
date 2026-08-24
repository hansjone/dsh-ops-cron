# dsh-cron-tasks 经验记录

日期：2026-08-23 — 2026-08-24  
包名：`@dsh-external/dsh-cron-tasks`  
Loader id：`dsh-cron-tasks`  
源码：本仓库  
运行时副本：`~/.dsh/plugins/dsh-cron-tasks`（`file:` 接入 web + desktop）  
产品契约：`docs/PRD.md`

这次会话把定时任务从「能调度」推到「能打开历史对话、能被 AI 创建、能当普通工作区会话继续聊」。下面只记本轮踩过的坑和已经定下来的产品语义。

---

## 产品（一句话）

到点后 Harness **新开一条 root Session** 跑事先写好的提示词，记录进侧栏「定时任务」历史。这类 Session **不得淹没日常工作区列表**。

这不是官方 `@deepseek-ai/dsh-schedule`（同会话 reminder），也不是 OS `crontab`。

三个面都要有：

1. 侧栏「新会话」正下方入口（不是 footer）
2. 设置 → 插件配置里的调度策略
3. 历史记录：点开就是原生对话

重叠 skip、漏跑 skip、Host 没跑就不触发。

---

## 形态

| 半边 | 入口 | 职责 |
|---|---|---|
| Host | `lib/index.js` + `lib/host.js` | 定时器、CRUD、fire、归档/揭示、工具、skill、同源 API |
| Client | `lib/client.js`（`window.__ModuleLoader__` factory） | 侧栏入口、任务列表、编辑器、隐藏原生 cron 行、打开会话、fork 提升 |

`package.json` 必须同时有 `dsh.bundle.patch` 和 `dsh.client`（`platform: web`，`immediately: true`）。Host **不要** import `@deepseek-ai/*`，也不要把它写进 `dependencies`。工具用纯 `ToolDefinition`，不要 `defineTool`。

Client `inject` 只写 `slots` / `locale` / `settingsScope`。静态 `inject: ['sessions']` 会在 boot 死锁；`sessions` / `workspaces` 用 `ctx.inject` 可选 + `internal/service`。

---

## 本机加载（file:）

```sh
# 拷到运行时后再 file: 安装（不要 link:）
dsh plugin --profile web add file:$HOME/.dsh/plugins/dsh-cron-tasks
dsh plugin --profile desktop add file:$HOME/.dsh/plugins/dsh-cron-tasks
```

改代码后必须再拷：

1. `~/.dsh/plugins/dsh-cron-tasks`
2. `~/.dsh/profiles/web/node_modules/@dsh-external/dsh-cron-tasks`
3. `~/.dsh/profiles/desktop/node_modules/@dsh-external/dsh-cron-tasks`

`file:` 是拷贝。只改仓库，profile 里的副本不会自己变。改 Host / bundle 后用户自己重启 `dsh web`；Desktop 和 web 互不影响。

验收：

- `dsh --profile web --dump-config` 能看到 `id: dsh-cron-tasks`
- `cd packages/dsh-cron-tasks && node --test test/*.test.js`
- curl 本机加 `--noproxy '*'`

---

## 运行会话怎么藏、怎么打开

v1 用 `workspaceRegistry.archiveSession` 从工作区列表拿掉。归档当前会话会把选中清掉，所以 v2 打开历史时必须先 **unarchive** 再 `sessions.open`。

工作区里再用标题前缀 `定时任务 · ` 把原生行藏掉（`hideNativeCronRows`）。藏标题 ≠ 删日志。

打开历史的坑：

- `sessions.open` 要求 id 已在 summaries 里；归档中的 id 会抛，catch 后看起来像「点了还停在原来的工作区会话」
- 要等 unarchive 反映到 `archivedSessionIds`，必要时 `sessions.refresh`，再 `open`，确认 `list.current === sessionId`
- `ctx.get('sessions')` 在未 inject 时可能抛，必须 `tryGet` / `faces.sessions`

`POST /dsh-cron-tasks/runs/:id/open` 负责 reveal；client 再 open。离开定时任务模式时 `POST /conceal` 把**已知运行会话**再归档。fork 出来的子会话不在这份名单里，不要误归档。

---

## 每个任务要能指定模型

到点跑的会话会打对应厂商的额度。如果只用「当时新会话默认」，用户不知道扣的是哪家，聊天里一换模型，定时任务也跟着变。

定下来：

- 任务可存 `provider` + `model`（可选 `reasoningEffort`）
- 编辑器下拉已配置的模型；也可选「每次运行用当时的新会话默认」
- 新建时默认钉死**当前**新会话模型，避免空白
- `cron_create` 没传就快照当前会话模型
- 列表标题旁显示模型名

空 provider/model 才在 fire 时读 `agentDefaultModel`。

---

## 执行失败 `{{model}}` 没有值

`agents.create` 不自动带上「新会话」用的默认模型。Persona 模板插 `{{model}}`，空值会让整轮装配失败。

修法：`ctx.get('agentDefaultModel').currentSelection()`，create 时写入 `agentOptions`，并在 agent ctx 上监听 `system-prompt/assemble` 和 `agent/request` 填 `provider` / `model`。没有选中模型要响亮失败，不要默默跑。

---

## 模型怎么建任务（不要塞 system-reminder）

一开始在每条会话塞 `<system-reminder>` 讲定时任务，不合理。改成：

- runtime skill `scheduled-tasks`（**必须** `source: 'runtime'`，否则 skill_load 报 `source must be a string`）
- 工具：`cron_create` / `cron_list` / `cron_pause` / `cron_resume` / `cron_delete`

MiniMax 锚定会话常驻工具只有 `bash` / `str_replace_editor` / `skill_search` / `skill_load` / `dev_tool_search`。cron 工具不在 resident set 里，模型会先去跑 `crontab -l`。skill 必须写明：先 `skill_search`「定时任务」，再 `skill_load scheduled-tasks`，**禁止 crontab / /etc/cron\***。

session.jsonl 对照过：没 load skill 时模型当 OS cron 用；load 成功后才会调 `cron_*`。

---

## 日程字段：模型会叠着传

session.jsonl 5：「一分钟后」一次性任务。模型第一次：

```json
{ "at": "00:33", "hour": 0, "minute": 33 }
```

插件按互斥报 `pass only one of expr, at, or hour/minute`，错误后缀还说「请传 hour+minute」，模型第二次变成 `expr` + `hour`。第三次才成功，时间已经漂了。

定下来的优先级（多余字段忽略，不要报错）：

1. `after_minutes` / `in_minutes`（「一分钟后」用这个，不要自己算钟面）
2. `hour` + `minute`（今晚几点；**hour=0 是午夜**，不能当 falsy 丢掉）
3. `at`
4. `expr` / `cron`

过去的一次性 `at` 仍然拒绝。`datetime-local` 必须按任务时区编解码，禁止对 UTC ISO 做 `slice`（否则 11:13 会显示成 15:13 或 23:13）。

skill 里写清当前本地时间；不要让模型猜日历（曾经把 2026-08-23 写成 2026-05-14）。

---

## 调度器：一次性和漏跑

5 字段 cron + IANA（默认 `Asia/Shanghai`）。

一次性 `at` 触发后必须把 `nextRunAt` **写成 `null`**。用 `??` 回退会把 due 时间填回去，每 15s tick 再跳一次。判断完成用 `nextRunAt === null`，不要用 `??`。`Object.hasOwn` 才能持久化 null。

漏跑：Host 宕机不回放积压。skip 要去重，避免 misfire skip 刷屏。

暂停：列表可停可恢复；立即运行（播放图标）即使暂停也允许。

---

## 「在新对话中分支」

官方：`sessions.fork({ sessionId, atSeq, increaseTitle: true })` 然后 `open(childId)`。子会话复制历史，标题变成 `定时任务 · 晨报 (1)`。

看起来像刷新，因为：

- 内容几乎一样
- 标题仍带前缀，被 `hideNativeCronRows` 藏掉
- 侧栏还停在定时任务模式
- 父会话未进任何工作区 `sessionIds`，官方 `forkWorkspace` 不 attach 子会话

合理语义：

| | 原运行会话 | 分支子会话 |
|---|---|---|
| 角色 | 历史原件 | 普通可继续聊的对话 |
| 列表 | 继续藏 | 出现在工作区或未分组 |
| 标题 | `定时任务 · …` | 去掉前缀，如 `晨报 (1)` |
| 之后 | 仍可从历史打开 | 切走还能在左边找到 |

插件要：认出 parent 是已知 run → 改标题 → `POST /sessions/:id/adopt` → 退出定时任务模式。不要把子会话写进历史。

### 工作区绑定

官方 `attachSession` 要求 **header.cwd === workspace.path**。cwd 对不上就不能挂到别人的项目。

- 任务没填 cwd 时，新运行用**最近工作区路径**并 attach，再 archive（槽位还在，列表不显示）。之后 fork 会继承该工作区。
- 已存在的、cwd 仍是 `~/.dsh/cron-tasks/workspace` 的子会话，只能出现在**未分组**。
- `hideNativeCronRows` **禁止**在分组收起（DOM 里没有 session 行）时把整组「未分组」`display:none`。切走找不到会话，多半是这个。

AI 在工作区会话里建任务：`cron_create` 若没传 cwd，用 `exec.agent.session.header.cwd`。手动新建：下拉已有工作区，或「自定义路径」。

---

## UI

列表视觉对齐工作区（运行时偷 hashed class + `--dsw-*`）。任务当分组，运行当行。点任务出编辑器，点运行打开原生会话。

- 加号是新建任务；运行用播放图标
- 可搜索、可暂停
- 工作目录：工作区下拉 / 自定义 / 留空=最近工作区

不要用 CSS 把输入框圆角削平（那是额度条子的教训，这里侧栏 overlay 用 `data-dsh-ct-mode`）。

---

## 排错顺序

1. 启动日志 `[dsh-cron-tasks]`
2. `--dump-config` 有没有 row
3. profile `node_modules/@dsh-external/dsh-cron-tasks` 是不是旧副本
4. `~/.dsh/cron-tasks/store.json`（`nextRunAt: null` 是否被写回）
5. 模型路径：session.jsonl 里有没有 `skill_load scheduled-tasks`、`cron_create` 参数是否叠字段
6. 打开会话失败：是否还在 `archivedSessionIds`、summaries 里有没有这个 id
7. 分支后找不到：标题前缀、未分组被整组隐藏、cwd 与工作区路径不一致

---

## 明确不要做

- 改 DSH 本体；发 npm / 用本机 GitHub PAT
- `link:` 安装
- 每条会话塞定时任务 `<system-reminder>`
- 把 `@deepseek-ai/*` 当 runtime 依赖
- 补跑漏掉的 cron 节拍
- 把 fork 子会话再归档进历史
- 互斥报错逼模型重试日程字段（直接按优先级吞）
