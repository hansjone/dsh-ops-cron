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

export { UNASSIGNED_OWNER }

export const STORE_VERSION = 1

export const DEFAULT_SETTINGS = {
  enabled: true,
  timezone: 'Asia/Shanghai',
  historyLimit: 200,
  overlapPolicy: 'skip',
  misfirePolicy: 'skip',
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

export function pruneRuns(runs, historyLimit) {
  const list = Array.isArray(runs) ? runs : []
  const limit = Number.isInteger(historyLimit) ? historyLimit : DEFAULT_SETTINGS.historyLimit
  const active = []
  const terminal = []
  for (const run of list) {
    if (run && (run.status === 'queued' || run.status === 'running')) active.push(run)
    else terminal.push(run)
  }
  terminal.sort((a, b) => (b.actualAt || b.scheduledAt || 0) - (a.actualAt || a.scheduledAt || 0))
  return [...active, ...terminal.slice(0, Math.max(10, limit))]
}

export function listJobs(state) {
  return [...(state?.jobs || [])]
}

export function getJob(state, jobId) {
  return (state?.jobs || []).find((job) => job.id === jobId) || null
}

export function listHistory(state, jobId) {
  const runs = state?.runs || []
  const filtered = jobId ? runs.filter((run) => run.jobId === jobId) : runs
  return [...filtered].sort((a, b) => (b.actualAt || b.scheduledAt || 0) - (a.actualAt || a.scheduledAt || 0))
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
  isolated.runs = pruneRuns(isolated.runs, state.settings?.historyLimit)
  return isolated
}

export function patchRun(state, runId, patch) {
  const runs = (state.runs || []).map((run) => (
    run.id === runId ? { ...run, ...patch } : run
  ))
  let next = { ...state, runs }
  const updated = runs.find((run) => run.id === runId)
  if (updated?.sessionId) next = recordHiddenSession(next, updated.sessionId)
  next.runs = pruneRuns(next.runs, next.settings?.historyLimit)
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
      const parsed = JSON.parse(raw)
      state = hydrate(parsed)
    } catch (error) {
      if (error && error.code === 'ENOENT') state = emptyState()
      else throw error
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

function hydrate(parsed) {
  const base = emptyState()
  if (!parsed || typeof parsed !== 'object') return base
  return {
    version: STORE_VERSION,
    settings: normalizeSettings(parsed.settings),
    jobs: Array.isArray(parsed.jobs) ? parsed.jobs.filter((row) => row && row.id) : [],
    runs: Array.isArray(parsed.runs) ? parsed.runs.filter((row) => row && row.id) : [],
    hiddenSessionIds: Array.isArray(parsed.hiddenSessionIds)
      ? parsed.hiddenSessionIds.map(String)
      : [],
  }
}

export function storePath(dshHome) {
  return join(dshHome, 'ops-cron', 'store.json')
}
