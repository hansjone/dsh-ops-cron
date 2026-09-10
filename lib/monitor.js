/**
 * Monitor extensions: labels, watch, progress, report, job state projection.
 * Pure helpers — no Cordis / fs side effects except readProgressSnapshot.
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, normalize, resolve, sep } from 'node:path'
import { ACTIVE_RUN_STATUSES } from './fire-status.js'

export const LIFECYCLE_STATES = Object.freeze([
  'idle',
  'pending',
  'running',
  'succeeded',
  'failed',
  'paused',
])

/** Map internal run.status → public lifecycle state. */
export function runStatusToState(status) {
  if (status === 'queued') return 'pending'
  if (status === 'running') return 'running'
  if (status === 'succeeded') return 'succeeded'
  if (status === 'failed' || status === 'skipped') return 'failed'
  return 'idle'
}

/**
 * Normalize string→string label map. Empty keys dropped; values coerced to string.
 * @param {unknown} input
 * @returns {Record<string, string>}
 */
export function normalizeLabels(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const out = {}
  for (const [rawKey, rawVal] of Object.entries(input)) {
    const key = String(rawKey || '').trim()
    if (!key) continue
    if (rawVal === undefined || rawVal === null) continue
    out[key] = String(rawVal).trim()
  }
  return out
}

/**
 * @param {Record<string, string>} jobLabels
 * @param {Record<string, string>} query
 * @param {'any'|'all'} match
 */
export function labelsMatch(jobLabels, query, match = 'all') {
  const labels = normalizeLabels(jobLabels)
  const want = normalizeLabels(query)
  const keys = Object.keys(want)
  if (!keys.length) return true
  if (match === 'any') {
    return keys.some((key) => labels[key] === want[key])
  }
  return keys.every((key) => labels[key] === want[key])
}

/**
 * Watch declaration: taskId and/or labels (at least one).
 * @param {unknown} input
 */
export function normalizeWatch(input) {
  if (input == null || input === false) return null
  if (typeof input !== 'object' || Array.isArray(input)) {
    const error = new Error('watch must be an object with taskId and/or labels')
    error.code = 'INVALID_WATCH'
    throw error
  }
  const taskId = typeof input.taskId === 'string'
    ? input.taskId.trim()
    : (typeof input.task_id === 'string' ? input.task_id.trim() : '')
  const labels = normalizeLabels(input.labels)
  const match = input.match === 'any' ? 'any' : 'all'
  const timeoutMin = Number(input.timeout_min ?? input.timeoutMin)
  if (!taskId && !Object.keys(labels).length) {
    const error = new Error('watch requires taskId or labels')
    error.code = 'INVALID_WATCH'
    throw error
  }
  const watch = { match }
  if (taskId) watch.taskId = taskId
  if (Object.keys(labels).length) watch.labels = labels
  if (Number.isFinite(timeoutMin) && timeoutMin > 0) {
    watch.timeoutMin = Math.min(24 * 60, Math.round(timeoutMin))
  }
  return watch
}

/**
 * @param {unknown} input
 */
export function normalizeProgress(input) {
  if (input == null || input === false) return null
  if (typeof input !== 'object' || Array.isArray(input)) {
    const error = new Error('progress must be an object')
    error.code = 'INVALID_PROGRESS'
    throw error
  }
  const channelSrc = input.channel && typeof input.channel === 'object' ? input.channel : {}
  const file = typeof channelSrc.file === 'string' ? channelSrc.file.trim() : ''
  const kind = typeof channelSrc.kind === 'string'
    ? channelSrc.kind.trim().toLowerCase()
    : (file ? 'file' : '')
  if (kind && kind !== 'file' && kind !== 'dsh' && kind !== 'im' && kind !== 'grpc') {
    const error = new Error('progress.channel.kind must be file|dsh|im|grpc')
    error.code = 'INVALID_PROGRESS'
    throw error
  }
  if (kind === 'file' && !file) {
    const error = new Error('progress.channel.file is required when kind=file')
    error.code = 'INVALID_PROGRESS'
    throw error
  }
  const metricsIn = Array.isArray(input.metrics) ? input.metrics : []
  const metrics = []
  for (const row of metricsIn) {
    if (!row || typeof row !== 'object') continue
    const key = String(row.key || '').trim()
    if (!key) continue
    metrics.push({
      key,
      label: typeof row.label === 'string' ? row.label.trim() : key,
      unit: typeof row.unit === 'string' ? row.unit.trim() : '',
      ...typeof row.derived === 'string' && row.derived.trim()
        ? { derived: row.derived.trim() }
        : {},
    })
  }
  const progress = { metrics }
  if (kind || file) {
    progress.channel = {
      kind: kind || 'file',
      ...file ? { file } : {},
    }
  }
  return progress
}

/**
 * @param {unknown} input
 * @param {object|null} [jobDelivery] fallback delivery when report.delivery omitted
 */
