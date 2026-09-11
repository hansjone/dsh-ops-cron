/**
 * Model-facing tools for scheduled jobs.
 * Plain ToolDefinition objects — do not import @deepseek-ai/dsh-tools.
 */

import { formatInZone, resolveTodayAt } from './scheduler.js'
import {
  assertDeliveryAllowedForIdentity,
  deliveryLine,
  jobVisibleToPeer,
  resolveCallerPeer,
  resolveCreateDelivery,
  resolveCreateOrigin,
} from './delivery.js'
import { t } from './i18n.js'
import { resolveCreateAgentPreset } from './preset.js'
import {
  assertCanAccessJob,
  filterJobsForIdentity,
  jobVisibleToIdentity,
  UNASSIGNED_OWNER,
} from './ownership.js'
import { agentMayMutateJob, splitProviderModel } from './store.js'

const JOB_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    prompt: { type: 'string' },
    enabled: { type: 'boolean' },
    cwd: { type: 'string' },
    timeoutMinutes: { type: 'number' },
    provider: { type: 'string' },
    model: { type: 'string' },
    reasoningEffort: { type: 'string' },
    agentPreset: { type: 'string' },
    delivery: { type: 'object', additionalProperties: true },
    origin: { type: 'object', additionalProperties: true },
    mirrorToSession: { type: 'boolean' },
    labels: { type: 'object', additionalProperties: true },
    watch: { type: 'object', additionalProperties: true },
    progress: { type: 'object', additionalProperties: true },
    report: { type: 'object', additionalProperties: true },
    persistHistory: { type: 'object', additionalProperties: true },
    state: { type: 'string' },
    stateEnteredAt: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    stuck: { type: 'boolean' },
    schedule: { type: 'object', additionalProperties: true },
    createdAt: { type: 'number' },
    updatedAt: { type: 'number' },
    // Host assertSupportedJsonSchema rejects type arrays — use oneOf for nullables.
    lastRunAt: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    lastStatus: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    nextRunAt: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    retriggerable: { type: 'boolean' },
  },
}

const RUN_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    run_id: { type: 'string' },
    jobId: { type: 'string' },
    status: { type: 'string' },
    state: { type: 'string' },
    stateEnteredAt: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    exitedAt: { oneOf: [{ type: 'number' }, { type: 'null' }] },
  },
}

function parseLabelsArg(raw) {
  if (raw == null || raw === '') return undefined
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const out = {}
    for (const [k, v] of Object.entries(raw)) {
      if (k) out[String(k)] = String(v ?? '')
    }
    return out
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return undefined
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parseLabelsArg(parsed)
      }
    } catch {
      // key=value,key2=value2
      const out = {}
      for (const part of trimmed.split(',')) {
        const idx = part.indexOf('=')
        if (idx <= 0) continue
        out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim()
      }
      return Object.keys(out).length ? out : undefined
    }
  }
  return undefined
}

function parseJsonObjectArg(raw, fieldName) {
  if (raw == null || raw === '' || raw === false) return undefined
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw.trim())
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      const error = new Error(`${fieldName} must be a JSON object`)
      error.code = 'INVALID_JOB'
      throw error
    }
  }
  const error = new Error(`${fieldName} must be an object`)
  error.code = 'INVALID_JOB'
  throw error
}

function monitorFieldsFromArgs(args = {}) {
  const out = {}
  const labels = parseLabelsArg(args.labels)
  if (labels) out.labels = labels
  if (args.watch !== undefined) {
    const watch = parseJsonObjectArg(args.watch, 'watch')
    out.watch = watch === undefined ? null : watch
  }
  if (args.progress !== undefined) {
    const progress = parseJsonObjectArg(args.progress, 'progress')
    out.progress = progress === undefined ? null : progress
  }
  if (args.report !== undefined) {
    const report = parseJsonObjectArg(args.report, 'report')
    out.report = report === undefined ? null : report
  }
  if (args.persist_history !== undefined) out.persist_history = args.persist_history
  if (args.persistHistory !== undefined) out.persistHistory = args.persistHistory
  return out
}

function text(value) {
  return [{ type: 'text', text: String(value || '') }]
}

function aborted(exec) {
  if (exec?.signal?.aborted) {
    const error = new Error('aborted')
    error.code = 'ABORTED'
    throw error
  }
}

function presentNumber(value) {
  if (value === undefined || value === null || value === '') return false
  return Number.isFinite(Number(value))
}

/**
 * Models often send overlapping schedule fields (at + hour, expr + hour).
 * Prefer the most specific: after_minutes, then hour+minute, then at, then cron.
 */
