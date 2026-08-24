/**
 * Model-facing tools for scheduled jobs.
 * Plain ToolDefinition objects — do not import @deepseek-ai/dsh-tools.
 */

import { formatInZone, resolveTodayAt } from './scheduler.js'

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
    schedule: { type: 'object', additionalProperties: true },
    createdAt: { type: 'number' },
    updatedAt: { type: 'number' },
    lastRunAt: {},
    lastStatus: {},
    nextRunAt: {},
  },
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
  const state = job.enabled === false ? 'paused' : 'enabled'
  const sched = job.schedule?.kind === 'at'
    ? `at ${job.schedule.at}`
    : (job.schedule?.expr || 'cron')
  const model = job.provider && job.model ? `${job.provider}/${job.model}` : 'default-model'
  return `${job.name} [${state}] ${sched} tz=${tz} cwd=${job.cwd || '(recent workspace)'} model=${model} next=${when} id=${job.id}`
}

export function callerWorkingDirectory(exec) {
  const session = exec?.agent?.session
  return String(session?.header?.cwd || session?.cwd || exec?.agent?.cwd || '').trim()
}

export function resolveCreateCwd(args, exec) {
  const passed = typeof args?.cwd === 'string' ? args.cwd.trim() : ''
  if (passed) return passed
  return callerWorkingDirectory(exec)
}

export function callerModelSelection(exec) {
  const opts = exec?.agent?.options || {}
  const provider = String(opts.provider || '').trim()
  const model = String(opts.model || '').trim()
  if (!provider || !model) return { provider: '', model: '', reasoningEffort: '' }
  const reasoningEffort = String(opts.reasoningEffort || '').trim()
  return { provider, model, reasoningEffort }
}