export function normalizeReport(input, jobDelivery = null) {
  if (input == null || input === false) return null
  if (typeof input !== 'object' || Array.isArray(input)) {
    const error = new Error('report must be an object')
    error.code = 'INVALID_REPORT'
    throw error
  }
  const modeRaw = String(input.mode || 'on_complete').trim().toLowerCase()
  const mode = modeRaw === 'on_change' || modeRaw === 'periodic' || modeRaw === 'on_complete'
    ? modeRaw
    : 'on_complete'
  let deliveryKind = 'none'
  if (input.delivery === 'none' || input.delivery === false) {
    deliveryKind = 'none'
  } else if (input.delivery === 'dsh' || input.delivery === 'im') {
    deliveryKind = input.delivery
  } else if (input.delivery && typeof input.delivery === 'object') {
    deliveryKind = String(input.delivery.kind || 'none').toLowerCase() === 'im' ? 'im' : 'dsh'
  } else if (jobDelivery?.kind === 'im') {
    deliveryKind = 'im'
  } else if (jobDelivery?.kind === 'dsh') {
    deliveryKind = 'dsh'
  }
  const intervalMin = Number(input.interval_min ?? input.intervalMin)
  const report = { mode, delivery: deliveryKind }
  if (mode === 'periodic' && Number.isFinite(intervalMin) && intervalMin > 0) {
    report.intervalMin = Math.min(24 * 60, Math.round(intervalMin))
  }
  return report
}

/**
 * Persist history policy.
 * - forever: keep all terminal runs for this job (no prune of its rows)
 * - retain:N: keep last N terminals (default from settings)
 * - archive:endpoint: treat as forever locally + stash endpoint for future archive job
 * @param {unknown} input
 * @param {number} [defaultRetain]
 */
export function normalizePersistHistory(input, defaultRetain = 200) {
  if (input == null || input === '') {
    return { kind: 'retain', limit: defaultRetain }
  }
  if (typeof input === 'object' && !Array.isArray(input)) {
    const kind = String(input.kind || '').trim().toLowerCase()
    if (kind === 'forever') return { kind: 'forever' }
    if (kind === 'archive') {
      const endpoint = typeof input.endpoint === 'string' ? input.endpoint.trim() : ''
      return { kind: 'archive', endpoint: endpoint || '' }
    }
    if (kind === 'retain') {
      const limit = Number(input.limit ?? input.n)
      return {
        kind: 'retain',
        limit: Number.isInteger(limit) && limit >= 10 ? Math.min(50_000, limit) : defaultRetain,
      }
    }
  }
  const raw = String(input).trim().toLowerCase()
  if (raw === 'forever') return { kind: 'forever' }
  const retain = raw.match(/^retain:(\d+)$/)
  if (retain) {
    const limit = Number(retain[1])
    return {
      kind: 'retain',
      limit: Number.isInteger(limit) && limit >= 10 ? Math.min(50_000, limit) : defaultRetain,
    }
  }
  const archive = raw.match(/^archive:(.+)$/)
  if (archive) {
    return { kind: 'archive', endpoint: archive[1].trim() }
  }
  const error = new Error('persist_history must be forever | retain:N | archive:endpoint')
  error.code = 'INVALID_PERSIST_HISTORY'
  throw error
}

export function persistHistoryLimit(policy, settingsLimit = 200) {
  if (!policy || policy.kind === 'forever' || policy.kind === 'archive') return Number.POSITIVE_INFINITY
  if (policy.kind === 'retain' && Number.isInteger(policy.limit)) return policy.limit
  return settingsLimit
}

/**
 * One-shot job whose schedule has been consumed (next cleared) and has a terminal lastStatus.
 * Used by listeners to decide cron_retrigger vs wait.
 * @param {object|null} job
 * @param {object[]} [runs]
 */
export function isRetriggerable(job, runs = []) {
  if (!job || job.schedule?.kind !== 'at') return false
  if (job.nextRunAt != null) return false
  const terminal = job.lastStatus === 'succeeded'
    || job.lastStatus === 'failed'
    || job.lastStatus === 'skipped'
  if (!terminal) return false
  const list = Array.isArray(runs) ? runs : []
  if (list.some((run) => run && ACTIVE_RUN_STATUSES.has(run.status))) return false
  return true
}

/**
 * Project job + runs into a lifecycle state for listeners.
 * @param {object} job
 * @param {object[]} [runs] runs for this job (newest-first or any order)
 * @param {number} [now]
 */