export function scheduleFromArgs(args = {}, nowMs = Date.now()) {
  const timezone = typeof args.timezone === 'string' && args.timezone.trim()
    ? args.timezone.trim()
    : (typeof args.time_zone === 'string' && args.time_zone.trim() ? args.time_zone.trim() : 'Asia/Shanghai')
  const expr = typeof args.expr === 'string' && args.expr.trim()
    ? args.expr.trim()
    : (typeof args.cron === 'string' && args.cron.trim() ? args.cron.trim() : '')
  const at = typeof args.at === 'string' && args.at.trim() ? args.at.trim() : ''
  const after = presentNumber(args.after_minutes)
    ? Number(args.after_minutes)
    : (presentNumber(args.in_minutes) ? Number(args.in_minutes) : null)
  const hasHour = presentNumber(args.hour)
  if (after != null) {
    if (after < 0) {
      const error = new Error('after_minutes must be >= 0')
      error.code = 'INVALID_SCHEDULE'
      throw error
    }
    return { kind: 'at', at: new Date(nowMs + after * 60_000).toISOString(), timezone }
  }
  if (hasHour) {
    const instant = resolveTodayAt(
      Number(args.hour),
      presentNumber(args.minute) ? Number(args.minute) : 0,
      timezone,
      nowMs,
    )
    return { kind: 'at', at: new Date(instant).toISOString(), timezone }
  }
  if (at) return { kind: 'at', at, timezone }
  if (expr) return { kind: 'cron', expr, timezone }
  const error = new Error('provide after_minutes, hour+minute, at (ISO or HH:mm), or expr')
  error.code = 'INVALID_SCHEDULE'
  throw error
}

function jobLine(job) {
  if (!job) return ''
  const tz = job.schedule?.timezone || 'Asia/Shanghai'
  const when = job.nextRunAt ? formatInZone(job.nextRunAt, tz) : 'n/a'
  const life = job.state || (job.enabled === false ? 'paused' : 'enabled')
  const sched = job.schedule?.kind === 'at'
    ? `at ${job.schedule.at}`
    : (job.schedule?.expr || 'cron')
  const model = job.provider && job.model ? `${job.provider}/${job.model}` : 'default-model'
  const delivery = deliveryLine(job.delivery)
  const labels = job.labels && Object.keys(job.labels).length
    ? ` labels=${JSON.stringify(job.labels)}`
    : ''
  const stuck = job.stuck ? ' STUCK' : ''
  return `${job.name} [${life}${stuck}] ${sched} tz=${tz} cwd=${job.cwd || '(recent workspace)'} model=${model} ${delivery}${labels} next=${when} id=${job.id}`
}

/** Strip human-only fields so agents cannot see or game panel-only controls. */
function forAgentView(job) {
  if (!job || typeof job !== 'object') return job
  const { agentAccess: _a, permissionPreset: _p, ...rest } = job
  return rest
}

function assertAgentMayMutate(job) {
  if (agentMayMutateJob(job)) return
  const error = new Error('this job is human-managed; change “Agent 操作” in the 定时任务 panel (agents cannot toggle it)')
  error.code = 'AGENT_ACCESS_DENIED'
  throw error
}

export function callerWorkingDirectory(exec) {
  const session = exec?.agent?.session
  return String(session?.header?.cwd || session?.cwd || exec?.agent?.cwd || '').trim()
}

export function resolveCreateCwd(args, exec, { peer = null } = {}) {
  const sessionCwd = callerWorkingDirectory(exec)
  const passed = typeof args?.cwd === 'string' ? args.cwd.trim() : ''
  // IM peers cannot point scheduled Agents at arbitrary host paths.
  if (peer?.botId) {
    if (!sessionCwd) {
      const error = new Error('IM scheduled jobs require a non-empty session working directory')
      error.code = 'INVALID_CWD'
      throw error
    }
    return sessionCwd
  }
  if (passed) return passed
  return sessionCwd
}

function callerSessionId(exec) {
  return String(
    exec?.agent?.session?.id
    || exec?.agent?.session?.header?.id
    || exec?.sessionId
    || exec?.agent?.sessionId
    || '',
  ).trim()
}

function empNoFromUserWorkspacePath(cwd) {
  const norm = String(cwd || '').replace(/\\/g, '/')
  const match = norm.match(/\/user-workspaces\/([^/]+)(?:\/|$)/)
  return match ? decodeURIComponent(match[1]) : null
}

/**
 * Resolve web caller identity for ownership. IM peers keep conversation scoping.
 * Prefer uds-auth role lookup so super_admin keeps canViewAllSessions (cwd sanitize).
 */
export function resolveToolIdentity(exec, service) {
  const uds = typeof service?.getUdsAuth === 'function' ? service.getUdsAuth() : null
  const sessionId = callerSessionId(exec)
  let empNo = null
  if (sessionId && uds?.getSessionOwner) {
    empNo = uds.getSessionOwner(sessionId)
  }
  if (!empNo) {
    empNo = empNoFromUserWorkspacePath(callerWorkingDirectory(exec))
  }
  if (!empNo) return null
  const id = String(empNo)
  if (typeof uds?.resolveIdentityForEmpNo === 'function') {
    const resolved = uds.resolveIdentityForEmpNo(id)
    if (resolved?.empNo) {
      const elevated = resolved.role === 'super_admin' || resolved.role === 'fallback_admin'
      return {
        empNo: String(resolved.empNo),
        displayName: String(resolved.displayName || resolved.empNo),
        role: resolved.role || 'user',
        permissions: {
          canViewAllSessions: !!(resolved.permissions?.canViewAllSessions || elevated),
          canCreateWorkspace: !!(resolved.permissions?.canCreateWorkspace || elevated),
        },
        workspacePath: resolved.workspacePath || uds.getProvisionedWorkspacePath?.(id) || null,
      }
    }
  }
  return {
    empNo: id,
    displayName: id,
    role: 'user',
    permissions: { canViewAllSessions: false },
    workspacePath: uds?.getProvisionedWorkspacePath?.(id) || null,
  }
}

