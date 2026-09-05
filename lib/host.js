/**
 * Host service used by apply() and by tests.
 * Owns the durable store, the single timer, CRUD, and the fire path.
 */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { claimOccurrence, executeClaimedRun, extractAssistantText, interruptActiveRuns, publicJob, settleRun, TITLE_PREFIX } from './fire.js'
import { deliverRunToIm } from './delivery.js'
import { workspaceVisibleIds } from './isolation.js'
import { decideDispatch, nextFire, validateSchedule } from './scheduler.js'
import {
  createJobRecord,
  createStore,
  DEFAULT_SETTINGS,
  getJob,
  listHistory,
  listJobs,
  normalizeSettings,
  removeJob,
  storePath,
  upsertJob,
} from './store.js'

export const PLUGIN_NAME = 'dsh-ops-cron'
export const API_PREFIX = '/dsh-ops-cron'

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function defaultCwd() {
  return join(dshHome(), 'ops-cron', 'workspace')
}

function json(res, status, body) {
  if (res.headersSent || res.writableEnded) return
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function parseUrl(req) {
  try {
    return new URL(req.url || '/', 'http://dsh.local')
  } catch {
    return new URL('http://dsh.local/')
  }
}

function isTrustedApiRequest(request) {
  const host = request.headers.host ?? ''
  if (!host) return false
  const hostname = host.split(':')[0].replace(/^\[|\]$/g, '')
  if ((request.headers['sec-fetch-site'] ?? '') === 'cross-site') return false
  const origin = request.headers.origin
  if (origin !== undefined && origin !== 'null') {
    try {
      if (new URL(origin).host !== host) return false
    } catch {
      return false
    }
  }
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '0.0.0.0'
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  const max = 256 * 1024
  for await (const chunk of req) {
    size += chunk.length
    if (size > max) {
      const error = new Error('payload too large')
      error.code = 'PAYLOAD_TOO_LARGE'
      throw error
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  return JSON.parse(text)
}

function jobView(job) {
  return publicJob(job)
}

function runView(run) {
  if (!run) return null
  return {
    id: run.id,
    jobId: run.jobId,
    scheduledAt: run.scheduledAt,
    actualAt: run.actualAt,
    status: run.status,
    trigger: run.trigger,
    sessionId: run.sessionId,
    error: run.error,
    summary: run.summary,
    reason: run.reason,
  }
}

/**
 * @param {object} options
 * @param {() => number} [options.now]
 * @param {string} [options.filePath]
 * @param {object} [options.sessionPort] { createAndPrompt, archiveSession, waitForTurn }
 * @param {() => object|undefined} [options.getDshIm] soft-injected proactive IM API
 * @param {{ warn?: Function, info?: Function }} [options.logger]
 * @param {number} [options.tickIntervalMs]
 */
export function createHostService(options = {}) {
  const now = options.now || (() => Date.now())
  const filePath = options.filePath || storePath(dshHome())
  const store = options.store || createStore({ filePath })
  const sessionPort = options.sessionPort || null
  const getDshIm = typeof options.getDshIm === 'function' ? options.getDshIm : () => undefined
  const logger = options.logger || console
  const tickIntervalMs = Number(options.tickIntervalMs) > 0 ? Number(options.tickIntervalMs) : 15_000
  let timer = null
  let ticking = false

  async function withState(fn) {
    return store.mutate(fn)
  }

  async function snapshot() {
    return store.read()
  }

  async function maybeDeliverIm(job, run) {
    if (!job || job.delivery?.kind !== 'im') return
    try {
      await deliverRunToIm(job, run?.summary, { dshIm: getDshIm() })
      logger.info?.(`[dsh-ops-cron] im delivery sent for job ${job.id} → ${job.delivery.targetId}`)
    } catch (error) {
      logger.warn?.(`[dsh-ops-cron] im delivery failed for job ${job.id}: ${error instanceof Error ? error.message : error}`)
    }
  }

  async function createJob(input) {
    const t = now()
    let created
    await withState((current) => {
      created = createJobRecord(input, current, t)
      return upsertJob(current, created)
    })
    return jobView(created)
  }

  async function updateJob(jobId, patch) {
    const t = now()
    const state = await withState((current) => {
      const job = getJob(current, jobId)
      if (!job) {
        const error = new Error('job not found')
        error.code = 'NOT_FOUND'
        throw error
      }
      const nextInput = {
        id: job.id,
        name: patch.name !== undefined ? patch.name : job.name,
        prompt: patch.prompt !== undefined ? patch.prompt : job.prompt,
        enabled: patch.enabled !== undefined ? patch.enabled : job.enabled,
        schedule: patch.schedule !== undefined ? patch.schedule : job.schedule,
        cwd: patch.cwd !== undefined ? patch.cwd : job.cwd,
        timeoutMinutes: patch.timeoutMinutes !== undefined ? patch.timeoutMinutes : job.timeoutMinutes,
        provider: patch.provider !== undefined ? patch.provider : job.provider,
        model: patch.model !== undefined ? patch.model : job.model,
        reasoningEffort: patch.reasoningEffort !== undefined ? patch.reasoningEffort : job.reasoningEffort,
        delivery: patch.delivery !== undefined ? patch.delivery : job.delivery,
      }
      const record = createJobRecord(nextInput, current, t)
      record.createdAt = job.createdAt
      record.lastRunAt = job.lastRunAt
      record.lastStatus = job.lastStatus
      if (patch.schedule === undefined && patch.enabled === undefined) {
        record.nextRunAt = job.nextRunAt
      }
      return upsertJob(current, record)
    })
    return jobView(getJob(state, jobId))
  }

  async function pauseJob(jobId, enabled) {
    return updateJob(jobId, { enabled })
  }

  async function deleteJob(jobId) {
    await withState((current) => {
      if (!getJob(current, jobId)) {
        const error = new Error('job not found')
        error.code = 'NOT_FOUND'
        throw error
      }
      return removeJob(current, jobId)
    })
    return { ok: true, id: jobId }
  }

  async function updateSettings(patch) {
    const state = await withState((current) => ({
      ...current,
      settings: normalizeSettings({ ...current.settings, ...patch }, current.settings),
    }))
    return state.settings
  }

  async function dispatchRun(jobId, trigger) {
    let claimed
    const t = now()
    await withState((current) => {
      claimed = claimOccurrence(current, jobId, t, trigger, current.settings)
      if (claimed.decision.action === 'wait') return current
      return claimed.state
    })
    if (!claimed.run) return { job: claimed.job, run: null, decision: claimed.decision }
    if (claimed.run.status === 'skipped') {
      return { job: claimed.job, run: runView(claimed.run), decision: claimed.decision }
    }
    const executed = await store.mutate(async (current) => {
      const result = await executeClaimedRun(current, claimed.run.id, {
        now,
        createAndPrompt: sessionPort?.createAndPrompt,
        archiveSession: sessionPort?.archiveSession,
      })
      return result.state
    })
    let run = (executed.runs || []).find((row) => row.id === claimed.run.id)
    if (run?.status === 'running' && typeof sessionPort?.waitForTurn === 'function') {
      let terminal
      try {
        terminal = await sessionPort.waitForTurn(run.sessionId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        terminal = { status: 'failed', error: message, summary: message }
      }
      const settled = await store.mutate((current) => settleRun(current, run.id, terminal, now()))
      run = (settled.runs || []).find((row) => row.id === claimed.run.id)
      const job = getJob(settled, jobId)
      await maybeDeliverIm(job, run)
      return { job: jobView(job), run: runView(run), decision: claimed.decision }
    }
    const job = getJob(executed, jobId)
    await maybeDeliverIm(job, run)
    return { job: jobView(job), run: runView(run), decision: claimed.decision }
  }

  async function tick() {
    if (ticking) return []
    ticking = true
    const fired = []
    try {
      const state = await snapshot()
      if (state.settings?.enabled === false) return fired
      const t = now()
      for (const job of listJobs(state)) {
        if (job.enabled === false) continue
        const runs = (state.runs || []).filter((run) => run.jobId === job.id)
        const decision = decideDispatch({
          job,
          runs,
          now: t,
          overlapPolicy: state.settings.overlapPolicy,
          misfirePolicy: state.settings.misfirePolicy,
        })
        if (decision.action === 'wait') continue
        const result = await dispatchRun(job.id, 'schedule')
        if (result.run) fired.push(result)
      }
      return fired
    } finally {
      ticking = false
    }
  }

  function startTimer() {
    if (timer) return
    timer = setInterval(() => {
      tick().catch(() => {})
    }, tickIntervalMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  function stopTimer() {
    if (!timer) return
    clearInterval(timer)
    timer = null
  }

  async function concealKnownSessions() {
    if (typeof sessionPort?.archiveSession !== 'function') return 0
    const state = await snapshot()
    const ids = new Set()
    for (const id of state.hiddenSessionIds || []) if (id) ids.add(id)
    for (const run of state.runs || []) if (run?.sessionId) ids.add(run.sessionId)
    let hidden = 0
    for (const id of ids) {
      try {
        await sessionPort.archiveSession(id)
        hidden += 1
      } catch {
        // Session may already be gone.
      }
    }
    return hidden
  }

  async function recover() {
    await mkdir(join(dshHome(), 'ops-cron'), { recursive: true })
    const t = now()
    await withState((current) => {
      let next = interruptActiveRuns(current, t)
      next = {
        ...next,
        jobs: (next.jobs || []).map((job) => {
          try {
            if (job.nextRunAt === null) return job
            if (Number.isFinite(job.nextRunAt) && job.nextRunAt > t) return job
            const nextRunAt = nextFire(job.schedule, t, job.schedule?.timezone || next.settings.timezone)
            return { ...job, nextRunAt }
          } catch {
            return job
          }
        }),
      }
      return next
    })
    await concealKnownSessions()
  }

  async function handleRequest(req, res) {
    const url = parseUrl(req)
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const method = (req.method || 'GET').toUpperCase()
    const write = (status, body) => json(res, status, body)

    try {
      if (path === `${API_PREFIX}/health` && method === 'GET') {
        const state = await snapshot()
        write(200, {
          ok: true,
          plugin: PLUGIN_NAME,
          enabled: state.settings.enabled !== false,
          jobCount: (state.jobs || []).length,
        })
        return
      }

      if (path === `${API_PREFIX}/settings` && method === 'GET') {
        const state = await snapshot()
        write(200, { ok: true, settings: state.settings })
        return
      }

      if (path === `${API_PREFIX}/settings` && method === 'PUT') {
        if (!isTrustedApiRequest(req)) return write(403, { ok: false, error: 'forbidden' })
        const body = await readJsonBody(req)
        const settings = await updateSettings(body)
        write(200, { ok: true, settings })
        return
      }

      if (path === `${API_PREFIX}/models` && method === 'GET') {
        const catalog = typeof sessionPort?.listModels === 'function'
          ? await sessionPort.listModels()
          : { groups: [], current: null }
        write(200, { ok: true, ...catalog })
        return
      }

      if (path === `${API_PREFIX}/workspaces` && method === 'GET') {
        const workspaces = typeof sessionPort?.listWorkspaces === 'function'
          ? await sessionPort.listWorkspaces()
          : []
        write(200, { ok: true, workspaces: Array.isArray(workspaces) ? workspaces : [] })
        return
      }

      if (path === `${API_PREFIX}/jobs` && method === 'GET') {
        const state = await snapshot()
        write(200, { ok: true, jobs: listJobs(state).map(jobView) })
        return
      }

      if (path === `${API_PREFIX}/jobs` && method === 'POST') {
        if (!isTrustedApiRequest(req)) return write(403, { ok: false, error: 'forbidden' })
        const body = await readJsonBody(req)
        const job = await createJob(body)
        write(200, { ok: true, job })
        return
      }

      const jobMatch = path.match(new RegExp(`^${API_PREFIX}/jobs/([^/]+)(/run|/pause|/resume)?$`))
      if (jobMatch) {
        const jobId = decodeURIComponent(jobMatch[1])
        const rest = jobMatch[2] || ''
        if (method === 'GET' && !rest) {
          const state = await snapshot()
          const job = getJob(state, jobId)
          if (!job) return write(404, { ok: false, error: 'job not found' })
          write(200, { ok: true, job: jobView(job) })
          return
        }
        if (!isTrustedApiRequest(req)) return write(403, { ok: false, error: 'forbidden' })
        if (method === 'PATCH' && !rest) {
          const body = await readJsonBody(req)
          const job = await updateJob(jobId, body)
          write(200, { ok: true, job })
          return
        }
        if (method === 'DELETE' && !rest) {
          await deleteJob(jobId)
          write(200, { ok: true, id: jobId })
          return
        }
        if (method === 'POST' && rest === '/run') {
          const result = await dispatchRun(jobId, 'run-now')
          write(200, { ok: true, ...result })
          return
        }
        if (method === 'POST' && rest === '/pause') {
          const job = await pauseJob(jobId, false)
          write(200, { ok: true, job })
          return
        }
        if (method === 'POST' && rest === '/resume') {
          const job = await pauseJob(jobId, true)
          write(200, { ok: true, job })
          return
        }
      }

      const openMatch = path.match(new RegExp(`^${API_PREFIX}/runs/([^/]+)/open$`))
      if (openMatch && method === 'POST') {
        if (!isTrustedApiRequest(req)) return write(403, { ok: false, error: 'forbidden' })
        const runId = decodeURIComponent(openMatch[1])
        const state = await snapshot()
        const run = (state.runs || []).find((row) => row.id === runId)
        if (!run?.sessionId) return write(404, { ok: false, error: 'run not found' })
        let unarchived = false
        if (typeof sessionPort?.revealSession === 'function') {
          unarchived = await sessionPort.revealSession(run.sessionId)
        }
        write(200, { ok: true, sessionId: run.sessionId, runId: run.id, unarchived: unarchived !== false })
        return
      }

      const adoptMatch = path.match(new RegExp(`^${API_PREFIX}/sessions/([^/]+)/adopt$`))
      if (adoptMatch && method === 'POST') {
        if (!isTrustedApiRequest(req)) return write(403, { ok: false, error: 'forbidden' })
        const sessionId = decodeURIComponent(adoptMatch[1])
        if (!sessionId) return write(400, { ok: false, error: 'sessionId required' })
        if (typeof sessionPort?.adoptSession !== 'function') {
          return write(200, { ok: false, attached: false, sessionId })
        }
        const result = await sessionPort.adoptSession(sessionId)
        write(200, { ok: true, sessionId, ...result })
        return
      }

      if (path === `${API_PREFIX}/conceal` && method === 'POST') {
        if (!isTrustedApiRequest(req)) return write(403, { ok: false, error: 'forbidden' })
        const hidden = await concealKnownSessions()
        write(200, { ok: true, hidden })
        return
      }

      if (path === `${API_PREFIX}/history` && method === 'GET') {
        const state = await snapshot()
        const jobId = url.searchParams.get('jobId') || undefined
        write(200, { ok: true, runs: listHistory(state, jobId).map(runView) })
        return
      }

      if (path === `${API_PREFIX}/preview` && method === 'POST') {
        const body = await readJsonBody(req)
        const settings = (await snapshot()).settings
        const schedule = validateSchedule(body.schedule || body, body.timezone || settings.timezone)
        const nextRunAt = nextFire(schedule, now(), schedule.timezone)
        write(200, { ok: true, nextRunAt, schedule })
        return
      }

      if (path === `${API_PREFIX}/workspace-visible` && method === 'GET') {
        const state = await snapshot()
        const listed = url.searchParams.getAll('id')
        write(200, {
          ok: true,
          hiddenSessionIds: state.hiddenSessionIds || [],
          visible: workspaceVisibleIds(listed, state.hiddenSessionIds),
        })
        return
      }

      write(404, { ok: false, error: 'not found' })
    } catch (error) {
      const code = error && error.code
      if (code === 'NOT_FOUND') return write(404, { ok: false, error: error.message })
      if (code === 'INVALID_CRON' || code === 'INVALID_AT' || code === 'INVALID_SCHEDULE' || code === 'INVALID_JOB' || code === 'INVALID_TIMEZONE') {
        return write(400, { ok: false, error: error.message, code })
      }
      if (code === 'PAYLOAD_TOO_LARGE') return write(413, { ok: false, error: 'payload too large' })
      write(500, { ok: false, error: error instanceof Error ? error.message : 'internal error' })
    }
  }

  return {
    store,
    now,
    createJob,
    updateJob,
    pauseJob,
    deleteJob,
    updateSettings,
    dispatchRun,
    tick,
    recover,
    startTimer,
    stopTimer,
    handleRequest,
    snapshot,
    async listJobs() {
      return listJobs(await snapshot()).map(jobView)
    },
    async listHistory(jobId) {
      return listHistory(await snapshot(), jobId).map(runView)
    },
    workspaceVisibleIds(allIds) {
      const hidden = store.snapshot().hiddenSessionIds
      return workspaceVisibleIds(allIds, hidden)
    },
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withTimeout(promise, ms, message) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(message)
          error.code = 'RUN_TIMEOUT'
          reject(error)
        }, ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Wait until a live agent finishes the turn started by followup.
 * `whenIdle` alone can resolve before the driver wakes; poll for `running` first.
 */
export async function waitForAgentTurn(agent, options = {}) {
  if (!agent) {
    return { status: 'failed', error: 'agent missing', summary: 'Agent disappeared after dispatch' }
  }
  const startTimeoutMs = Number.isFinite(options.startTimeoutMs) ? options.startTimeoutMs : 30_000
  const turnTimeoutMs = Number.isFinite(options.turnTimeoutMs) ? options.turnTimeoutMs : 10 * 60 * 1000
  const started = Date.now()
  let sawRunning = agent.status === 'running'
  while (!sawRunning && Date.now() - started < startTimeoutMs) {
    if (agent.status === 'running') {
      sawRunning = true
      break
    }
    await sleep(20)
  }
  if (agent.status === 'running') sawRunning = true
  if (sawRunning && typeof agent.whenIdle === 'function') {
    await withTimeout(agent.whenIdle(), turnTimeoutMs, 'run timed out')
    return { status: 'succeeded', summary: 'Turn finished' }
  }
  return {
    status: 'failed',
    error: 'agent_never_started',
    summary: 'Scheduled prompt was queued but the agent never started a turn',
  }
}

function workspacePathOf(workspace) {
  return String(workspace?.path || workspace?.record?.path || '').trim()
}

function listWorkspaces(ctx) {
  const registry = tryGet(ctx, 'workspaceRegistry')
  const list = typeof registry?.list === 'function' ? registry.list() : []
  return Array.isArray(list) ? list : []
}

export function listWorkspaceChoices(ctx) {
  return listWorkspaces(ctx).map((workspace) => {
    const path = workspacePathOf(workspace)
    const title = String(workspace?.title || workspace?.record?.title || '').trim() || (path ? basename(path) : '')
    return {
      id: String(workspace?.id || path),
      title: title || path,
      path,
    }
  }).filter((row) => row.path)
}

function sessionCwdOf(ctx, sessionId) {
  const live = tryGet(ctx, 'sessions')?.get?.(sessionId)
  const agent = tryGet(ctx, 'agents')?.get?.(sessionId)
  return String(live?.header?.cwd || live?.cwd || agent?.session?.header?.cwd || agent?.session?.cwd || '').trim()
}

/**
 * Prefer the user's most recently ordered Workspace so a scheduled session
 * (and a later native fork) can occupy a real sidebar group. Official
 * attachSession requires header.cwd === workspace.path.
 */
export function resolveSessionPlacement(ctx, job = {}) {
  const requested = String(job?.cwd || '').trim()
  const workspaces = listWorkspaces(ctx)
  const match = (path) => (path && workspaces.find((row) => workspacePathOf(row) === path)) || null
  if (requested) return { cwd: requested, workspace: match(requested) }
  const recent = workspaces[0]
  const recentPath = workspacePathOf(recent)
  if (recentPath) return { cwd: recentPath, workspace: recent }
  const isolated = defaultCwd()
  return { cwd: isolated, workspace: match(isolated) }
}

export async function attachLiveSessionToWorkspace(workspace, sessionId) {
  if (!sessionId || !workspace || typeof workspace.attachSession !== 'function') return false
  try {
    await workspace.attachSession(sessionId)
    return true
  } catch {
    return false
  }
}

/**
 * Put a forked (or still-loose) session into the workspace whose path matches
 * its cwd. Does not create a new workspace: a cwd mismatch cannot join a
 * different project.
 */
export async function adoptSessionIntoWorkspace(ctx, sessionId) {
  if (!sessionId) return { ok: false, attached: false }
  const cwd = sessionCwdOf(ctx, sessionId)
  const workspaces = listWorkspaces(ctx)
  const workspace = (cwd && workspaces.find((row) => workspacePathOf(row) === cwd)) || null
  const attached = await attachLiveSessionToWorkspace(workspace, sessionId)
  if (attached) {
    try { await unarchiveSession(ctx, sessionId) } catch { /* listing membership is enough */ }
  }
  return {
    ok: attached,
    attached,
    sessionId,
    cwd: cwd || null,
    workspaceId: workspace?.id || null,
  }
}

export async function archiveLiveSession(ctx, sessionId) {
  if (!sessionId) return false
  const registry = tryGet(ctx, 'workspaceRegistry')
  if (!registry || typeof registry.archiveSession !== 'function') return false
  try {
    await registry.archiveSession(sessionId)
    return true
  } catch {
    return false
  }
}

export async function unarchiveSession(ctx, sessionId) {
  if (!sessionId) return false
  let registry = tryGet(ctx, 'workspaceRegistry')
  if (!registry) {
    const started = Date.now()
    while (!registry && Date.now() - started < 1500) {
      await sleep(50)
      registry = tryGet(ctx, 'workspaceRegistry')
    }
  }
  if (!registry) return false
  if (typeof registry.enqueueOperation === 'function' && typeof registry.requireState === 'function' && typeof registry.setState === 'function') {
    await registry.enqueueOperation(async () => {
      const state = registry.requireState()
      const archived = state.archivedSessionIds || []
      if (!archived.includes(sessionId)) return
      await registry.setState({
        ...state,
        archivedSessionIds: archived.filter((id) => id !== sessionId),
      })
    })
    return true
  }
  const ids = typeof registry.archivedSessionIds === 'function'
    ? registry.archivedSessionIds()
    : registry.archivedSessionIds
  if (Array.isArray(ids) && typeof registry.setState === 'function') {
    if (!ids.includes(sessionId)) return true
    const state = typeof registry.requireState === 'function' ? registry.requireState() : { archivedSessionIds: ids }
    await registry.setState({
      ...state,
      archivedSessionIds: ids.filter((id) => id !== sessionId),
    })
    return true
  }
  return false
}

/**
 * Snapshot the same default model a New Session uses.
 * Persona templates interpolate `{{model}}`; an empty value fails assembly.
 */
export function currentDefaultModel(ctx) {
  try {
    const selection = tryGet(ctx, 'agentDefaultModel')?.currentSelection?.()
    const provider = typeof selection?.provider === 'string' ? selection.provider.trim() : ''
    const model = typeof selection?.model === 'string' ? selection.model.trim() : ''
    if (!provider || !model) return null
    return {
      provider,
      model,
      ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
    }
  } catch {
    return null
  }
}

export async function listModelChoices(ctx) {
  const llm = tryGet(ctx, 'llm')
  const providers = typeof llm?.listProviders === 'function' ? llm.listProviders() : []
  const list = Array.isArray(providers) ? providers : []
  const groups = []
  for (const row of list) {
    const provider = String(row?.id || row?.provider || '').trim()
    if (!provider) continue
    let models = []
    try {
      models = typeof llm.listModels === 'function' ? await llm.listModels(provider) : []
    } catch {
      models = []
    }
    groups.push({
      provider,
      displayName: String(row?.name || row?.displayName || provider),
      models: (Array.isArray(models) ? models : []).map((entry) => ({
        id: String(entry?.id || entry?.model || '').trim(),
        name: String(entry?.name || entry?.displayName || entry?.id || '').trim(),
      })).filter((entry) => entry.id),
    })
  }
  return { groups, current: currentDefaultModel(ctx) }
}

export async function resolveJobModel(ctx, job) {
  const provider = typeof job?.provider === 'string' ? job.provider.trim() : ''
  const model = typeof job?.model === 'string' ? job.model.trim() : ''
  if (provider && model) {
    return {
      provider,
      model,
      ...job.reasoningEffort ? { reasoningEffort: job.reasoningEffort } : {},
    }
  }
  return resolveDefaultModel(ctx)
}

export async function resolveDefaultModel(ctx, options = {}) {
  const waitMs = Number.isFinite(options.waitMs) ? Math.max(0, options.waitMs) : 1500
  let service = tryGet(ctx, 'agentDefaultModel')
  if (!service?.currentSelection && waitMs > 0) {
    const started = Date.now()
    while (!service?.currentSelection && Date.now() - started < waitMs) {
      await sleep(50)
      service = tryGet(ctx, 'agentDefaultModel')
    }
  }
  const selection = service?.currentSelection?.()
  const provider = typeof selection?.provider === 'string' ? selection.provider.trim() : ''
  const model = typeof selection?.model === 'string' ? selection.model.trim() : ''
  if (!provider || !model) {
    throw new Error('no default model is configured; pick a model in Models before running scheduled tasks')
  }
  return {
    provider,
    model,
    ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
  }
}

/**
 * Fill `{{provider}}` / `{{model}}` and route LLM requests, without importing
 * `@deepseek-ai/dsh-agent`. Same contract as official installModelSelection.
 */
export function bindModelSelection(agentCtx, selection) {
  if (!agentCtx || typeof agentCtx.on !== 'function' || !selection) return
  const snapshot = {
    provider: selection.provider,
    model: selection.model,
    ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
  }
  agentCtx.on('system-prompt/assemble', async (...args) => {
    const next = args.find((arg) => typeof arg === 'function')
    const assembled = next ? await next() : (args[0] || {})
    return {
      ...assembled,
      variables: {
        ...assembled.variables,
        provider: snapshot.provider,
        model: snapshot.model,
      },
    }
  })
  agentCtx.on('agent/request', async (...args) => {
    const next = args.find((arg) => typeof arg === 'function')
    const resolved = next ? await next() : (args[0] || {})
    const { reasoningEffort: _inherited, ...rest } = resolved || {}
    return {
      ...rest,
      provider: snapshot.provider,
      model: snapshot.model,
      ...snapshot.reasoningEffort === undefined ? {} : { reasoningEffort: snapshot.reasoningEffort },
    }
  })
}

async function composeCronAgent(ctx, selection) {
  const presets = tryGet(ctx, 'agentPresets')
  if (!presets || typeof presets.resolve !== 'function' || typeof presets.mount !== 'function') {
    return {
      setup: (agentCtx) => {
        bindModelSelection(agentCtx, selection)
      },
    }
  }
  const resolved = await presets.resolve()
  const presetId = resolved?.id
  return {
    agentPreset: presetId,
    setup: async (agentCtx) => {
      bindModelSelection(agentCtx, selection)
      if (presetId) await presets.mount(agentCtx, presetId)
    },
  }
}

export function makeLiveSessionPort(ctx) {
  const handles = new Map()
  return {
    async createAndPrompt({ job, run, text, source }) {
      const agents = tryGet(ctx, 'agents')
      if (!agents || typeof agents.create !== 'function') {
        throw new Error('ctx.agents.create is unavailable')
      }
      const sessionId = randomUUID()
      const placement = resolveSessionPlacement(ctx, job)
      const cwd = placement.cwd || defaultCwd()
      await mkdir(cwd, { recursive: true })
      const selection = await resolveJobModel(ctx, job)
      const composition = await composeCronAgent(ctx, selection)
      const handle = await agents.create({
        sessionId,
        agentOptions: {
          provider: selection.provider,
          model: selection.model,
          ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
        },
        meta: {
          cwd,
          ...composition.agentPreset ? { agentPreset: composition.agentPreset } : {},
        },
        setup: composition.setup,
      })
      const agent = handle?.agent
      if (!agent || typeof agent.followup !== 'function') {
        throw new Error('created agent has no followup')
      }
      const message = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: source || { kind: 'plugin', plugin: PLUGIN_NAME },
      }
      agent.followup(message)
      const timeoutMs = Math.max(60_000, (Number(job?.timeoutMinutes) || 10) * 60_000)
      handles.set(sessionId, { handle, timeoutMs, agent })
      try {
        await attachLiveSessionToWorkspace(placement.workspace, sessionId)
      } catch {
        // Forks of unattached runs stay loose; listing hide is separate.
      }
      try {
        if (typeof agent.session?.append === 'function') {
          agent.session.append('session/title', {
            title: `${TITLE_PREFIX}${job.name}`,
            source: 'plugin',
          })
        }
      } catch {
        // Title is best-effort.
      }
      return {
        sessionId,
        handle,
        status: 'running',
        summary: `Started session for ${job.name}`,
      }
    },
    async archiveSession(sessionId) {
      return archiveLiveSession(ctx, sessionId)
    },
    async revealSession(sessionId) {
      return unarchiveSession(ctx, sessionId)
    },
    async adoptSession(sessionId) {
      return adoptSessionIntoWorkspace(ctx, sessionId)
    },
    async listWorkspaces() {
      return listWorkspaceChoices(ctx)
    },
    async listModels() {
      return listModelChoices(ctx)
    },
    async waitForTurn(sessionId) {
      const entry = handles.get(sessionId)
      const agents = tryGet(ctx, 'agents')
      const agent = entry?.agent || entry?.handle?.agent || agents?.get?.(sessionId)
      try {
        const finished = await waitForAgentTurn(agent, {
          turnTimeoutMs: entry?.timeoutMs,
        })
        const summary = extractAssistantText(agent?.session?.deriveMessages?.() || [])
        return {
          ...finished,
          summary: summary || finished.summary,
        }
      } catch (error) {
        if (error && error.code === 'RUN_TIMEOUT' && agent && typeof agent.cancel === 'function') {
          try { agent.cancel({ kind: 'timeout' }) } catch { /* ignore */ }
        }
        throw error
      } finally {
        handles.delete(sessionId)
      }
    },
  }
}

function tryGet(ctx, name) {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

export { DEFAULT_SETTINGS }
