/**
 * Durable JSON store for jobs, runs, and hidden session ids.
 * Atomic write (tmp + rename). No Cordis imports.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { applyRunIsolation, recordHiddenSession } from './isolation.js'
import { nextFire, validateSchedule } from './scheduler.js'
import { normalizeDelivery, normalizeOrigin } from './delivery.js'
import { normalizeAgentPresetId } from './preset.js'
import { normalizeOwnerEmpNo, UNASSIGNED_OWNER } from './ownership.js'
import {
  normalizeLabels,
  normalizePersistHistory,
  normalizeProgress,
  normalizeReport,
  normalizeWatch,
  persistHistoryLimit,
} from './monitor.js'
import { ACTIVE_RUN_STATUSES } from './fire-status.js'

export { UNASSIGNED_OWNER }

export const STORE_VERSION = 1

export const DEFAULT_SETTINGS = {
  enabled: true,
  timezone: 'Asia/Shanghai',
  historyLimit: 200,
  overlapPolicy: 'skip',
  misfirePolicy: 'skip',
  /**
   * When true (default), an explicit job cwd that lies OUTSIDE the multi-tenant
   * provision forest (workspaceRoot/<empNo>) is kept — e.g. D:\\code\\gpt.
   * Paths under the forest but not the owner's tree are still clamped.
   */
  allowExternalCwd: true,
}

export function emptyState() {
  return {
    version: STORE_VERSION,
    settings: { ...DEFAULT_SETTINGS },
    jobs: [],
    runs: [],
    hiddenSessionIds: [],
  }
}

export function normalizeSettings(input = {}, fallback = DEFAULT_SETTINGS) {
  const src = input && typeof input === 'object' ? input : {}
  const historyLimit = Number(src.historyLimit)
  const allowExternalCwd = src.allowExternalCwd !== undefined
    ? src.allowExternalCwd !== false
    : fallback.allowExternalCwd !== false
  return {
    enabled: src.enabled !== false,
    timezone: typeof src.timezone === 'string' && src.timezone.trim()
      ? src.timezone.trim()
      : fallback.timezone,
    historyLimit: Number.isInteger(historyLimit) && historyLimit >= 10
      ? Math.min(2000, historyLimit)
      : fallback.historyLimit,
    overlapPolicy: src.overlapPolicy === 'skip' ? 'skip' : fallback.overlapPolicy,
    misfirePolicy: src.misfirePolicy === 'skip' ? 'skip' : fallback.misfirePolicy,
    allowExternalCwd,
  }
}

function cloneState(state) {
  return structuredClone(state)
}

export function newId() {
  return randomUUID()
}

export function normalizeJobModel(input = {}) {
  const provider = typeof input.provider === 'string' ? input.provider.trim() : ''
  const model = typeof input.model === 'string' ? input.model.trim() : ''
  const reasoningEffort = typeof input.reasoningEffort === 'string'
    ? input.reasoningEffort.trim()
    : (typeof input.reasoning_effort === 'string' ? input.reasoning_effort.trim() : '')
  if (!provider && !model) {
    return { provider: '', model: '', reasoningEffort: '' }
  }
  if (!provider || !model) {
    const error = new Error('provider and model must be set together')
    error.code = 'INVALID_JOB'
    throw error
  }
  return { provider, model, reasoningEffort }
}

/**
 * @param {object} input
 * @param {object} state
 * @param {number} now
 */