function forbidForeignJob(job, peer, identity = null) {
  if (peer?.botId) {
    if (jobVisibleToPeer(job, peer)) return job
    const error = new Error('job not found or not owned by this chat')
    error.code = 'NOT_FOUND'
    throw error
  }
  if (identity?.empNo) {
    assertCanAccessJob(job, identity)
    return job
  }
  // No peer and no web identity: do not expose foreign jobs.
  if (job?.ownerEmpNo && job.ownerEmpNo !== UNASSIGNED_OWNER) {
    const error = new Error('job not found or not owned by this session')
    error.code = 'NOT_FOUND'
    throw error
  }
  return job
}

async function requireOwnedJob(service, id, peer, identity = null) {
  const job = await service.getJob?.(id)
  if (job) return forbidForeignJob(job, peer, identity)
  const jobs = await service.listJobs()
  const hit = (jobs || []).find((row) => row.id === id)
  if (!hit) {
    const error = new Error('job not found')
    error.code = 'NOT_FOUND'
    throw error
  }
  return forbidForeignJob(hit, peer, identity)
}

export function callerModelSelection(exec) {
  const opts = exec?.agent?.options || {}
  const split = splitProviderModel(opts.provider, opts.model)
  if (!split.provider || !split.model) return { provider: '', model: '', reasoningEffort: '' }
  const reasoningEffort = String(opts.reasoningEffort || '').trim()
  return { provider: split.provider, model: split.model, reasoningEffort }
}

export function resolveCreateModel(args, exec) {
  const reasoningEffort = typeof args?.reasoning_effort === 'string'
    ? args.reasoning_effort.trim()
    : (typeof args?.reasoningEffort === 'string' ? args.reasoningEffort.trim() : '')
  const explicit = splitProviderModel(args?.provider, args?.model)
  if (explicit.provider && explicit.model) {
    return { provider: explicit.provider, model: explicit.model, reasoningEffort }
  }
  // One of provider/model alone (after split) → ignore; inherit session instead of throwing.
  if (explicit.provider || explicit.model) {
    const fromSession = callerModelSelection(exec)
    if (fromSession.provider && fromSession.model) {
      return { ...fromSession, reasoningEffort: reasoningEffort || fromSession.reasoningEffort }
    }
  }
  const fromSession = callerModelSelection(exec)
  return { ...fromSession, reasoningEffort: reasoningEffort || fromSession.reasoningEffort }
}

function requireId(args) {
  const id = typeof args?.id === 'string' ? args.id.trim() : ''
  if (!id) {
    const error = new Error('id is required')
    error.code = 'INVALID_JOB'
    throw error
  }
  return id
}

