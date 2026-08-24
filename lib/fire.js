/**
 * Fire path: new root Session, wrapped prompt, hide from workspace list, history.
 * Collaborators are injected so tests drive the same functions as Host apply.
 */

import { randomUUID } from 'node:crypto'
import { wrapScheduledPrompt, scheduledPromptSource } from './prompt.js'
import { decideDispatch } from './scheduler.js'
import { appendRun, getJob, patchRun, upsertJob } from './store.js'

export function createRunRecord(job, decision, now, trigger) {
  return {
    id: randomUUID(),
    jobId: job.id,
    scheduledAt: decision.scheduledAt ?? now,
    actualAt: now,
    status: 'queued',
    trigger: trigger || 'schedule',
    sessionId: null,
    error: null,
    summary: '',
    reason: decision.reason || null,
  }
}

export const TITLE_PREFIX = '定时任务 · '

export function extractAssistantText(messages, maxChars = 4000) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || message.role !== 'assistant') continue
    const parts = []
    for (const block of message.content || []) {
      if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        parts.push(block.text.trim())
      }
    }
    const text = parts.join('\n').trim()
    if (!text) continue
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
  }
  return ''
}

export function publicJob(job) {
  if (!job) return null
  return {
    id: job.id,
    name: job.name,
    prompt: job.prompt,
    enabled: job.enabled !== false,
    cwd: job.cwd || '',
    timeoutMinutes: job.timeoutMinutes || 10,
    provider: job.provider || '',
    model: job.model || '',
    reasoningEffort: job.reasoningEffort || '',
    schedule: job.schedule,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    lastRunAt: job.lastRunAt,
    lastStatus: job.lastStatus,
    nextRunAt: job.nextRunAt,
  }
}

/**
 * Claim one occurrence: overlap → skipped history row; otherwise queued run.
 */
export function claimOccurrence(state, jobId, now, trigger, policies) {
  const job = getJob(state, jobId)
  if (!job) {
    const error = new Error('job not found')
    error.code = 'NOT_FOUND'
    throw error
  }
  const runs = (state.runs || []).filter((run) => run.jobId === jobId)
  const decision = trigger === 'run-now'
    ? decideRunNow(job, runs, now, policies)
    : decideDispatch({
      job,
      runs,
      now,
      overlapPolicy: policies?.overlapPolicy || state.settings?.overlapPolicy,
      misfirePolicy: policies?.misfirePolicy || state.settings?.misfirePolicy,
      graceMs: policies?.graceMs,
    })

  if (decision.action === 'wait') {
    return { state, job: publicJob(job), decision, run: null }
  }

  const run = createRunRecord(job, decision, now, trigger)
  if (decision.action === 'skip') {
    run.status = 'skipped'
    run.reason = decision.reason
    run.summary = decision.reason === 'overlap'
      ? 'Skipped because a run is already queued or running'
      : 'Skipped missed occurrence after host downtime (no backlog)'
    const alreadySkipped = runs.some((row) => (
      row
      && row.status === 'skipped'
      && row.reason === decision.reason
      && row.scheduledAt === decision.scheduledAt
    ))
    const nextJob = {
      ...job,
      updatedAt: now,
      lastRunAt: now,
      lastStatus: 'skipped',
      nextRunAt: Object.hasOwn(decision, 'nextRunAt') ? decision.nextRunAt : job.nextRunAt,
    }
    let next = upsertJob(state, nextJob)
    if (!alreadySkipped) next = appendRun(next, run)
    return { state: next, job: publicJob(nextJob), decision, run: alreadySkipped ? null : run }
  }

  run.status = 'queued'
  const nextJob = {
    ...job,
    updatedAt: now,
    nextRunAt: trigger === 'run-now'
      ? job.nextRunAt
      : (Object.hasOwn(decision, 'nextRunAt') ? decision.nextRunAt : job.nextRunAt),
  }
  let next = upsertJob(state, nextJob)
  next = appendRun(next, run)
  return { state: next, job: publicJob(nextJob), decision, run }
}

function decideRunNow(job, runs, now, policies) {
  const overlapPolicy = policies?.overlapPolicy || 'skip'
  if (overlapPolicy === 'skip' && runs.some((run) => run.status === 'queued' || run.status === 'running')) {
    return { action: 'skip', reason: 'overlap', scheduledAt: now, nextRunAt: job.nextRunAt }
  }
  return { action: 'fire', scheduledAt: now, nextRunAt: job.nextRunAt }
}

export const ACTIVE_RUN_STATUSES = new Set(['queued', 'running'])

function failRun(state, runId, job, now, message) {
  return settleRun(state, runId, {
    status: 'failed',
    error: message,
    summary: message,
  }, now)
}