export function createJobRecord(input, state, now) {
  const name = String(input?.name || '').trim()
  const prompt = String(input?.prompt || '').trim()
  if (!name) {
    const error = new Error('name is required')
    error.code = 'INVALID_JOB'
    throw error
  }
  if (!prompt) {
    const error = new Error('prompt is required')
    error.code = 'INVALID_JOB'
    throw error
  }
  const settings = state.settings || DEFAULT_SETTINGS
  const schedule = validateSchedule(input.schedule, settings.timezone)
  const timeoutMinutes = Number(input.timeoutMinutes)
  const model = normalizeJobModel(input)
  const delivery = normalizeDelivery(input.delivery)
  const origin = normalizeOrigin(input.origin)
  const agentPreset = normalizeAgentPresetId(input.agentPreset ?? input.agent_preset)
  const mirrorToSession = input.mirrorToSession === true
    || input.mirror_to_session === true
  const ownerEmpNo = normalizeOwnerEmpNo(input.ownerEmpNo)
  const ownerDisplayName = typeof input.ownerDisplayName === 'string'
    ? input.ownerDisplayName.trim().slice(0, 80)
    : ''
  const labels = normalizeLabels(input.labels)
  const watch = input.watch !== undefined ? normalizeWatch(input.watch) : null
  const progress = input.progress !== undefined ? normalizeProgress(input.progress) : null
  const report = input.report !== undefined
    ? normalizeReport(input.report, delivery)
    : null
  const persistHistory = normalizePersistHistory(
    input.persistHistory ?? input.persist_history,
    settings.historyLimit,
  )
  const job = {
    id: String(input.id || newId()),
    name,
    prompt,
    enabled: input.enabled !== false,
    cwd: typeof input.cwd === 'string' ? input.cwd.trim() : '',
    timeoutMinutes: Number.isFinite(timeoutMinutes) && timeoutMinutes >= 1
      ? Math.min(240, Math.round(timeoutMinutes))
      : 10,
    provider: model.provider,
    model: model.model,
    reasoningEffort: model.reasoningEffort,
    agentPreset,
    delivery,
    mirrorToSession,
    ownerEmpNo,
    ownerDisplayName,
    labels,
    ...watch ? { watch } : {},
    ...progress ? { progress } : {},
    ...report ? { report } : {},
    persistHistory,
    ...origin ? { origin } : {},
    schedule: schedule.kind === 'cron'
      ? { kind: 'cron', expr: schedule.expr, timezone: schedule.timezone }
      : { kind: 'at', at: new Date(schedule.at).toISOString(), timezone: schedule.timezone },
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    lastStatus: null,
    nextRunAt: nextFire(schedule, now, schedule.timezone),
  }
  if (schedule.kind === 'at') {
    const atMs = Date.parse(job.schedule.at)
    // Slightly past (within 60s): fire on next tick instead of rejecting or freezing.
    if (Number.isFinite(atMs) && atMs <= now && atMs >= now - 60_000) {
      job.nextRunAt = now
    } else if (job.nextRunAt == null || job.nextRunAt < now - 60_000) {
      const error = new Error(`that one-shot time is already in the past (now is ${new Date(now).toISOString()})`)
      error.code = 'INVALID_AT'
      throw error
    }
  }
  return job
}

export function pruneRuns(runs, historyLimit, jobs = []) {
  const list = Array.isArray(runs) ? runs : []
  const defaultLimit = Number.isInteger(historyLimit) ? historyLimit : DEFAULT_SETTINGS.historyLimit
  const byJob = new Map()
  for (const job of jobs || []) {
    if (job?.id) byJob.set(job.id, job)
  }
  const active = []
  /** @type {Map<string, object[]>} */
  const terminalsByJob = new Map()
  const orphanTerminal = []
  for (const run of list) {
    if (!run) continue
    if (ACTIVE_RUN_STATUSES.has(run.status)) {
      active.push(run)
      continue
    }
    const jobId = run.jobId || ''
    if (!jobId || !byJob.has(jobId)) {
      orphanTerminal.push(run)
      continue
    }
    if (!terminalsByJob.has(jobId)) terminalsByJob.set(jobId, [])
    terminalsByJob.get(jobId).push(run)
  }
  const keptTerminal = []
  for (const [jobId, rows] of terminalsByJob) {
    const job = byJob.get(jobId)
    const policy = job?.persistHistory
      || normalizePersistHistory(undefined, defaultLimit)
    const limit = persistHistoryLimit(policy, defaultLimit)
    rows.sort((a, b) => (b.actualAt || b.scheduledAt || 0) - (a.actualAt || a.scheduledAt || 0))
    if (!Number.isFinite(limit)) {
      keptTerminal.push(...rows)
    } else {
      keptTerminal.push(...rows.slice(0, Math.max(10, limit)))
    }
  }
  orphanTerminal.sort((a, b) => (b.actualAt || b.scheduledAt || 0) - (a.actualAt || a.scheduledAt || 0))
  keptTerminal.push(...orphanTerminal.slice(0, Math.max(10, defaultLimit)))
  return [...active, ...keptTerminal]
}