export function cronToolDefinitions(service, deps = {}) {
  const getDshIm = typeof deps.getDshIm === 'function' ? deps.getDshIm : () => undefined
  const getAgentPresets = typeof deps.getAgentPresets === 'function' ? deps.getAgentPresets : () => undefined
  return [
    {
      name: 'cron_create',
      description: 'Create a DSH 定时任务 job (sidebar scheduled job). NEVER use crontab. NOT schedule_create. Default timezone Asia/Shanghai. For "in N minutes / 一分钟后" pass only after_minutes. For "today/tonight at HH:MM" pass only hour+minute (24h; hour=0 is midnight). Do not also send at or expr. Extra schedule fields are ignored (after_minutes > hour > at > expr). cwd MUST be the current workspace path when chatting in a workspace; if omitted, uses the current session working directory. Pass provider+model for the job; if omitted, snapshots the current session model. Agent preset: omit to inherit (WhatsApp chat preset → session → Host default); or pass agent_preset. Delivery: omit for auto — on WhatsApp/IM creates/reuses a 投递目标 for the current chat (group→group, DM→DM) and sets delivery=im; on Web/DSH defaults to dsh. Or pass delivery=dsh|im with im_bot_id+im_target_id. Session mirror is OFF by default; pass mirror_to_session=true only when the user wants the run summary injected into the origin WhatsApp/Web chat.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', description: 'Short display name in the 定时任务 list.' },
          prompt: { type: 'string', description: 'Self-contained instructions for the new session when the job fires.' },
          expr: { type: 'string', description: '5-field cron in the given timezone: "minute hour day-of-month month day-of-week". Recurring jobs only. 22:55 every day = "55 22 * * *". Do not send expr together with after_minutes/hour/at — extras are ignored.' },
          cron: { type: 'string', description: 'Alias of expr.' },
          at: { type: 'string', description: 'One-shot ISO or HH:mm. Prefer after_minutes or hour+minute instead. Ignored if after_minutes or hour is set.' },
          after_minutes: { type: 'number', description: 'One-shot in N minutes from now. Use for "一分钟后" / "in 5 minutes". Do not also pass at, hour, or expr.' },
          in_minutes: { type: 'number', description: 'Alias of after_minutes.' },
          hour: { type: 'integer', description: 'One-shot today/tonight clock hour 0-23. Midnight is 0. Ignored if after_minutes is set.' },
          minute: { type: 'integer', description: '0-59, used with hour.' },
          timezone: { type: 'string', description: 'IANA timezone for expr/at. Default Asia/Shanghai. Do not pass UTC unless the user asked for UTC.' },
          time_zone: { type: 'string', description: 'Alias of timezone.' },
          cwd: { type: 'string', description: 'Filesystem path of the workspace this job should run in. When the user is in a workspace conversation, pass THAT workspace path (current session cwd). If omitted, the current session cwd is used. WhatsApp/IM creates always use the current session cwd.' },
          provider: { type: 'string', description: 'Provider id only (e.g. zte, deepseek, minimax-cn). Do NOT pass "provider/model". Must pair with model, or omit both to inherit the current session.' },
          model: { type: 'string', description: 'Bare model id only (e.g. Qwen3-235B-A22B). Do NOT pass "provider/model" or repeat the provider. Must pair with provider, or omit both to inherit the current session.' },
          reasoning_effort: { type: 'string', description: 'Optional reasoning effort for this job.' },
          timeout_minutes: { type: 'integer', description: 'Per-run timeout in minutes, 1-240.' },
          enabled: { type: 'boolean', description: 'If false, create paused. Default true.' },
          delivery: { type: 'string', description: 'dsh (sidebar session) or im (proactive WhatsApp/IM via botId+targetId). Omit to auto-detect from the current session. On WhatsApp/IM, delivery is always bound to the current chat — free im_bot_id/im_target_id are ignored.' },
          im_bot_id: { type: 'string', description: 'Opaque botId from IM 投递设置 when delivery=im (Web/sidebar only; IM chats cannot retarget).' },
          im_target_id: { type: 'string', description: 'Opaque targetId from IM 投递设置 when delivery=im (Web/sidebar only; IM chats cannot retarget).' },
          agent_preset: { type: 'string', description: 'Agent preset id for scheduled runs. Omit to inherit from the current WhatsApp/IM chat or Host default.' },
          mirror_to_session: { type: 'boolean', description: 'If true, after each fire append the run summary into the origin WhatsApp/Web session as a system-reminder (no new model turn). Default false — results stay in run history (and IM delivery when configured).' },
          labels: { type: 'object', additionalProperties: true, description: 'String labels for discovery/monitoring, e.g. {"role":"worker","task":"theory","owner":"alice"}.' },
          watch: { type: 'object', additionalProperties: true, description: 'Listener binding: {"taskId":"..."} and/or {"labels":{...},"match":"any|all","timeout_min":30}.' },
          progress: { type: 'object', additionalProperties: true, description: 'Progress declaration: {"channel":{"file":"progress.json"},"metrics":[{"key":"done","label":"已完成"}]}.' },
          report: { type: 'object', additionalProperties: true, description: 'Watcher report: {"mode":"on_change|on_complete|periodic","delivery":"dsh|im|none","interval_min":15}.' },
          persist_history: { type: 'string', description: 'History policy: forever | retain:N | archive:endpoint. Default retain from settings.' },
        },
        required: ['name', 'prompt'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: { job: JOB_SCHEMA },
        },
        render: (_args, value) => {
          const job = value.job
          const tz = job?.schedule?.timezone || 'Asia/Shanghai'
          const when = job?.nextRunAt ? formatInZone(job.nextRunAt, tz) : 'none'
          const sched = job?.schedule?.kind === 'at'
            ? `one-shot ${job.schedule.at}`
            : `cron ${job?.schedule?.expr}`
          const cwd = job?.cwd ? ` cwd=${job.cwd}` : ' cwd=(recent workspace)'
          const model = job?.provider && job?.model
            ? ` model=${job.provider}/${job.model}`
            : ' model=(new-session default at fire time)'
          const delivery = ` ${deliveryLine(job?.delivery)}`
          return text(`Created "${job?.name}" (${job?.id}) ${sched} in ${tz}.${cwd}.${model}.${delivery}. Next run: ${when}. If that local time is wrong, delete this job and recreate with 24h hours (22=10pm).`)
        },
      },
      presentCall: (args) => ({ card: 'generic', title: t('tool.create'), content: String(args?.name || '') }),
      async execute(args, exec) {
        aborted(exec)
        const timeout = Number(args.timeout_minutes)
        const dshIm = getDshIm()
        try {
          const peer = await resolveCallerPeer(exec, dshIm)
          // Channel chats scope by peer; do not stamp empNo (avoids sanitize clobbering bot cwd).
          const identity = peer?.botId ? null : resolveToolIdentity(exec, service)
          const delivery = await resolveCreateDelivery(args, exec, { dshIm })
          if (identity && !peer?.botId) {
            assertDeliveryAllowedForIdentity(delivery, identity)
          }
          const origin = await resolveCreateOrigin(args, exec, { dshIm })
          const agentPreset = await resolveCreateAgentPreset(args, exec, {
            dshIm,
            agentPresets: getAgentPresets(),
          })
          const job = await service.createJob({
            name: args.name,
            prompt: args.prompt,
            schedule: scheduleFromArgs(args, Date.now()),
            cwd: resolveCreateCwd(args, exec, { peer }),
            ...resolveCreateModel(args, exec),
            timeoutMinutes: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
            enabled: args.enabled !== false,
            delivery,
            mirrorToSession: args.mirror_to_session === true,
            ...origin ? { origin } : {},
            agentPreset,
            ...monitorFieldsFromArgs(args),
          }, identity, { fromImPeer: !!peer?.botId })
          return { job: forAgentView(job) }
        } catch (error) {
          const tz = args.timezone || args.time_zone || 'Asia/Shanghai'
          const nowText = formatInZone(Date.now(), tz)
          const message = error instanceof Error ? error.message : String(error)
          const code = error && error.code
          if (code === 'INVALID_AT' || /already in the past/.test(message)) {
            throw new Error(`${message}. Current local time is ${nowText}. For "in N minutes" pass only after_minutes. For "today/tonight at HH:MM" pass only hour and minute (hour=0 is midnight).`)
          }
          throw error instanceof Error ? error : new Error(message)
        }
      },
    },
    {
      name: 'cron_list',
      description: 'List DSH 定时任务 jobs (sidebar scheduled jobs). Filter by enabled_only, state (idle|pending|running|succeeded|failed|paused), labels, or task_id. NEVER use crontab -l.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled_only: { type: 'boolean', description: 'If true, omit paused jobs.' },
          state: { type: 'string', description: 'Lifecycle filter: idle|pending|running|succeeded|failed|paused.' },
          task_id: { type: 'string', description: 'Exact job id.' },
          labels: { type: 'object', additionalProperties: true, description: 'Label filter (all keys must match unless used with cron_query match=any).' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            jobs: { type: 'array', items: JOB_SCHEMA },
            count: { type: 'integer' },
          },
          required: ['jobs', 'count'],
        },
        render: (_args, value) => {
          const rows = (value.jobs || []).map(jobLine)
          return text(rows.length ? `Scheduled tasks (${value.count}):\n${rows.join('\n')}` : 'No scheduled tasks yet.')
        },
      },
      presentCall: () => ({ card: 'generic', title: t('tool.list') }),
      async execute(args, exec) {
        aborted(exec)
        const peer = await resolveCallerPeer(exec, getDshIm())
        const identity = resolveToolIdentity(exec, service)
        const query = {
          ...parseLabelsArg(args?.labels) ? { labels: parseLabelsArg(args.labels) } : {},
          ...args?.task_id ? { taskId: String(args.task_id).trim() } : {},
          ...args?.state ? { state: String(args.state).trim() } : {},
        }
        let jobs = await service.listJobs(identity, Object.keys(query).length ? query : null)
        if (peer?.botId) jobs = jobs.filter((job) => jobVisibleToPeer(job, peer))
        if (args?.enabled_only === true) jobs = jobs.filter((job) => job.enabled !== false)
        const visible = jobs.map(forAgentView)
        return { jobs: visible, count: visible.length }
      },
    },
    {
      name: 'cron_query',
      description: 'Listener/monitor query: resolve jobs by taskId or labels (match any|all), optionally include run history and decode progress snapshots from progress.channel.file.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', description: 'Watch a single job id.' },
          labels: { type: 'object', additionalProperties: true, description: 'Label selector.' },
          match: { type: 'string', description: 'Label match mode: all (default) or any.' },
          state: { type: 'string', description: 'Filter projected lifecycle state.' },
          include_runs: { type: 'boolean', description: 'Include run instances per job.' },
          decode_progress: { type: 'boolean', description: 'Read progress.channel.file snapshots.' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            jobs: { type: 'array', items: JOB_SCHEMA },
            items: { type: 'array', items: { type: 'object', additionalProperties: true } },
            count: { type: 'integer' },
          },
        },
        render: (_args, value) => {
          const rows = (value.jobs || []).map(jobLine)
          return text(rows.length
            ? `cron_query (${value.count}):\n${rows.join('\n')}`
            : 'cron_query: no matching jobs.')
        },
      },
      presentCall: () => ({ card: 'generic', title: 'cron_query' }),
      async execute(args, exec) {
        aborted(exec)
        const peer = await resolveCallerPeer(exec, getDshIm())
        const identity = resolveToolIdentity(exec, service)
        const result = await service.queryJobs({
          taskId: args?.task_id,
          labels: parseLabelsArg(args?.labels),
          match: args?.match === 'any' ? 'any' : 'all',
          state: args?.state,
          includeRuns: args?.include_runs === true,
          decodeProgress: args?.decode_progress === true,
        }, identity)
        if (peer?.botId) {
          result.jobs = result.jobs.filter((job) => jobVisibleToPeer(job, peer))
          result.items = (result.items || []).filter((item) => jobVisibleToPeer(item.job, peer))
          result.count = result.jobs.length
        }
        result.jobs = (result.jobs || []).map(forAgentView)
        result.items = (result.items || []).map((item) => (
          item && typeof item === 'object'
            ? { ...item, job: forAgentView(item.job) }
            : item
        ))
        return result
      },
    },
    {
      name: 'cron_runs',
      description: 'List run instances for a task (history). Supports state/from/to/limit/cursor. History defaults to retain:N; forever jobs keep all rows.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', description: 'Job id.' },
          state: { type: 'string', description: 'Filter: pending|running|succeeded|failed.' },
          from: { type: 'number', description: 'Epoch ms lower bound.' },
          to: { type: 'number', description: 'Epoch ms upper bound.' },
          limit: { type: 'integer', description: 'Page size (max 500).' },
          cursor: { type: 'string', description: 'Pagination cursor (previous run id).' },
        },
        required: ['task_id'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            task_id: { type: 'string' },
            runs: { type: 'array', items: RUN_SCHEMA },
            next_cursor: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            total: { type: 'integer' },
          },
        },
        render: (_args, value) => {
          const rows = (value.runs || []).map((run) => (
            `${run.run_id || run.id} ${run.state || run.status} entered=${run.stateEnteredAt || '-'} exited=${run.exitedAt || '-'}`
          ))
          return text(rows.length
            ? `Runs for ${value.task_id} (${value.total}):\n${rows.join('\n')}`
            : `No runs for ${value.task_id}.`)
        },
      },
      presentCall: (args) => ({ card: 'generic', title: 'cron_runs', content: String(args?.task_id || '') }),
      async execute(args, exec) {
        aborted(exec)
        const peer = await resolveCallerPeer(exec, getDshIm())
        const identity = resolveToolIdentity(exec, service)
        const taskId = String(args?.task_id || '').trim()
        await requireOwnedJob(service, taskId, peer, identity)
        return service.listRuns(taskId, {
          state: args?.state,
          from: args?.from,
          to: args?.to,
          limit: args?.limit,
          cursor: args?.cursor,
        }, identity)
      },
    },
    {
      name: 'cron_progress',
      description: 'Read current progress snapshots for a task_id or label watch selector (progress.channel.file).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', description: 'Job id.' },
          labels: { type: 'object', additionalProperties: true, description: 'Label selector (by_watch).' },
          match: { type: 'string', description: 'any|all for labels.' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            snapshots: { type: 'array', items: { type: 'object', additionalProperties: true } },
            count: { type: 'integer' },
          },
        },
        render: (_args, value) => {
          const rows = (value.snapshots || []).map((row) => {
            const metrics = row.progress?.metrics
              ? JSON.stringify(row.progress.metrics)
              : (row.progress?.missing ? '(no file)' : '{}')
            return `${row.job?.name || row.job?.id}: ${metrics}`
          })
          return text(rows.length ? `Progress (${value.count}):\n${rows.join('\n')}` : 'No progress snapshots.')
        },
      },
      presentCall: () => ({ card: 'generic', title: 'cron_progress' }),
      async execute(args, exec) {
        aborted(exec)
        const peer = await resolveCallerPeer(exec, getDshIm())
        const identity = resolveToolIdentity(exec, service)
        const result = await service.getProgress({
          taskId: args?.task_id,
          labels: parseLabelsArg(args?.labels),
          match: args?.match === 'any' ? 'any' : 'all',
        }, identity)
        if (peer?.botId) {
          result.snapshots = (result.snapshots || []).filter((row) => jobVisibleToPeer(row.job, peer))
          result.count = result.snapshots.length
        }
        result.snapshots = (result.snapshots || []).map((row) => (
          row && typeof row === 'object'
            ? { ...row, job: forAgentView(row.job) }
            : row
        ))
        return result
      },
    },
    {
      name: 'cron_pause',
      description: 'Pause a scheduled task by id from cron_list / cron_create. It stays in 定时任务 but will not fire until resumed.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string', description: 'Job id.' } },
        required: ['id'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { job: JOB_SCHEMA } },
        render: (_args, value) => text(`Paused "${value.job?.name}" (${value.job?.id}).`),
      },
      presentCall: (args) => ({ card: 'generic', title: t('tool.pause'), content: String(args?.id || '') }),
      async execute(args, exec) {
        aborted(exec)
        const peer = await resolveCallerPeer(exec, getDshIm())
        const identity = resolveToolIdentity(exec, service)
        const id = requireId(args)
        const owned = await requireOwnedJob(service, id, peer, identity)
        assertAgentMayMutate(owned)
        const job = await service.pauseJob(id, false, identity)
        return { job: forAgentView(job) }
      },
    },
    {
      name: 'cron_resume',
      description: 'Resume a paused scheduled task by id. Only flips enabled=true; does NOT re-fire a consumed one-shot (next=n/a). Use cron_retrigger for that.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string', description: 'Job id.' } },
        required: ['id'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { job: JOB_SCHEMA } },
        render: (_args, value) => text(`Resumed "${value.job?.name}" (${value.job?.id}).`),
      },
      presentCall: (args) => ({ card: 'generic', title: t('tool.resume'), content: String(args?.id || '') }),
      async execute(args, exec) {
        aborted(exec)
        const peer = await resolveCallerPeer(exec, getDshIm())
        const identity = resolveToolIdentity(exec, service)
        const id = requireId(args)
        const owned = await requireOwnedJob(service, id, peer, identity)
        assertAgentMayMutate(owned)
        const job = await service.pauseJob(id, true, identity)
        return { job: forAgentView(job) }
      },
    },
    {
      name: 'cron_retrigger',
      description: 'Start an extra run now: for recurring (cron) jobs fires immediately without changing the schedule; for consumed one-shots (next=n/a) re-arms/fires a new run. Auto-enables if paused. after_minutes>0 only for one-shots. Rejects if already pending/running OR if a one-shot still has a pending next (use cron_reschedule). Listeners: when retriggerable=true and progress done_flag is false, call this instead of creating a duplicate job.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', description: 'Job id (alias: id).' },
          id: { type: 'string', description: 'Alias of task_id.' },
          after_minutes: { type: 'number', description: 'One-shot only: delay before fire. Omit/0 = immediate. Not allowed for recurring jobs.' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            mode: { type: 'string' },
            job: JOB_SCHEMA,
            run: { oneOf: [RUN_SCHEMA, { type: 'null' }] },
            nextRunAt: { oneOf: [{ type: 'number' }, { type: 'null' }] },
          },
        },
        render: (_args, value) => {
          const name = value.job?.name || value.job?.id || ''
          if (value.mode === 'scheduled') {
            const when = value.nextRunAt ? new Date(value.nextRunAt).toISOString() : 'pending'
            return text(`Retrigger scheduled "${name}" → next ${when}.`)
          }
          return text(`Retriggered "${name}"${value.run?.id ? ` (run ${value.run.id})` : ''}.`)
        },
      },
      presentCall: (args) => ({
        card: 'generic',
        title: t('tool.retrigger'),
        content: String(args?.task_id || args?.id || ''),
      }),
      async execute(args, exec) {
        aborted(exec)
        const peer = await resolveCallerPeer(exec, getDshIm())
        const identity = resolveToolIdentity(exec, service)
        const id = String(args?.task_id || args?.id || '').trim()
        if (!id) throw new Error('task_id is required')
        const owned = await requireOwnedJob(service, id, peer, identity)
        assertAgentMayMutate(owned)
        const result = await service.retriggerJob(id, {
          after_minutes: args?.after_minutes,
        }, identity)
        return { ...result, job: forAgentView(result.job) }
      },
    },
    {
      name: 'cron_reschedule',
      description: 'Move a pending one-shot next fire time (still has next≠n/a). Prefer after_minutes (0=ASAP / next tick) or at. Does NOT start a second concurrent run; does NOT auto-resume paused jobs; does NOT replace cron_retrigger for consumed oneshots. Use this instead of delete+create when the user wants earlier/later.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', description: 'Job id (alias: id).' },
          id: { type: 'string', description: 'Alias of task_id.' },
          after_minutes: { type: 'number', description: 'Delay from now before fire. 0 = due immediately. Preferred over at.' },
          at: { type: 'string', description: 'ISO timestamp or HH:mm in job timezone. Ignored if after_minutes is set.' },
          timezone: { type: 'string', description: 'Optional IANA tz; default keeps the job timezone.' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            job: JOB_SCHEMA,
            nextRunAt: { oneOf: [{ type: 'number' }, { type: 'null' }] },
            previousNextRunAt: { oneOf: [{ type: 'number' }, { type: 'null' }] },
          },
        },
        render: (_args, value) => {
          const name = value.job?.name || value.job?.id || ''
          const when = value.nextRunAt ? new Date(value.nextRunAt).toISOString() : 'n/a'
          return text(`Rescheduled "${name}" → next ${when}.`)
        },
      },
      presentCall: (args) => ({
        card: 'generic',
        title: t('tool.reschedule'),
        content: String(args?.task_id || args?.id || ''),
      }),
      async execute(args, exec) {
        aborted(exec)
        const peer = await resolveCallerPeer(exec, getDshIm())
        const identity = resolveToolIdentity(exec, service)
        const id = String(args?.task_id || args?.id || '').trim()
        if (!id) throw new Error('task_id is required')
        const owned = await requireOwnedJob(service, id, peer, identity)
        assertAgentMayMutate(owned)
        const result = await service.rescheduleJob(id, {
          after_minutes: args?.after_minutes,
          at: args?.at,
          timezone: args?.timezone,
        }, identity)
        return { ...result, job: forAgentView(result.job) }
      },
    },
    {
      name: 'cron_delete',
      description: 'Permanently delete a scheduled task by id. History rows for that job remain until pruned.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string', description: 'Job id.' } },
        required: ['id'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            deleted: { type: 'boolean' },
          },
          required: ['id', 'deleted'],
        },
        render: (_args, value) => text(value.deleted ? `Deleted scheduled task ${value.id}.` : `Scheduled task ${value.id} was not found.`),
      },
      presentCall: (args) => ({ card: 'generic', title: t('tool.delete'), content: String(args?.id || '') }),
      async execute(args, exec) {
        aborted(exec)
        const peer = await resolveCallerPeer(exec, getDshIm())
        const identity = resolveToolIdentity(exec, service)
        const id = requireId(args)
        try {
          const owned = await requireOwnedJob(service, id, peer, identity)
          assertAgentMayMutate(owned)
          await service.deleteJob(id)
          return { id, deleted: true }
        } catch (error) {
          if (error && error.code === 'NOT_FOUND') return { id, deleted: false }
          throw error
        }
      },
    },
  ]
}