export function projectJobState(job, runs = [], now = Date.now()) {
  if (!job) {
    return { state: 'idle', stateEnteredAt: null, activeRunId: null, stuck: false }
  }
  if (job.enabled === false) {
    return {
      state: 'paused',
      stateEnteredAt: job.updatedAt || job.createdAt || null,
      activeRunId: null,
      stuck: false,
    }
  }
  const list = Array.isArray(runs) ? runs : []
  const active = list.find((run) => run && ACTIVE_RUN_STATUSES.has(run.status))
  if (active) {
    const state = runStatusToState(active.status)
    const entered = active.stateEnteredAt || active.actualAt || active.scheduledAt || null
    const timeoutMs = Math.max(1, Number(job.timeoutMinutes) || 10) * 60_000
    const stuck = state === 'running'
      && Number.isFinite(entered)
      && (now - entered) > timeoutMs
    return { state, stateEnteredAt: entered, activeRunId: active.id, stuck }
  }
  const oneshotDone = job.schedule?.kind === 'at' && job.nextRunAt == null
  if (oneshotDone && (job.lastStatus === 'succeeded' || job.lastStatus === 'failed' || job.lastStatus === 'skipped')) {
    const last = list.find((run) => run && !ACTIVE_RUN_STATUSES.has(run.status))
      || null
    const state = job.lastStatus === 'succeeded' ? 'succeeded' : 'failed'
    return {
      state,
      stateEnteredAt: last?.exitedAt || last?.stateEnteredAt || last?.actualAt || job.lastRunAt || null,
      activeRunId: null,
      stuck: false,
    }
  }
  // Recurring (or one-shot waiting): idle between fires.
  return {
    state: 'idle',
    stateEnteredAt: job.lastRunAt || job.updatedAt || job.createdAt || null,
    activeRunId: null,
    stuck: false,
  }
}

/**
 * Jobs matching watch.taskId and/or watch.labels.
 * @param {object[]} jobs
 * @param {{ taskId?: string, labels?: Record<string,string>, match?: 'any'|'all' }} by
 */
export function selectJobsByWatch(jobs, by = {}) {
  const list = Array.isArray(jobs) ? jobs : []
  const taskId = typeof by.taskId === 'string' ? by.taskId.trim() : ''
  const labels = normalizeLabels(by.labels)
  const match = by.match === 'any' ? 'any' : 'all'
  let out = list
  if (taskId) out = out.filter((job) => job?.id === taskId)
  if (Object.keys(labels).length) {
    out = out.filter((job) => labelsMatch(job?.labels, labels, match))
  }
  return out
}

/**
 * Label-scoped single-runner: another job sharing ALL of `guardLabels` has active run.
 * Empty guardLabels → no cross-job guard.
 * @param {object} state
 * @param {object} job
 * @param {Record<string,string>} [guardLabels] defaults to job.labels when role+task present
 */
export function findLabelOverlapRun(state, job, guardLabels = null) {
  const labels = normalizeLabels(guardLabels || job?.labels)
  // Only enforce when both role and task are set (worker class), to avoid over-blocking.
  if (!labels.role || !labels.task) return null
  const jobs = (state?.jobs || []).filter((row) => row && row.id !== job.id && labelsMatch(row.labels, {
    role: labels.role,
    task: labels.task,
  }, 'all'))
  if (!jobs.length) return null
  const jobIds = new Set(jobs.map((row) => row.id))
  return (state?.runs || []).find((run) => (
    run
    && jobIds.has(run.jobId)
    && ACTIVE_RUN_STATUSES.has(run.status)
  )) || null
}

/**
 * Resolve progress file path under job cwd when relative.
 * Rejects path escape outside cwd for relative paths; absolute paths allowed when under cwd or allowAbsolute.
 */
export function resolveProgressFilePath(job, filePath) {
  const raw = String(filePath || '').trim()
  if (!raw) return null
  const cwd = String(job?.cwd || '').trim()
  const resolved = isAbsolute(raw) ? normalize(raw) : resolve(cwd || process.cwd(), raw)
  if (cwd) {
    const root = normalize(resolve(cwd))
    const target = normalize(resolved)
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`
    if (target !== root && !target.startsWith(prefix)) {
      // Absolute path outside cwd: still allow if job declared it explicitly (channel.file absolute).
      if (!isAbsolute(raw)) {
        const error = new Error('progress file must stay under job cwd')
        error.code = 'INVALID_PROGRESS_PATH'
        throw error
      }
    }
  }
  return resolved
}

/**
 * Read and lightly validate a progress snapshot JSON file.
 * @param {object} job
 * @returns {Promise<object|null>}
 */
export async function readProgressSnapshot(job) {
  const file = job?.progress?.channel?.file
  if (!file) return null
  const path = resolveProgressFilePath(job, file)
  if (!path) return null
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    return {
      taskId: parsed.taskId || job.id,
      state: parsed.state || null,
      updatedAt: parsed.updatedAt || null,
      metrics: parsed.metrics && typeof parsed.metrics === 'object' ? parsed.metrics : {},
      path,
    }
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error instanceof SyntaxError)) {
      return { taskId: job.id, state: null, updatedAt: null, metrics: {}, path, missing: true, error: error.message }
    }
    throw error
  }
}

/**
 * Format a short progress / state report line for IM or mirror.
 */
export function formatWatchReport(job, targets, progressById = {}) {
  const lines = [`[cron watch] ${job?.name || job?.id || 'watcher'}`]
  for (const target of targets || []) {
    const prog = progressById[target.id]
    const stuck = target.stuck ? ' STUCK' : ''
    const metrics = prog?.metrics && Object.keys(prog.metrics).length
      ? ` metrics=${JSON.stringify(prog.metrics)}`
      : ''
    lines.push(`- ${target.name || target.id}: ${target.state}${stuck}${metrics}`)
  }
  return lines.join('\n')
}