export function listJobs(state) {
  return [...(state?.jobs || [])]
}

export function getJob(state, jobId) {
  return (state?.jobs || []).find((job) => job.id === jobId) || null
}

/**
 * Filter history with optional state / time / cursor pagination.
 * @returns {{ runs: object[], nextCursor: string|null, total: number }}
 */
export function listHistoryPage(state, jobId, opts = {}) {
  const runs = state?.runs || []
  let filtered = jobId ? runs.filter((run) => run.jobId === jobId) : [...runs]
  const stateFilter = typeof opts.state === 'string' ? opts.state.trim() : ''
  if (stateFilter) {
    filtered = filtered.filter((run) => {
      if (stateFilter === 'pending') return run.status === 'queued'
      if (stateFilter === 'running') return run.status === 'running'
      if (stateFilter === 'succeeded') return run.status === 'succeeded'
      if (stateFilter === 'failed') return run.status === 'failed' || run.status === 'skipped'
      return run.status === stateFilter
    })
  }
  const from = Number(opts.from)
  const to = Number(opts.to)
  if (Number.isFinite(from)) {
    filtered = filtered.filter((run) => (run.actualAt || run.scheduledAt || 0) >= from)
  }
  if (Number.isFinite(to)) {
    filtered = filtered.filter((run) => (run.actualAt || run.scheduledAt || 0) <= to)
  }
  filtered.sort((a, b) => (b.actualAt || b.scheduledAt || 0) - (a.actualAt || a.scheduledAt || 0))
  const cursor = typeof opts.cursor === 'string' ? opts.cursor.trim() : ''
  if (cursor) {
    const idx = filtered.findIndex((run) => run.id === cursor)
    if (idx >= 0) filtered = filtered.slice(idx + 1)
  }
  const limit = Number(opts.limit)
  const take = Number.isInteger(limit) && limit > 0 ? Math.min(500, limit) : filtered.length
  const page = filtered.slice(0, take)
  const nextCursor = page.length && filtered.length > page.length
    ? page[page.length - 1].id
    : null
  return { runs: page, nextCursor, total: filtered.length }
}

/** @deprecated-compatible: returns sorted run array (no pagination). */
export function listHistory(state, jobId) {
  return listHistoryPage(state, jobId).runs
}

export function upsertJob(state, job) {
  const jobs = [...(state.jobs || [])]
  const index = jobs.findIndex((row) => row.id === job.id)
  if (index === -1) jobs.unshift(job)
  else jobs[index] = job
  return { ...state, jobs }
}

export function removeJob(state, jobId) {
  return {
    ...state,
    jobs: (state.jobs || []).filter((job) => job.id !== jobId),
  }
}

export function appendRun(state, run) {
  const isolated = applyRunIsolation(state, run)
  isolated.runs = pruneRuns(isolated.runs, state.settings?.historyLimit, isolated.jobs)
  return isolated
}

export function patchRun(state, runId, patch) {
  const runs = (state.runs || []).map((run) => (
    run.id === runId ? { ...run, ...patch } : run
  ))
  let next = { ...state, runs }
  const updated = runs.find((run) => run.id === runId)
  if (updated?.sessionId) next = recordHiddenSession(next, updated.sessionId)
  next.runs = pruneRuns(next.runs, next.settings?.historyLimit, next.jobs)
  return next
}