export function cronGuidanceText(nowMs = Date.now(), timeZone = 'Asia/Shanghai') {
  const now = formatInZone(nowMs, timeZone)
  return [
    'This deployment has a DSH sidebar feature named 定时任务 (scheduled tasks / dsh-ops-cron).',
    'Jobs live in that list and fire a fresh session (and optionally deliver a summary to WhatsApp/IM). They are NOT OS crontab and NOT in-chat schedule_create reminders.',
    `Current local time for scheduling: ${now}. Use this calendar date for "today"/"tonight". Never invent another month or day.`,
    'For "in N minutes / 一分钟后", call cron_create with after_minutes=N only (do not also pass at, hour, or expr).',
    'For a clock time tonight, pass only hour and minute in 24h (晚上11点34 → hour=23, minute=34; 零点33 → hour=0, minute=33). Extra at/expr fields are ignored.',
    'Working directory: if the user is chatting in a workspace, pass cwd as that workspace filesystem path (the current session working directory). If they name another workspace, use that path. If cwd is omitted, cron_create uses the current session cwd.',
    'Model: omit provider+model to inherit the current session. If you pass them, use bare ids only (provider=zte, model=Qwen3-235B-A22B) — never pass "zte/Qwen3-…" as either field.',
    'Delivery: when chatting on WhatsApp/IM, omit delivery so the job defaults to im for the current chat (group→same group, DM→same DM). A 投递目标 is reused or auto-created. On Web/DSH, default is dsh. Or pass delivery=im with im_bot_id+im_target_id.',
    'Session mirror: by default the run summary is NOT injected into the origin WhatsApp/Web chat. Pass mirror_to_session=true only when the user wants follow-up context in that chat. Full tool traces always stay in run history; IM delivery (when configured) is independent.',
    'Agent preset: omit agent_preset to inherit (WhatsApp chat/group preset → creating session → Host default). Pass agent_preset to pin a preset for every scheduled run.',
    'Labels/monitor: pass labels={"role":"worker","task":"theory"} on workers; listeners pass watch={"taskId":"..."} or watch={"labels":{...},"match":"all"}. Use cron_query / cron_progress / cron_runs to poll state and progress.',
    'One-shot wake: cron_resume only unpauses. For a finished one-shot (retriggerable=true, next=n/a), call cron_retrigger. For a still-pending one-shot (has next), call cron_reschedule(after_minutes=N) instead of delete+create. For a recurring job, cron_retrigger starts one extra run immediately without changing the cron schedule.',
    'When the user asks to look at, create, pause, resume, retrigger, reschedule, or delete 定时任务 / scheduled tasks / cron jobs:',
    '1. If cron_list / cron_create / cron_pause / cron_resume / cron_retrigger / cron_reschedule / cron_delete / cron_query / cron_runs / cron_progress are in your tool list, call them.',
    '2. If they are not listed, load skill "scheduled-tasks" for usage guidance, then look again. skill_load does NOT inject tools — cron_* are registered by the dsh-ops-cron Host plugin at boot.',
    '3. If cron_* are still missing after a Host restart with the latest dsh-ops-cron, the plugin failed to register (check Host logs for unsupported JSON schema / tools.register). Tell the user; do not invent crontab workarounds.',
    '4. Never run crontab, never read /etc/cron*, and never say there are no tasks until cron_list has returned.',
  ].join('\n')
}