/** Persist a terminal status so overlap skip can release the job. */
export function settleRun(state, runId, terminal, now) {
  const run = (state.runs || []).find((row) => row.id === runId)
  if (!run) return state
  const job = getJob(state, run.jobId)
  const status = terminal?.status && !ACTIVE_RUN_STATUSES.has(terminal.status)
    ? terminal.status
    : 'succeeded'
  let next = patchRun(state, runId, {
    status,
    summary: terminal?.summary || '',
    error: terminal?.error || null,
    actualAt: now,
    sessionId: run.sessionId,
  })
  if (job) {
    next = upsertJob(next, {
      ...job,
      lastRunAt: now,
      lastStatus: status,
      updatedAt: now,
    })
  }
  return next
}

/**
 * Execute an already-claimed queued run via injected session/archive helpers.
 * Performs IO through `deps`; the caller persists each returned state.
 *
 * @param {object} state
 * @param {string} runId
 * @param {object} deps
 * @param {() => number} [deps.now]
 * @param {(args: object) => Promise<{ sessionId: string, status?: string, summary?: string }>} deps.createAndPrompt
 * @param {(sessionId: string) => Promise<void>} [deps.archiveSession]
 * @param {(sessionId: string) => Promise<{ status?: string, summary?: string, error?: string }>} [deps.waitForTurn]
 */
export async function executeClaimedRun(state, runId, deps) {
  const run = (state.runs || []).find((row) => row.id === runId)
  if (!run) {
    const error = new Error('run not found')
    error.code = 'NOT_FOUND'
    throw error
  }
  const job = getJob(state, run.jobId)
  if (!job) {
    const error = new Error('job not found')
    error.code = 'NOT_FOUND'
    throw error
  }
  const clock = deps.now || (() => Date.now())
  const mark = clock()
  let next = patchRun(state, runId, { status: 'running', actualAt: mark })
  next = upsertJob(next, { ...job, lastRunAt: mark, lastStatus: 'running', updatedAt: mark })

  const text = wrapScheduledPrompt(job.prompt, {
    jobName: job.name,
    jobId: job.id,
    runId,
    scheduledAt: new Date(run.scheduledAt).toISOString(),
  })
  const source = scheduledPromptSource()

  if (typeof deps.createAndPrompt !== 'function') {
    next = failRun(next, runId, job, clock(), 'session port unavailable')
    return { state: next, run: (next.runs || []).find((row) => row.id === runId), job: publicJob(getJob(next, job.id)) }
  }

  try {
    const created = await deps.createAndPrompt({
      job,
      run: { ...run, status: 'running' },
      text,
      source,
    })
    const sessionId = created?.sessionId
    if (!sessionId) throw new Error('createAndPrompt did not return sessionId')
    next = patchRun(next, runId, { sessionId })
    if (typeof deps.archiveSession === 'function') {
      await deps.archiveSession(sessionId)
    }
    const reported = created.status || 'succeeded'
    if (typeof deps.waitForTurn === 'function' && ACTIVE_RUN_STATUSES.has(reported)) {
      const waited = await deps.waitForTurn(sessionId)
      const ended = clock()
      next = settleRun(next, runId, waited || { status: 'succeeded', summary: created.summary }, ended)
      return { state: next, run: (next.runs || []).find((row) => row.id === runId), job: publicJob(getJob(next, job.id)) }
    }
    if (ACTIVE_RUN_STATUSES.has(reported)) {
      // Leave running so overlap skip still works while a turn is in flight.
      // Caller (dispatchRun / live waitForTurn) must settle to a terminal status.
      return { state: next, run: (next.runs || []).find((row) => row.id === runId), job: publicJob(getJob(next, job.id)) }
    }
    const ended = clock()
    next = settleRun(next, runId, {
      status: reported,
      summary: created.summary || 'Dispatched to a new session',
      error: created.error || null,
    }, ended)
    return { state: next, run: (next.runs || []).find((row) => row.id === runId), job: publicJob(getJob(next, job.id)) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    next = failRun(next, runId, job, clock(), message)
    return { state: next, run: (next.runs || []).find((row) => row.id === runId), job: publicJob(getJob(next, job.id)) }
  }
}

export function interruptActiveRuns(state, now, reason = 'host_interrupted') {
  let next = state
  for (const run of state.runs || []) {
    if (run.status !== 'queued' && run.status !== 'running') continue
    next = patchRun(next, run.id, {
      status: 'failed',
      error: reason,
      summary: 'Host stopped before this run finished',
      actualAt: now,
    })
    const job = getJob(next, run.jobId)
    if (job) {
      next = upsertJob(next, { ...job, lastStatus: 'failed', lastRunAt: now, updatedAt: now })
    }
  }
  return next
}

export { wrapScheduledPrompt }