export function resolveCreateModel(args, exec) {
  const provider = typeof args?.provider === 'string' ? args.provider.trim() : ''
  const model = typeof args?.model === 'string' ? args.model.trim() : ''
  const reasoningEffort = typeof args?.reasoning_effort === 'string'
    ? args.reasoning_effort.trim()
    : (typeof args?.reasoningEffort === 'string' ? args.reasoningEffort.trim() : '')
  if (provider && model) return { provider, model, reasoningEffort }
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

export function cronToolDefinitions(service) {
  return [
    {
      name: 'cron_create',
      description: 'Create a DSH 定时任务 (sidebar scheduled job). NEVER use crontab. NOT schedule_create. Default timezone Asia/Shanghai. For "in N minutes / 一分钟后" pass only after_minutes. For "today/tonight at HH:MM" pass only hour+minute (24h; hour=0 is midnight). Do not also send at or expr. Extra schedule fields are ignored (after_minutes > hour > at > expr). cwd MUST be the current workspace path when chatting in a workspace; if omitted, uses the current session working directory. Pass provider+model for the job; if omitted, snapshots the current session model. Scheduled runs consume that model\'s quota, not whatever the user happens to have selected later.',
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
          cwd: { type: 'string', description: 'Filesystem path of the workspace this job should run in. When the user is in a workspace conversation, pass THAT workspace path (current session cwd). If omitted, the current session cwd is used. Only skip this to isolate from the project if the user asked for a custom folder.' },
          provider: { type: 'string', description: 'Provider route for this job (e.g. minimax-cn, deepseek). Must be passed with model. If omitted, the current session model is stored so quota stays predictable.' },
          model: { type: 'string', description: 'Model id for this job. Must be passed with provider. Scheduled runs bill this model.' },
          reasoning_effort: { type: 'string', description: 'Optional reasoning effort for this job.' },
          timeout_minutes: { type: 'integer', description: 'Per-run timeout in minutes, 1-240.' },
          enabled: { type: 'boolean', description: 'If false, create paused. Default true.' },
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
          return text(`Created "${job?.name}" (${job?.id}) ${sched} in ${tz}.${cwd}.${model}. Next run: ${when}. If that local time is wrong, delete this job and recreate with 24h hours (22=10pm).`)
        },
      },
      presentCall: (args) => ({ card: 'generic', title: '创建定时任务', content: String(args?.name || '') }),
      async execute(args, exec) {
        aborted(exec)
        const timeout = Number(args.timeout_minutes)
        try {
          const job = await service.createJob({
            name: args.name,
            prompt: args.prompt,
            schedule: scheduleFromArgs(args, Date.now()),
            cwd: resolveCreateCwd(args, exec),
            ...resolveCreateModel(args, exec),
            timeoutMinutes: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
            enabled: args.enabled !== false,
          })
          return { job }
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
      description: 'List DSH 定时任务 (sidebar scheduled jobs). Use this whenever the user asks what scheduled tasks exist. NEVER use crontab -l or /etc/cron* — those are OS crontabs, not this plugin.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled_only: { type: 'boolean', description: 'If true, omit paused jobs.' },
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
      presentCall: () => ({ card: 'generic', title: '列出定时任务' }),
      async execute(args, exec) {
        aborted(exec)
        let jobs = await service.listJobs()
        if (args?.enabled_only === true) jobs = jobs.filter((job) => job.enabled !== false)
        return { jobs, count: jobs.length }
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
      presentCall: (args) => ({ card: 'generic', title: '暂停定时任务', content: String(args?.id || '') }),
      async execute(args, exec) {
        aborted(exec)
        const job = await service.pauseJob(requireId(args), false)
        return { job }
      },
    },
    {
      name: 'cron_resume',
      description: 'Resume a paused scheduled task by id.',
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
      presentCall: (args) => ({ card: 'generic', title: '恢复定时任务', content: String(args?.id || '') }),
      async execute(args, exec) {
        aborted(exec)
        const job = await service.pauseJob(requireId(args), true)
        return { job }
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
      presentCall: (args) => ({ card: 'generic', title: '删除定时任务', content: String(args?.id || '') }),
      async execute(args, exec) {
        aborted(exec)
        const id = requireId(args)
        try {
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
    'This deployment has a DSH sidebar feature named 定时任务 (scheduled tasks).',
    'Jobs live in that list and fire a fresh session. They are NOT OS crontab and NOT in-chat schedule_create reminders.',
    `Current local time for scheduling: ${now}. Use this calendar date for "today"/"tonight". Never invent another month or day.`,
    'For "in N minutes / 一分钟后", call cron_create with after_minutes=N only (do not also pass at, hour, or expr).',
    'For a clock time tonight, pass only hour and minute in 24h (晚上11点34 → hour=23, minute=34; 零点33 → hour=0, minute=33). Extra at/expr fields are ignored.',
    'Working directory: if the user is chatting in a workspace, pass cwd as that workspace filesystem path (the current session working directory). If they name another workspace, use that path. If cwd is omitted, cron_create uses the current session cwd. Do not invent ~/.dsh/cron-tasks/workspace unless they asked for an isolated folder.',
    'Model: pass provider+model for the job. If omitted, cron_create stores the current session model. Scheduled runs consume that model\'s quota. Ask which model if the user cares about billing.',
    'When the user asks to look at, create, pause, resume, or delete 定时任务 / scheduled tasks / cron jobs:',
    '1. If cron_list / cron_create / cron_pause / cron_resume / cron_delete are in your tool list, call them.',
    '2. If they are not listed, search/unlock tools or skills with query "定时任务" or "cron" (skill_search, skill_load, or dev_tool_search) and then call them.',
    '3. Never run crontab, never read /etc/cron*, and never say there are no tasks until cron_list has returned.',
  ].join('\n')
}

export const CRON_GUIDANCE = cronGuidanceText()

export function makeCronSkill() {
  return {
    name: 'scheduled-tasks',
    description: '定时任务: 查看、创建、暂停、恢复、删除 DSH 侧栏定时任务（今天晚上几点、一次性执行、scheduled job、cron）。不要用系统 crontab，也不是会话内 reminder。',
    whenToUse: 'User asks to list or create 定时任务, schedule something for tonight/today, pause a job, or mentions cron / scheduled tasks in DeepSeek Harness.',
    source: 'runtime',
    provider: 'runtime',
    content: `${cronGuidanceText()}

Tools:
- cron_list — list jobs
- cron_create — "一分钟后" → after_minutes=1. Clock time → hour+minute only. Do not send at/expr at the same time. Pass cwd as the current workspace path when creating from a workspace chat. Pass provider+model or inherit the current session model.
- cron_pause / cron_resume / cron_delete — by id from cron_list
`,
  }
}

export const CRON_SKILL = makeCronSkill()

export function registerCronTools(ctx, service) {
  const tools = ctx?.tools
  if (!tools || typeof tools.register !== 'function') return () => {}
  const offs = cronToolDefinitions(service).map((definition) => tools.register(definition))
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