export const CRON_GUIDANCE = cronGuidanceText()

export function makeCronSkill() {
  return {
    name: 'scheduled-tasks',
    description: '定时任务: 查看、创建、暂停、恢复、改期、删除 DSH 侧栏定时任务（今天晚上几点、一次性执行、scheduled job、cron）。WhatsApp 里创建默认回投 IM；Web 里创建进侧栏会话。不要用系统 crontab，也不是会话内 reminder。',
    whenToUse: 'User asks to list or create 定时任务 / scheduled tasks, schedule something for tonight/today, pause/reschedule a job, or mentions cron in DeepSeek Harness.',
    source: 'runtime',
    provider: 'runtime',
    content: `${cronGuidanceText()}

Tools:
- cron_list — list jobs (optional state/labels/task_id filters)
- cron_query — listener query by taskId or labels; optional include_runs / decode_progress
- cron_runs — run history for a task_id
- cron_progress — read progress.channel.file snapshots
- cron_create — "一分钟后" → after_minutes=1. Clock time → hour+minute only. Do not send at/expr at the same time. Pass cwd as the current workspace path when creating from a workspace chat. Pass provider+model or inherit the current session model. Delivery and agent preset auto from session, or pass delivery=im / agent_preset explicitly. Session mirror is off by default; pass mirror_to_session=true only if the user wants the summary injected into the origin chat. Optional labels/watch/progress/report/persist_history for monitor workers and listeners.
- cron_pause / cron_resume / cron_retrigger / cron_reschedule / cron_delete — by id from cron_list. Use cron_retrigger to re-fire a consumed one-shot or to immediately start one extra run of a recurring job. Use cron_reschedule to move a still-pending one-shot (do not delete+create).
`,
  }
}

export const CRON_SKILL = makeCronSkill()

export function registerCronTools(ctx, service, deps = {}) {
  const tools = ctx?.tools
  if (!tools || typeof tools.register !== 'function') return () => {}
  const offs = cronToolDefinitions(service, deps).map((definition) => tools.register(definition))
  return () => {
    for (const off of offs) {
      if (typeof off === 'function') off()
    }
  }
}

export function registerCronGuidance(ctx) {
  if (typeof ctx?.skills?.register !== 'function') return () => {}
  const off = ctx.skills.register(makeCronSkill())
  return typeof off === 'function' ? off : () => {}
}