export function createStore(options = {}) {
  const filePath = options.filePath
  if (!filePath) throw new Error('store filePath is required')
  let state = emptyState()
  let loaded = false
  let queue = Promise.resolve()

  async function load() {
    try {
      const raw = await readFile(filePath, 'utf8')
      // Reject embedded NUL — JSON.parse would throw an opaque "Unexpected token".
      if (raw.includes('\u0000')) {
        const error = new Error(`ops-cron store is corrupt (NUL byte) at ${filePath}; moved aside and starting empty`)
        error.code = 'STORE_CORRUPT'
        try {
          const bak = `${filePath}.corrupt.${Date.now()}.bak`
          await rename(filePath, bak)
          error.message = `${error.message} (backup: ${bak})`
        } catch {
          // best-effort quarantine; persist() below overwrites either way
        }
        console.warn(`[dsh-ops-cron] ${error.message}`)
        state = emptyState()
        loaded = true
        await persist()
        return snapshot()
      }
      const parsed = JSON.parse(raw)
      state = hydrate(parsed)
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        state = emptyState()
      } else if (error instanceof SyntaxError) {
        const wrapped = new Error(`ops-cron store JSON parse failed at ${filePath}: ${error.message}`)
        wrapped.code = 'STORE_CORRUPT'
        wrapped.cause = error
        try {
          const raw = await readFile(filePath, 'utf8').catch(() => '')
          if (raw) await writeFile(`${filePath}.corrupt.${Date.now()}.bak`, raw, 'utf8')
        } catch {
          // ignore
        }
        console.warn(`[dsh-ops-cron] ${wrapped.message}; starting empty store`)
        state = emptyState()
        loaded = true
        await persist()
        return snapshot()
      } else {
        throw error
      }
    }
    loaded = true
    return snapshot()
  }

  async function persist() {
    await mkdir(dirname(filePath), { recursive: true })
    const tmp = join(dirname(filePath), `.store.${randomUUID()}.tmp`)
    const body = `${JSON.stringify(state, null, 2)}\n`
    await writeFile(tmp, body, 'utf8')
    await rename(tmp, filePath)
  }

  function snapshot() {
    return cloneState(state)
  }

  function mutate(fn) {
    const run = async () => {
      if (!loaded) await load()
      const next = await fn(snapshot())
      if (!next || typeof next !== 'object') throw new Error('store mutator must return state')
      state = next
      await persist()
      return snapshot()
    }
    const pending = queue.then(run, run)
    queue = pending.then(() => undefined, () => undefined)
    return pending
  }

  return {
    filePath,
    snapshot,
    load,
    mutate,
    async read() {
      if (!loaded) await load()
      return snapshot()
    },
  }
}

function hydrateJob(row, settings) {
  if (!row || !row.id) return null
  const labels = normalizeLabels(row.labels)
  let watch = null
  let progress = null
  let report = null
  try {
    watch = row.watch ? normalizeWatch(row.watch) : null
  } catch {
    watch = null
  }
  try {
    progress = row.progress ? normalizeProgress(row.progress) : null
  } catch {
    progress = null
  }
  try {
    report = row.report ? normalizeReport(row.report, row.delivery) : null
  } catch {
    report = null
  }
  let persistHistory
  try {
    persistHistory = normalizePersistHistory(
      row.persistHistory ?? row.persist_history,
      settings?.historyLimit,
    )
  } catch {
    persistHistory = normalizePersistHistory(undefined, settings?.historyLimit)
  }
  const hydrated = {
    ...row,
    labels,
    persistHistory,
  }
  if (watch) hydrated.watch = watch
  else delete hydrated.watch
  if (progress) hydrated.progress = progress
  else delete hydrated.progress
  if (report) hydrated.report = report
  else delete hydrated.report
  return hydrated
}

function hydrateRun(row) {
  if (!row || !row.id) return null
  return {
    ...row,
    stateEnteredAt: row.stateEnteredAt ?? row.actualAt ?? row.scheduledAt ?? null,
    exitedAt: row.exitedAt ?? (
      row.status && !ACTIVE_RUN_STATUSES.has(row.status) ? (row.actualAt || null) : null
    ),
    outputRef: row.outputRef || null,
  }
}

function hydrate(parsed) {
  const base = emptyState()
  if (!parsed || typeof parsed !== 'object') return base
  const settings = normalizeSettings(parsed.settings)
  const jobs = Array.isArray(parsed.jobs)
    ? parsed.jobs.map((row) => hydrateJob(row, settings)).filter(Boolean)
    : []
  const runs = Array.isArray(parsed.runs)
    ? parsed.runs.map(hydrateRun).filter(Boolean)
    : []
  return {
    version: STORE_VERSION,
    settings,
    jobs,
    runs,
    hiddenSessionIds: Array.isArray(parsed.hiddenSessionIds)
      ? parsed.hiddenSessionIds.map(String)
      : [],
  }
}

export function storePath(dshHome) {
  return join(dshHome, 'ops-cron', 'store.json')
}
