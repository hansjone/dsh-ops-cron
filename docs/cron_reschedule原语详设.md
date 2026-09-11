# cron_reschedule 原语详设

**状态**：已在本包落地（`rescheduleJob` + `cron_reschedule` + `POST /jobs/:id/reschedule`）  
**包**：`dsh-ops-cron`（本仓库可读源码，非混淆服务）  
**背景**：一次性 `at` 任务在仍有 `nextRunAt`（pending）时，`cron_retrigger` 会拒绝；Agent 只能删重建，体验差。

---

## 1. 结论

**改 pending 可以做，且应做。**  
语义是「把预定的那一次触发改期/提前」，不是「再开一次并发 run」。比放开 `cron_retrigger` 更精确、更安全。

| 方案 | 做法 | 评价 |
|------|------|------|
| A | 改 `cron_retrigger`：有 pending 时也接受，行为=抢占改期 | 可行，但混淆「已消费再触发」与「未到期改期」 |
| **B（推荐）** | **新增 `cron_reschedule`** | 不碰 retrigger 语义；最小侵入、向后兼容 |

---

## 2. 现状（代码事实）

- `isRetriggerable` / `retriggerJob`：one-shot 仅当 `nextRunAt == null` 且 `lastStatus` 终态才可 retrigger（`lib/monitor.js`、`lib/host.js`）。
- pending 拒绝文案已写明：`one-shot still has a pending next run; wait or edit the schedule instead of retrigger`。
- **侧栏 / HTTP 已能改期**：`PATCH /jobs/:id` → `updateJob({ schedule })`；若 patch 了 `schedule`，会经 `createJobRecord` **重算 `nextRunAt`**（`host.js` 约 698–700 行：仅当未改 schedule/enabled 才保留旧 next）。
- **缺口**：Agent 工具面没有 `cron_update` / `cron_reschedule`，只有 create / list / pause / resume / retrigger / delete。

因此：不必「热改运行中混淆服务」；在本包加工具（可选再加 host 薄封装）即可落地。

---

## 3. 推荐 API：`cron_reschedule`

### 3.1 签名

```text
cron_reschedule({
  id | task_id: string,          // 必填
  after_minutes?: number,        // ≥0；与 at 二选一（优先 after_minutes）
  at?: string,                   // ISO 或与 cron_create 一致的本地时间语义
  timezone?: string              // 可选；默认沿用 job.schedule.timezone
})
```

### 3.2 行为

1. 仅 `schedule.kind === 'at'`。
2. 仅当 **仍有 pending next**（`nextRunAt != null`）且 **无 active run**（queued/running）。
3. 计算新触发时刻 `T`（`after_minutes=0` → 立即 due；`>0` → now+N；`at` → 解析后的绝对时间）。
4. `T` 必须 ≥ now（允许 0 表示立刻进入 due，由现有 tick/`run-now` 路径消费；不要另开第二条 pending）。
5. 写回：
   - `schedule = { kind: 'at', at: ISO(T), timezone }`
   - `nextRunAt = T`
   - `enabled` 保持不变（paused 允许改 next，**不隐式 resume**）
6. **不**调用 `dispatchRun`（除非产品明确要 `fire_now=true`；默认不火，交给调度器）。
7. 返回 `{ ok, job, nextRunAt, previousNextRunAt }`。

### 3.3 拒绝条件（稳定 error.code）

| 条件 | code |
|------|------|
| 非 one-shot | `INVALID_RESCHEDULE` |
| `nextRunAt == null`（已消费） | `INVALID_RESCHEDULE` → 提示改用 `cron_retrigger` |
| 已有 queued/running | `ALREADY_RUNNING` |
| 时间非法 / 过去 | `INVALID_RESCHEDULE` |
| 周期 cron | `INVALID_RESCHEDULE`（周期改期另议，勿混进本原语） |

### 3.4 与 retrigger 分工（写进 tool description + skill）

| 状态 | 用哪个 |
|------|--------|
| one-shot 已跑完（`next=n/a`，`retriggerable=true`） | `cron_retrigger` |
| one-shot 仍在等（有 `nextRunAt`） | **`cron_reschedule`** |
| recurring 立刻多跑一次 | `cron_retrigger`（不改 cron 表达式） |

---

## 4. 实现落点（本仓库）

1. **`lib/host.js`**：新增 `rescheduleJob(jobId, opts, identity)`（或在 `updateJob` 外包一层校验）；可复用 `scheduleFromArgs` / `nextFire`。
2. **`lib/tools.js`**：注册 `cron_reschedule`；更新 `scheduled-tasks` skill 文案（禁止删重建来改期）。
3. **HTTP（可选）**：`POST /jobs/:id/reschedule`，与 PATCH 并存；Agent 走工具即可。
4. **测试**：`host.test.js` / `tools.test.js`
   - pending → after_minutes=1 → `nextRunAt` 前移
   - pending + active run → 拒绝
   - consumed → 拒绝并指向 retrigger
   - cron kind → 拒绝
   - paused pending → 只改 next，仍 `enabled=false`

工作量小：调度内核已支持「改 schedule ⇒ 新 next」；主要是 **Agent 可发现原语 + 边界校验**。

---

## 5. 明确不做

- 不对 pending one-shot 放开无条件 `cron_retrigger`（避免与「已消费再触发」心智冲突）。
- 不引入第二条并发 pending。
- 不把 reschedule 做成隐式 start（paused 保持 paused）。

---

## 6. 临时绕过（原语未上线前）

- **人**：侧栏编辑任务时间 → Save（已走 PATCH）。
- **Agent**：无工具时只能 delete + create（应在 skill 里标明为 workaround，待 `cron_reschedule` 替换）。
