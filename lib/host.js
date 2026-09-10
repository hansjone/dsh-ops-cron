/**
 * Host service used by apply() and by tests.
 * Owns the durable store, the single timer, CRUD, and the fire path.
 */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { claimOccurrence, executeClaimedRun, extractAssistantText, interruptActiveRuns, publicJob, settleRun, TITLE_PREFIX } from './fire.js'
import { assertDeliveryAllowedForIdentity, deliverRunToIm, mergeDeliveryMention, mirrorRunToSession, normalizeDelivery, normalizeOrigin } from './delivery.js'
import { apiError, resolveLocale } from './i18n.js'
import { workspaceVisibleIds } from './isolation.js'
import { ACTIVE_RUN_STATUSES } from './fire-status.js'
import {
  formatWatchReport,
  labelsMatch,
  normalizeLabels,
  readProgressSnapshot,
  selectJobsByWatch,
} from './monitor.js'
import {
  markRunsArchived,
  pruneArchivedRuns,
  pushArchiveBatch,
  runsNeedingArchive,
} from './archive.js'
import { decideDispatch, nextFire, validateSchedule } from './scheduler.js'
import {
  createJobRecord,
  createStore,
  DEFAULT_SETTINGS,
  getJob,
  listHistory,
  listHistoryPage,
  listJobs,
  normalizeSettings,
  removeJob,
  splitProviderModel,
  storePath,
  upsertJob,
} from './store.js'
import {
  assertCanAccessJob,
  canViewAllJobs,
  claimUnassignedForViewer,
  filterJobsForIdentity,
  filterRunsForJobs,
  isElevatedCronRole,
  isMultiUserIdentity,
  localIdentity,
  migrateJobOwners,
  normalizeOwnerEmpNo,
  UNASSIGNED_OWNER,
  viewerPayload,
} from './ownership.js'

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


function parseCookieHeader(header, name) {
  if (!header || typeof header !== 'string') return null
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    if (part.slice(0, idx).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(idx + 1).trim())
    } catch {
      return part.slice(idx + 1).trim()
    }
  }
  return null
}


function empNoFromUserWorkspacePath(cwd) {
  const norm = String(cwd || '').replace(/\\/g, '/')
  const match = norm.match(/\/user-workspaces\/([^/]+)(?:\/|$)/)
  return match ? decodeURIComponent(match[1]) : null
}

function inferIdentityFromJobInput(input, getUdsAuth) {
  const uds = typeof getUdsAuth === 'function' ? getUdsAuth() : null
  if (!uds) return null
  const origin = input?.origin
  const sessionId = origin?.kind === 'web' && typeof origin.sessionId === 'string'
    ? origin.sessionId.trim()
    : ''
  if (sessionId && typeof uds.getSessionOwner === 'function') {
    const empNo = uds.getSessionOwner(sessionId)
    if (empNo) {
      if (typeof uds.resolveIdentityForEmpNo === 'function') {
        const resolved = uds.resolveIdentityForEmpNo(empNo)
        if (resolved?.empNo) return resolved
      }
      return {
        empNo: String(empNo),
        displayName: String(empNo),
        permissions: {},
      }
    }
  }
  const fromCwd = empNoFromUserWorkspacePath(input?.cwd)
  if (fromCwd) {
    if (typeof uds.resolveIdentityForEmpNo === 'function') {
      const resolved = uds.resolveIdentityForEmpNo(fromCwd)
      if (resolved?.empNo) return resolved
    }
    return {
      empNo: fromCwd,
      displayName: fromCwd,
      permissions: {},
    }
  }
  return null
}

function browserEmpNo(request) {
  const cookie = request?.headers?.cookie || ''
  return parseCookieHeader(cookie, 'PORTALSSOUser')
    || parseCookieHeader(cookie, 'ZTEDPGSSOUser')
    || parseCookieHeader(cookie, 'UDS_FALLBACK_USER')
    || parseCookieHeader(cookie, 'UDS_FALLBACK_UI')
}

/**
 * Resolve browser identity via uds-auth. Returns null when missing/unavailable.
 * @param {object} request
 * @param {() => object|undefined} getUdsAuth
 */
async function resolveBrowserIdentity(request, getUdsAuth) {
  const uds = typeof getUdsAuth === 'function' ? getUdsAuth() : null
  if (!uds || typeof uds.resolveRequestIdentity !== 'function') return null
  try {
    const identity = await uds.resolveRequestIdentity(request)
    if (!identity?.empNo) return null
    const workspacePath = typeof uds.getProvisionedWorkspacePath === 'function'
      ? uds.getProvisionedWorkspacePath(identity.empNo)
      : null
    return { ...identity, workspacePath: workspacePath || identity.workspacePath || null }
  } catch {
    return null
  }
}

/**
 * @returns {Promise<object|null>} identity or null after writing error response
 */
async function requireIdentity(request, write, getUdsAuth) {
  const locale = resolveLocale(request)
  if (!isTrustedApiRequest(request)) {
    write(403, apiError('forbidden', locale))
    return null
  }
  const uds = typeof getUdsAuth === 'function' ? getUdsAuth() : null
  // Soft dep: without uds-auth, run in standalone single-tenant mode.
  if (!uds || typeof uds.resolveRequestIdentity !== 'function') {
    return localIdentity()
  }
  const identity = await resolveBrowserIdentity(request, getUdsAuth)
  if (!identity?.empNo) {
    write(401, apiError('login_required', locale))
    return null
  }
  return { ...identity, mode: 'multi', lang: identity.lang || locale }
}

/**
 * Whether this identity / job owner may keep an explicit cwd outside the
 * provisioned tree. Re-resolves via uds-auth so stale tool identities (role
 * missing permissions, or Host with an older caller path) still work.
 */
function allowsForeignJobCwd(identity, getUdsAuth, ownerEmpNo) {
  if (canViewAllJobs(identity)) return true
  const uds = typeof getUdsAuth === 'function' ? getUdsAuth() : null
  const empNo = String(ownerEmpNo || identity?.empNo || '').trim()
  if (!empNo || empNo.startsWith('__') || !uds) return false
  if (typeof uds.resolveIdentityForEmpNo === 'function') {
    const live = uds.resolveIdentityForEmpNo(empNo)
    if (live && canViewAllJobs(live)) return true
  }
  if (typeof uds.getRole === 'function' && isElevatedCronRole(uds.getRole(empNo))) return true
  // Match dsh-acl: local fallback cookie user is always elevated.
  if (empNo === 'administrator') return true
  return false
}

/** Merge live role/permissions onto a caller identity when uds-auth can look them up. */
function enrichIdentity(identity, getUdsAuth) {
  if (!isMultiUserIdentity(identity)) return identity
  const uds = typeof getUdsAuth === 'function' ? getUdsAuth() : null
  if (typeof uds?.resolveIdentityForEmpNo === 'function') {
    const live = uds.resolveIdentityForEmpNo(identity.empNo)
    if (live?.empNo) {
      const canView = !!(
        live.permissions?.canViewAllSessions
        || identity.permissions?.canViewAllSessions
        || isElevatedCronRole(live.role)
        || isElevatedCronRole(identity.role)
        || identity.empNo === 'administrator'
      )
      return {
        ...identity,
        role: live.role || identity.role,
        displayName: live.displayName || identity.displayName || identity.empNo,
        permissions: {
          ...(identity.permissions || {}),
          ...(live.permissions || {}),
          canViewAllSessions: canView,
          canCreateWorkspace: !!(
            live.permissions?.canCreateWorkspace
            || identity.permissions?.canCreateWorkspace
            || canView
          ),
        },
        workspacePath: live.workspacePath || identity.workspacePath || null,
      }
    }
  }
  if (isElevatedCronRole(identity.role) || identity.empNo === 'administrator') {
    return {
      ...identity,
      permissions: {
        ...(identity.permissions || {}),
        canViewAllSessions: true,
        canCreateWorkspace: true,
      },
    }
  }
  return identity
}

export function normalizeFsPath(value) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/\/+$/, '')
}

export function isPathInside(candidate, root) {
  const cand = normalizeFsPath(candidate).toLowerCase()
  const base = normalizeFsPath(root).toLowerCase()
  if (!cand || !base) return false
  return cand === base || cand.startsWith(`${base}/`)
}

/**
 * Decide the durable cwd for a job.
 * - Elevated owners: any explicit cwd
 * - Owner tree (isUserPath): keep
 * - Inside provision forest but not owner tree: clamp to ownerPath
 * - Outside forest (shared trees like D:\\code\\gpt): keep when allowExternalCwd
 */
function resolveSanitizedCwd(cwd, identity, getUdsAuth, { forOwnerEmpNo, allowExternalCwd = true } = {}) {
  const raw = typeof cwd === 'string' ? cwd.trim() : ''
  const uds = typeof getUdsAuth === 'function' ? getUdsAuth() : null
  const owner = forOwnerEmpNo || identity?.empNo
  const ownerPath = owner && uds?.getProvisionedWorkspacePath
    ? uds.getProvisionedWorkspacePath(owner)
    : null
  if (!raw) return ownerPath || ''
  if (allowsForeignJobCwd(identity, getUdsAuth, owner)) return raw
  if (!uds) return raw
  if (owner && uds?.isUserPath?.(owner, raw)) return raw
  if (ownerPath) {
    const forest = dirname(ownerPath)
    if (forest && isPathInside(raw, forest)) return ownerPath
    if (allowExternalCwd !== false) return raw
    return ownerPath
  }
  return allowExternalCwd !== false ? raw : ''
}

function sanitizeJobCwd(cwd, identity, getUdsAuth, opts = {}) {
  const raw = typeof cwd === 'string' ? cwd.trim() : ''
  const effective = resolveSanitizedCwd(cwd, identity, getUdsAuth, opts)
  if (
    raw
    && normalizeFsPath(raw).toLowerCase() !== normalizeFsPath(effective).toLowerCase()
    && opts.rejectClamp
  ) {
    const error = new Error(
      `cwd "${raw}" is not allowed for this user (effective "${effective || '(empty)'}"). `
      + 'Use a path under your provisioned workspace, a shared tree outside workspaceRoot '
      + '(when allowExternalCwd is on), or a super_admin / fallback_admin account.',
    )
    error.code = 'CWD_FORBIDDEN'
    error.requestedCwd = raw
    error.effectiveCwd = effective
    throw error
  }
  return effective
}

function isTrustedApiRequest(request) {
  const host = request.headers.host ?? ''
  if (!host) return false
  const hostname = host.split(':')[0].replace(/^\[|\]$/g, '')
  if ((request.headers['sec-fetch-site'] ?? '') === 'cross-site') return false
  // Allow same-origin LAN / non-loopback Host (login still required separately).
  const site = request.headers['sec-fetch-site'] ?? ''
  if (site === 'same-origin' || site === 'same-site') return true
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

function jobView(job, runs = null) {
  return publicJob(job, runs)
}

function runView(run) {
  if (!run) return null
  return {
    id: run.id,
    run_id: run.id,
    jobId: run.jobId,
    scheduledAt: run.scheduledAt,
    actualAt: run.actualAt,
    status: run.status,
    state: run.status === 'queued' ? 'pending'
      : run.status === 'skipped' ? 'failed'
        : run.status,
    stateEnteredAt: run.stateEnteredAt ?? run.actualAt ?? run.scheduledAt ?? null,
    exitedAt: run.exitedAt ?? null,
    trigger: run.trigger,
    sessionId: run.sessionId,
    error: run.error,
    summary: run.summary,
    reason: run.reason,
    output_ref: run.outputRef || (run.sessionId ? `session:${run.sessionId}` : null),
    ...run.archivedAt ? { archivedAt: run.archivedAt } : {},
  }
}

/**
 * @param {object} options
 * @param {() => number} [options.now]
 * @param {string} [options.filePath]
 * @param {object} [options.sessionPort] { createAndPrompt, archiveSession, waitForTurn }
 * @param {() => object|undefined} [options.getDshIm] soft-injected proactive IM API
 * @param {() => object|undefined} [options.getAgents] soft-injected agents service for session mirror
 * @param {{ warn?: Function, info?: Function }} [options.logger]
 * @param {number} [options.tickIntervalMs]
 */
export function createHostService(options = {}) {
  const now = options.now || (() => Date.now())
  const filePath = options.filePath || storePath(dshHome())
  const store = options.store || createStore({ filePath })
  const sessionPort = options.sessionPort || null
  const getDshIm = typeof options.getDshIm === 'function' ? options.getDshIm : () => undefined
  const getAgents = typeof options.getAgents === 'function' ? options.getAgents : () => undefined
  const getUdsAuth = typeof options.getUdsAuth === 'function' ? options.getUdsAuth : () => undefined
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

  async function maybeMirrorResult(job, run) {
    if (!job || !run || run.status === 'skipped') return
    if (job.mirrorToSession !== true) return
    try {
      const result = await mirrorRunToSession(job, run.summary || run.error || '', {
        dshIm: getDshIm(),
        getAgents,
        pluginName: PLUGIN_NAME,
        newId: () => randomUUID(),
      })
      if (result?.mirrored) {
        logger.info?.(`[dsh-ops-cron] mirrored run ${run.id} → session ${result.sessionId} via ${result.via} (${result.method}${result.resumed ? ', resumed' : ''})`)
      } else if (result?.reason && result.reason !== 'no_target') {
        logger.warn?.(`[dsh-ops-cron] mirror skipped for run ${run.id}: ${result.reason}${result.sessionId ? ` session=${result.sessionId}` : ''}${result.error ? ` (${result.error})` : ''}`)
      } else if (!result?.skipped) {
        logger.warn?.(`[dsh-ops-cron] mirror incomplete for run ${run.id}: ${result?.reason || 'unknown'}`)
      }
    } catch (error) {
      logger.warn?.(`[dsh-ops-cron] mirror failed for job ${job.id}: ${error instanceof Error ? error.message : error}`)
    }
  }

  /**
   * Notify watcher jobs that watch this completed job (report.mode=on_complete).
   */
  async function maybeNotifyWatchers(targetJob, targetRun) {
    if (!targetJob || !targetRun) return
    if (targetRun.status === 'queued' || targetRun.status === 'running') return
    const state = await snapshot()
    const watchers = listJobs(state).filter((job) => {
      if (!job?.watch || !job.report) return false
      if (job.report.mode !== 'on_complete') return false
      if (job.report.delivery === 'none') return false
      if (job.watch.taskId && job.watch.taskId === targetJob.id) return true
      if (job.watch.labels && Object.keys(job.watch.labels).length) {
        return labelsMatch(targetJob.labels, job.watch.labels, job.watch.match || 'all')
      }
      return false
    })
    for (const watcher of watchers) {
      try {
        const text = formatWatchReport(watcher, [{
          id: targetJob.id,
          name: targetJob.name,
          state: targetRun.status === 'succeeded' ? 'succeeded' : 'failed',
          stuck: false,
        }])
        if (watcher.report.delivery === 'im' || watcher.delivery?.kind === 'im') {
          const deliveryJob = watcher.report.delivery === 'im' || watcher.delivery?.kind === 'im'
            ? { ...watcher, delivery: watcher.delivery?.kind === 'im' ? watcher.delivery : watcher.delivery }
            : watcher
          if (deliveryJob.delivery?.kind === 'im') {
            await deliverRunToIm(deliveryJob, text, { dshIm: getDshIm() })
          }
        }
      } catch (error) {
        logger.warn?.(`[dsh-ops-cron] watcher report failed for ${watcher.id}: ${error instanceof Error ? error.message : error}`)
      }
    }
  }

  async function settleAndNotify(jobId, runId, claimedDecision) {
    const state = await snapshot()
    const run = (state.runs || []).find((row) => row.id === runId)
    const job = getJob(state, jobId)
    await maybeDeliverIm(job, run)
    await maybeMirrorResult(job, run)
    await maybeNotifyWatchers(job, run)
    if (job?.persistHistory?.kind === 'archive' && job.persistHistory.endpoint) {
      try {
        await archiveJobRuns(jobId, { identity: null })
      } catch (error) {
        logger.warn?.(`[dsh-ops-cron] archive push failed for ${jobId}: ${error instanceof Error ? error.message : error}`)
      }
    }
    return { job: jobView(job, (await snapshot()).runs), run: runView(run), decision: claimedDecision }
  }

  /**
   * Push unarchived terminal runs for archive-policy jobs to their endpoint.
   * @param {string|null} [jobId] limit to one job; null = all archive jobs
   * @param {{ identity?: object|null, fetchImpl?: typeof fetch, limit?: number }} [opts]
   */
  async function archiveJobRuns(jobId = null, opts = {}) {
    const identity = opts.identity || null
    const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? Math.min(200, opts.limit) : 50
    const state = await snapshot()
    let jobs = listJobs(state).filter((job) => (
      job?.persistHistory?.kind === 'archive' && job.persistHistory.endpoint
    ))
    if (jobId) jobs = jobs.filter((job) => job.id === jobId)
    if (identity) {
      for (const job of jobs) assertCanAccessJob(job, identity)
      jobs = filterJobsForIdentity(jobs, identity)
    }
    const results = []
    for (const job of jobs) {
      const live = await snapshot()
      const batch = runsNeedingArchive(live.runs, job.id)
        .sort((a, b) => (a.actualAt || a.scheduledAt || 0) - (b.actualAt || b.scheduledAt || 0))
        .slice(0, limit)
      if (!batch.length) {
        results.push({ jobId: job.id, archived: 0, skipped: true })
        continue
      }
      await pushArchiveBatch(job.persistHistory.endpoint, {
        job: jobView(job, live.runs),
        runs: batch.map(runView),
      }, { fetchImpl: opts.fetchImpl || options.fetchImpl, now })
      const mark = now()
      const ids = batch.map((run) => run.id)
      await withState((current) => pruneArchivedRuns(markRunsArchived(current, ids, mark), 50))
      results.push({ jobId: job.id, archived: batch.length, endpoint: job.persistHistory.endpoint })
    }
    return {
      ok: true,
      archived: results.reduce((sum, row) => sum + (row.archived || 0), 0),
      results,
    }
  }

  async function createJob(input, identity = null, opts = {}) {
    const t = now()
    // Ignore client-supplied ids on create — otherwise POST/tools can overwrite.
    const { id: _ignoredId, ownerEmpNo: _ignoreOwner, ...safeInput } = input && typeof input === 'object' ? input : {}
    const fromImPeer = opts.fromImPeer === true
    let origin = normalizeOrigin(safeInput.origin)

    // HTTP/web must not forge IM peer origin to bypass empNo ownership.
    if (!fromImPeer && origin?.kind === 'im') {
      origin = origin.sessionId
        ? normalizeOrigin({ kind: 'web', sessionId: origin.sessionId })
        : null
      if (origin) safeInput.origin = origin
      else delete safeInput.origin
    } else if (origin) {
      safeInput.origin = origin
    }

    if (fromImPeer) {
      const cwd = String(safeInput.cwd || '').trim()
      if (!cwd) {
        const error = new Error('IM scheduled jobs require a non-empty session working directory')
        error.code = 'INVALID_CWD'
        throw error
      }
      safeInput.cwd = cwd
      safeInput.ownerEmpNo = UNASSIGNED_OWNER
      safeInput.ownerDisplayName = ''
      // Keep cwd as the bot workspace path; do not sanitize via empNo.
    } else {
      const ownerIdentity = enrichIdentity(
        isMultiUserIdentity(identity)
          ? identity
          : inferIdentityFromJobInput(safeInput, getUdsAuth),
        getUdsAuth,
      )
      if (isMultiUserIdentity(ownerIdentity)) {
        const delivery = normalizeDelivery(safeInput.delivery || { kind: 'dsh' })
        assertDeliveryAllowedForIdentity(delivery, ownerIdentity)
        safeInput.delivery = delivery
        safeInput.ownerEmpNo = ownerIdentity.empNo
        safeInput.ownerDisplayName = ownerIdentity.displayName || ownerIdentity.empNo
        const snap = await snapshot()
        const allowExternalCwd = snap?.settings?.allowExternalCwd !== false
        const requestedCwd = String(safeInput.cwd || '').trim()
        safeInput.cwd = sanitizeJobCwd(safeInput.cwd, ownerIdentity, getUdsAuth, {
          forOwnerEmpNo: ownerIdentity.empNo,
          allowExternalCwd,
          rejectClamp: !!requestedCwd,
        })
      } else if (safeInput.ownerEmpNo) {
        safeInput.ownerEmpNo = normalizeOwnerEmpNo(safeInput.ownerEmpNo)
      } else {
        // Standalone / no inferred owner: leave unassigned (visible to everyone in local mode).
        safeInput.ownerEmpNo = UNASSIGNED_OWNER
      }
    }
    let created
    await withState((current) => {
      created = createJobRecord(safeInput, current, t)
      return upsertJob(current, created)
    })
    return jobView(created, [])
  }

  async function updateJob(jobId, patch, identity = null) {
    const t = now()
    const state = await withState((current) => {
      const job = getJob(current, jobId)
      if (!job) {
        const error = new Error('job not found')
        error.code = 'NOT_FOUND'
        throw error
      }
      if (identity) patch = { ...patch, _identity: identity }
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
        agentPreset: patch.agentPreset !== undefined ? patch.agentPreset : job.agentPreset,
        agentAccess: patch.agentAccess !== undefined
          ? patch.agentAccess
          : (patch.agent_access !== undefined ? patch.agent_access : job.agentAccess),
        delivery: patch.delivery !== undefined
          ? mergeDeliveryMention(job.delivery, patch.delivery)
          : job.delivery,
        origin: patch.origin !== undefined
          ? (normalizeOrigin(patch.origin) || undefined)
          : job.origin,
        mirrorToSession: patch.mirrorToSession !== undefined
          ? patch.mirrorToSession === true
          : (patch.mirror_to_session !== undefined
            ? patch.mirror_to_session === true
            : job.mirrorToSession === true),
        labels: patch.labels !== undefined ? patch.labels : job.labels,
        watch: patch.watch !== undefined ? patch.watch : job.watch,
        progress: patch.progress !== undefined ? patch.progress : job.progress,
        report: patch.report !== undefined ? patch.report : job.report,
        persistHistory: patch.persistHistory !== undefined
          ? patch.persistHistory
          : (patch.persist_history !== undefined ? patch.persist_history : job.persistHistory),
        ownerEmpNo: job.ownerEmpNo || UNASSIGNED_OWNER,
        ownerDisplayName: job.ownerDisplayName || '',
      }
      if (patch._identity) {
        const enriched = enrichIdentity(patch._identity, getUdsAuth)
        if (patch.delivery !== undefined) {
          nextInput.delivery = mergeDeliveryMention(job.delivery, patch.delivery)
          assertDeliveryAllowedForIdentity(nextInput.delivery, enriched)
        }
        const allowExternalCwd = current.settings?.allowExternalCwd !== false
        const requestedCwd = patch.cwd !== undefined ? String(patch.cwd || '').trim() : ''
        nextInput.cwd = sanitizeJobCwd(
          nextInput.cwd,
          enriched,
          getUdsAuth,
          {
            forOwnerEmpNo: nextInput.ownerEmpNo,
            allowExternalCwd,
            rejectClamp: !!requestedCwd,
          },
        )
      }
      if (patch.ownerEmpNo !== undefined && canViewAllJobs(enrichIdentity(patch._identity, getUdsAuth))) {
        nextInput.ownerEmpNo = normalizeOwnerEmpNo(patch.ownerEmpNo)
        if (patch.ownerDisplayName !== undefined) {
          nextInput.ownerDisplayName = String(patch.ownerDisplayName || '').trim().slice(0, 80)
        } else if (nextInput.ownerEmpNo !== job.ownerEmpNo) {
          nextInput.ownerDisplayName = nextInput.ownerEmpNo === UNASSIGNED_OWNER
            ? ''
            : (patch.ownerDisplayName || nextInput.ownerEmpNo)
        }
      }
      const record = createJobRecord(nextInput, current, t)
      record.createdAt = job.createdAt
      record.lastRunAt = job.lastRunAt
      record.lastStatus = job.lastStatus
      if (patch.origin === undefined && job.origin) record.origin = job.origin
      if (patch.schedule === undefined && patch.enabled === undefined) {
        record.nextRunAt = job.nextRunAt
      }
      // Clear optional monitor fields when explicitly set to null.
      if (patch.watch === null) delete record.watch
      if (patch.progress === null) delete record.progress
      if (patch.report === null) delete record.report
      return upsertJob(current, record)
    })
    return jobView(getJob(state, jobId), state.runs)
  }

  async function pauseJob(jobId, enabled, identity = null) {
    return updateJob(jobId, { enabled }, identity)
  }

  /**
   * Fire an extra run, or re-arm a consumed one-shot.
   * - recurring (cron): after_minutes must be 0/omitted → enable + immediate run-now (keeps cron next)
   * - one-shot (at): consumed only; 0 → run-now; >0 → reschedule next
   * Auto-enables paused jobs. Rejects when a run is already pending/running.
   */
  async function retriggerJob(jobId, opts = {}, identity = null) {
    const afterRaw = opts.afterMinutes ?? opts.after_minutes
    const afterMinutes = afterRaw === undefined || afterRaw === null || afterRaw === ''
      ? 0
      : Number(afterRaw)
    if (!Number.isFinite(afterMinutes) || afterMinutes < 0) {
      const error = new Error('after_minutes must be >= 0')
      error.code = 'INVALID_RETRIGGER'
      throw error
    }
    const delayMs = Math.round(afterMinutes * 60_000)
    const t = now()
    let mode = delayMs > 0 ? 'scheduled' : 'immediate'

    await withState((current) => {
      const job = getJob(current, jobId)
      if (!job) {
        const error = new Error('job not found')
        error.code = 'NOT_FOUND'
        throw error
      }
      if (identity) assertCanAccessJob(job, identity)
      const kind = job.schedule?.kind
      if (kind !== 'at' && kind !== 'cron') {
        const error = new Error('cron_retrigger requires a one-shot (at) or recurring (cron) job')
        error.code = 'INVALID_RETRIGGER'
        throw error
      }
      const runs = (current.runs || []).filter((run) => run?.jobId === job.id)
      if (runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status))) {
        const error = new Error('job already has a pending or running instance')
        error.code = 'ALREADY_RUNNING'
        throw error
      }

      if (kind === 'cron') {
        if (delayMs > 0) {
          const error = new Error('after_minutes delay is only for one-shot jobs; omit it to fire a recurring job immediately')
          error.code = 'INVALID_RETRIGGER'
          throw error
        }
        if (job.enabled === false) {
          return upsertJob(current, { ...job, enabled: true, updatedAt: t })
        }
        return current
      }

      // one-shot
      if (job.nextRunAt != null) {
        const error = new Error('one-shot still has a pending next run; wait or edit the schedule instead of retrigger')
        error.code = 'INVALID_RETRIGGER'
        throw error
      }
      const terminal = job.lastStatus === 'succeeded'
        || job.lastStatus === 'failed'
        || job.lastStatus === 'skipped'
      if (!terminal) {
        const error = new Error('one-shot has not finished a run yet; nothing to retrigger')
        error.code = 'INVALID_RETRIGGER'
        throw error
      }

      if (delayMs > 0) {
        const atMs = t + delayMs
        return upsertJob(current, {
          ...job,
          enabled: true,
          schedule: {
            kind: 'at',
            at: new Date(atMs).toISOString(),
            timezone: job.schedule?.timezone || current.settings?.timezone || 'Asia/Shanghai',
          },
          nextRunAt: atMs,
          updatedAt: t,
        })
      }
      if (job.enabled === false) {
        return upsertJob(current, { ...job, enabled: true, updatedAt: t })
      }
      return current
    })

    if (mode === 'scheduled') {
      const state = await snapshot()
      const job = getJob(state, jobId)
      return {
        ok: true,
        mode,
        job: jobView(job, state.runs),
        run: null,
        nextRunAt: job?.nextRunAt ?? null,
      }
    }

    const result = await dispatchRun(jobId, 'run-now')
    return {
      ok: true,
      mode,
      job: result.job,
      run: result.run,
      decision: result.decision,
      nextRunAt: result.job?.nextRunAt ?? null,
    }
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
      return settleAndNotify(jobId, run.id, claimed.decision)
    }
    return settleAndNotify(jobId, claimed.run.id, claimed.decision)
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
      await tickWatcherReports()
      try {
        await archiveJobRuns(null, { limit: 20 })
      } catch (error) {
        logger.warn?.(`[dsh-ops-cron] archive tick failed: ${error instanceof Error ? error.message : error}`)
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


  async function migrateOwnersIfNeeded() {
    const uds = getUdsAuth()
    await withState((current) => {
      const { state, changed } = migrateJobOwners(current, {
        getSessionOwner: (sessionId) => uds?.getSessionOwner?.(sessionId) || null,
      })
      return changed ? state : current
    })
  }

  async function recover() {
    await mkdir(join(dshHome(), 'ops-cron'), { recursive: true })
    await migrateOwnersIfNeeded()
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
        const identity = await requireIdentity(req, write, getUdsAuth)
        if (!identity) return
        const state = await snapshot()
        write(200, { ok: true, settings: state.settings })
        return
      }

      if (path === `${API_PREFIX}/settings` && method === 'PUT') {
        const identity = await requireIdentity(req, write, getUdsAuth)
        if (!identity) return
        const body = await readJsonBody(req)
        const settings = await updateSettings(body)
        write(200, { ok: true, settings })
        return
      }

      if (path === `${API_PREFIX}/models` && method === 'GET') {
        const identity = await requireIdentity(req, write, getUdsAuth)
        if (!identity) return
        const catalog = typeof sessionPort?.listModels === 'function'
          ? await sessionPort.listModels()
          : { groups: [], current: null }
        write(200, { ok: true, ...catalog })
        return
      }

      if (path === `${API_PREFIX}/presets` && method === 'GET') {
        const identity = await requireIdentity(req, write, getUdsAuth)
        if (!identity) return
        const catalog = typeof sessionPort?.listPresets === 'function'
          ? await sessionPort.listPresets()
          : { items: [], current: null }
        write(200, { ok: true, ...catalog })
        return
      }

      if (path === `${API_PREFIX}/workspaces` && method === 'GET') {
        const identity = await requireIdentity(req, write, getUdsAuth)
        if (!identity) return
        let workspaces = typeof sessionPort?.listWorkspaces === 'function'
          ? await sessionPort.listWorkspaces()
          : []
        if (!Array.isArray(workspaces)) workspaces = []
        const uds = getUdsAuth()
        if (!canViewAllJobs(identity) && uds?.isUserPath) {
          workspaces = workspaces.filter((row) => uds.isUserPath(identity.empNo, row?.path))
        }
        if (!canViewAllJobs(identity) && workspaces.length === 0) {
          const pathOnly = identity.workspacePath || uds?.getProvisionedWorkspacePath?.(identity.empNo)
          if (pathOnly) workspaces = [{ id: null, path: pathOnly, name: identity.displayName || identity.empNo }]
        }
        write(200, { ok: true, workspaces, viewer: viewerPayload(identity) })
        return
      }

      if (path === `${API_PREFIX}/im-catalog` && method === 'GET') {
        const identity = await requireIdentity(req, write, getUdsAuth)
        if (!identity) return
        if (!canViewAllJobs(identity)) {
          write(200, {
            ok: true,
            available: true,
            options: [],
            hint: 'IM delivery from the web sidebar is super_admin-only; create channel jobs from the WhatsApp/IM chat',
          })
          return
        }
        const dshIm = getDshIm()
        if (!dshIm || typeof dshIm.listDeliveryCatalog !== 'function') {
          write(200, {
            ok: true,
            available: false,
            options: [],
            hint: 'dsh-im-ops missing or outdated — install ≥ops.24 for delivery picker',
          })
          return
        }
        try {
          const options = await dshIm.listDeliveryCatalog()
          write(200, {
            ok: true,
            available: true,
            options: Array.isArray(options) ? options : [],
          })
        } catch (error) {
          write(200, {
            ok: true,
            available: false,
            options: [],
            hint: error instanceof Error ? error.message : String(error),
          })
        }
        return
      }

      if (path === `${API_PREFIX}/jobs` && method === 'GET') {
        const identity = await requireIdentity(req, write, getUdsAuth)
        if (!identity) return
        const uds = getUdsAuth()
        const state = await withState((current) => {
          const { state: next, changed } = claimUnassignedForViewer(current, identity, {
            getSessionOwner: typeof uds?.getSessionOwner === 'function'
              ? (sessionId) => uds.getSessionOwner(sessionId)
              : undefined,
          })
          return changed ? next : current
        })
        const jobs = filterJobsForIdentity(listJobs(state), identity)
          .map((job) => jobView(job, state.runs))
        write(200, {
          ok: true,
          jobs,
          viewer: viewerPayload(identity),
        })
        return
      }

      if (path === `${API_PREFIX}/jobs` && method === 'POST') {
        const identity = await requireIdentity(req, write, getUdsAuth)
        if (!identity) return
        const body = await readJsonBody(req)
        const job = await createJob(body, identity)
        write(200, { ok: true, job })
        return
      }

      const jobMatch = path.match(new RegExp(`^${API_PREFIX}/jobs/([^/]+)(/run|/pause|/resume|/retrigger)?$`))
      if (jobMatch) {
        const jobId = decodeURIComponent(jobMatch[1])
        const rest = jobMatch[2] || ''
        const identity = await requireIdentity(req, write, getUdsAuth)
        if (!identity) return
        const state = await snapshot()
        const existing = getJob(state, jobId)
        assertCanAccessJob(existing, identity)
        if (method === 'GET' && !rest) {
          write(200, { ok: true, job: jobView(existing, state.runs) })
          return
        }
        if (method === 'PATCH' && !rest) {
          const body = await readJsonBody(req)
          const job = await updateJob(jobId, body, identity)
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
        if (method === 'POST' && rest === '/retrigger') {
          const body = await readJsonBody(req).catch(() => ({}))
          const result = await retriggerJob(jobId, body || {}, identity)
          write(200, result)
          return
        }
        if (method === 'POST' && rest === '/pause') {
          const job = await pauseJob(jobId, false, identity)
          write(200, { ok: true, job })
          return
        }
        if (method === 'POST' && rest === '/resume') {
          const job = await pauseJob(jobId, true, identity)
          write(200, { ok: true, job })
          return
        }
      }

      const openMatch = path.match(new RegExp(`^${API_PREFIX}/runs/([^/]+)/open$`))
      if (openMatch && method === 'POST') {
        const identity = await requireIdentity(req, write, getUdsAuth)
        if (!identity) return
        const runId = decodeURIComponent(openMatch[1])
        const state = await snapshot()
        const run = (state.runs || []).find((row) => row.id === runId)
        if (!run?.sessionId) return write(404, apiError('run_not_found', resolveLocale(req, identity)))
        assertCanAccessJob(getJob(state, run.jobId), identity)
        let unarchived = false
        if (typeof sessionPort?.revealSession === 'function') {
          unarchived = await sessionPort.revealSession(run.sessionId)
        }
        write(200, { ok: true, sessionId: run.sessionId, runId: run.id, unarchived: unarchived !== false })
        return
      }

      const adoptMatch = path.match(new RegExp(`^${API_PREFIX}/sessions/([^/]+)/adopt$`))
      if (adoptMatch && method === 'POST') {
        const identity = await requireIdentity(req, write, getUdsAuth)
        if (!identity) return
        const sessionId = decodeURIComponent(adoptMatch[1])
        if (!sessionId) return write(400, apiError('session_id_required', resolveLocale(req, identity)))
        if (typeof sessionPort?.adoptSession !== 'function') {
          return write(200, { ok: false, attached: false, sessionId })
        }
        const result = await sessionPort.adoptSession(sessionId)
        write(200, { ok: true, sessionId, ...result })
        return
      }

      if (path === `${API_PREFIX}/conceal` && method === 'POST') {
        const identity = await requireIdentity(req, write, getUdsAuth)
        if (!identity) return
        const hidden = await concealKnownSessions()
        write(200, { ok: true, hidden })
        return
      }

      if (path === `${API_PREFIX}/history` && method === 'GET') {
        const identity = await requireIdentity(req, write, getUdsAuth)
        if (!identity) return
        const state = await snapshot()
        const jobId = url.searchParams.get('jobId') || undefined
        if (jobId) {
          assertCanAccessJob(getJob(state, jobId), identity)
        }
        const visibleJobs = filterJobsForIdentity(listJobs(state), identity)
        const runs = filterRunsForJobs(listHistory(state, jobId), visibleJobs).map(runView)
        write(200, { ok: true, runs, viewer: viewerPayload(identity) })
        return
      }

      if (path === `${API_PREFIX}/query` && method === 'GET') {
        const identity = await requireIdentity(req, write, getUdsAuth)
        if (!identity) return
        const taskId = url.searchParams.get('taskId') || url.searchParams.get('task_id') || ''
        const stateFilter = url.searchParams.get('state') || ''
        const match = url.searchParams.get('match') === 'any' ? 'any' : 'all'
        const includeRuns = url.searchParams.get('include_runs') === '1'
          || url.searchParams.get('include_runs') === 'true'
        const decodeProgress = url.searchParams.get('decode_progress') === '1'
          || url.searchParams.get('decode_progress') === 'true'
        const labels = {}
        for (const [key, value] of url.searchParams.entries()) {
          if (key.startsWith('label.')) labels[key.slice(6)] = value
        }
        const result = await queryJobs({
          taskId: taskId || undefined,
          labels: Object.keys(labels).length ? labels : undefined,
          match,
          state: stateFilter || undefined,
          includeRuns,
          decodeProgress,
        }, identity)
        write(200, { ok: true, ...result, viewer: viewerPayload(identity) })
        return
      }

      if (path === `${API_PREFIX}/progress` && method === 'GET') {
        const identity = await requireIdentity(req, write, getUdsAuth)
        if (!identity) return
        const taskId = url.searchParams.get('taskId') || url.searchParams.get('task_id') || ''
        const labels = {}
        for (const [key, value] of url.searchParams.entries()) {
          if (key.startsWith('label.')) labels[key.slice(6)] = value
        }
        const match = url.searchParams.get('match') === 'any' ? 'any' : 'all'
        const result = await getProgress({
          taskId: taskId || undefined,
          labels: Object.keys(labels).length ? labels : undefined,
          match,
        }, identity)
        write(200, { ok: true, ...result, viewer: viewerPayload(identity) })
        return
      }

      if (path === `${API_PREFIX}/archive` && method === 'POST') {
        const identity = await requireIdentity(req, write, getUdsAuth)
        if (!identity) return
        const body = await readJsonBody(req).catch(() => ({}))
        const jobId = typeof body.jobId === 'string' ? body.jobId.trim()
          : (typeof body.task_id === 'string' ? body.task_id.trim() : '')
        const result = await archiveJobRuns(jobId || null, {
          identity,
          limit: Number(body.limit) > 0 ? Number(body.limit) : 50,
        })
        write(200, { ok: true, ...result })
        return
      }

      if (path === `${API_PREFIX}/preview` && method === 'POST') {
        const identity = await requireIdentity(req, write, getUdsAuth)
        if (!identity) return
        const body = await readJsonBody(req)
        const settings = (await snapshot()).settings
        const schedule = validateSchedule(body.schedule || body, body.timezone || settings.timezone)
        const nextRunAt = nextFire(schedule, now(), schedule.timezone)
        write(200, { ok: true, nextRunAt, schedule })
        return
      }

      if (path === `${API_PREFIX}/workspace-visible` && method === 'GET') {
        const identity = await requireIdentity(req, write, getUdsAuth)
        if (!identity) return
        const state = await snapshot()
        const listed = url.searchParams.getAll('id')
        write(200, {
          ok: true,
          hiddenSessionIds: state.hiddenSessionIds || [],
          visible: workspaceVisibleIds(listed, state.hiddenSessionIds),
        })
        return
      }

      write(404, apiError('not_found', resolveLocale(req)))
    } catch (error) {
      const locale = resolveLocale(req)
      const code = error && error.code
      if (code === 'NOT_FOUND') return write(404, { ...apiError('not_found', locale), error: error.message || 'not_found' })
      if (code === 'ALREADY_RUNNING') {
        return write(409, { ok: false, error: error.message, code, message: error.message })
      }
      if (code === 'INVALID_CRON' || code === 'INVALID_AT' || code === 'INVALID_SCHEDULE' || code === 'INVALID_JOB' || code === 'INVALID_TIMEZONE' || code === 'INVALID_CWD' || code === 'INVALID_DELIVERY' || code === 'IM_DELIVERY_FORBIDDEN' || code === 'IM_TARGET_FORBIDDEN' || code === 'IM_JOB_MISSING_CWD' || code === 'INVALID_WATCH' || code === 'INVALID_PROGRESS' || code === 'INVALID_REPORT' || code === 'INVALID_PERSIST_HISTORY' || code === 'INVALID_PROGRESS_PATH' || code === 'INVALID_ARCHIVE' || code === 'ARCHIVE_FAILED' || code === 'ARCHIVE_UNAVAILABLE' || code === 'INVALID_RETRIGGER') {
        return write(400, { ok: false, error: error.message, code, message: error.message })
      }
      if (code === 'PAYLOAD_TOO_LARGE') return write(413, apiError('payload_too_large', locale))
      write(500, {
        ...apiError('internal', locale),
        error: error instanceof Error ? error.message : 'internal',
      })
    }
  }

  function filterJobsByQuery(jobs, query = {}) {
    let out = [...jobs]
    const labels = normalizeLabels(query.labels)
    if (Object.keys(labels).length) {
      const match = query.match === 'any' ? 'any' : 'all'
      out = out.filter((job) => labelsMatch(job.labels, labels, match))
    }
    if (query.taskId) {
      out = out.filter((job) => job.id === query.taskId)
    }
    return out
  }

  async function queryJobs(query = {}, identity = null) {
    const state = await snapshot()
    let jobs = listJobs(state)
    if (identity) jobs = filterJobsForIdentity(jobs, identity)
    const by = {}
    if (query.taskId) by.taskId = String(query.taskId).trim()
    if (query.labels) by.labels = normalizeLabels(query.labels)
    if (query.match) by.match = query.match === 'any' ? 'any' : 'all'
    if (by.taskId || (by.labels && Object.keys(by.labels).length)) {
      jobs = selectJobsByWatch(jobs, by)
    } else {
      jobs = filterJobsByQuery(jobs, query)
    }
    const stateFilter = typeof query.state === 'string' ? query.state.trim() : ''
    const views = jobs.map((job) => jobView(job, state.runs))
    const filtered = stateFilter
      ? views.filter((job) => job.state === stateFilter)
      : views
    const includeRuns = query.includeRuns === true || query.include_runs === true
    const decodeProgress = query.decodeProgress === true || query.decode_progress === true
    const items = []
    for (const job of filtered) {
      const item = { job }
      if (includeRuns) {
        item.runs = listHistory(state, job.id).map(runView)
      }
      if (decodeProgress) {
        const raw = getJob(state, job.id)
        item.progress = await readProgressSnapshot(raw)
      }
      items.push(item)
    }
    return { jobs: filtered, items, count: filtered.length }
  }

  async function listRuns(taskId, opts = {}, identity = null) {
    const id = String(taskId || '').trim()
    if (!id) {
      const error = new Error('task_id is required')
      error.code = 'INVALID_JOB'
      throw error
    }
    const state = await snapshot()
    const job = getJob(state, id)
    if (identity) assertCanAccessJob(job, identity)
    else if (!job) {
      const error = new Error('job not found')
      error.code = 'NOT_FOUND'
      throw error
    }
    const page = listHistoryPage(state, id, opts)
    return {
      task_id: id,
      runs: page.runs.map(runView),
      next_cursor: page.nextCursor,
      total: page.total,
    }
  }

  async function getProgress(query = {}, identity = null) {
    const state = await snapshot()
    let jobs = listJobs(state)
    if (identity) jobs = filterJobsForIdentity(jobs, identity)
    const by = {}
    if (query.taskId) by.taskId = String(query.taskId).trim()
    if (query.labels) by.labels = normalizeLabels(query.labels)
    if (query.match) by.match = query.match === 'any' ? 'any' : 'all'
    if (query.by_watch && typeof query.by_watch === 'object') {
      if (query.by_watch.taskId) by.taskId = String(query.by_watch.taskId).trim()
      if (query.by_watch.labels) by.labels = normalizeLabels(query.by_watch.labels)
      if (query.by_watch.match) by.match = query.by_watch.match === 'any' ? 'any' : 'all'
    }
    const selected = (by.taskId || (by.labels && Object.keys(by.labels).length))
      ? selectJobsByWatch(jobs, by)
      : filterJobsByQuery(jobs, query)
    const snapshots = []
    for (const job of selected) {
      snapshots.push({
        job: jobView(job, state.runs),
        progress: await readProgressSnapshot(job),
      })
    }
    return { snapshots, count: snapshots.length }
  }

  /**
   * Periodic / on_change report tick for watcher jobs.
   */
  async function tickWatcherReports() {
    const state = await snapshot()
    const t = now()
    for (const watcher of listJobs(state)) {
      if (!watcher?.watch || !watcher.report) continue
      if (watcher.report.delivery === 'none') continue
      if (watcher.report.mode !== 'periodic' && watcher.report.mode !== 'on_change') continue
      if (watcher.report.mode === 'periodic') {
        const intervalMs = Math.max(1, Number(watcher.report.intervalMin) || 15) * 60_000
        if (watcher.lastReportAt && (t - watcher.lastReportAt) < intervalMs) continue
      }
      const targets = selectJobsByWatch(listJobs(state), watcher.watch)
        .filter((job) => job.id !== watcher.id)
        .map((job) => jobView(job, state.runs))
      if (!targets.length) continue
      const progressById = {}
      let changed = false
      for (const target of targets) {
        const raw = getJob(state, target.id)
        const snap = await readProgressSnapshot(raw)
        progressById[target.id] = snap
        const hash = JSON.stringify(snap?.metrics || {})
        if (watcher.report.mode === 'on_change') {
          const prev = watcher.lastProgressHash?.[target.id]
          if (prev !== hash) changed = true
        }
      }
      if (watcher.report.mode === 'on_change' && !changed) continue
      const text = formatWatchReport(watcher, targets, progressById)
      try {
        if ((watcher.report.delivery === 'im' || watcher.delivery?.kind === 'im')
          && watcher.delivery?.kind === 'im') {
          await deliverRunToIm(watcher, text, { dshIm: getDshIm() })
        }
        const hashes = { ...(watcher.lastProgressHash || {}) }
        for (const [id, snap] of Object.entries(progressById)) {
          hashes[id] = JSON.stringify(snap?.metrics || {})
        }
        await withState((current) => {
          const job = getJob(current, watcher.id)
          if (!job) return current
          return upsertJob(current, {
            ...job,
            lastReportAt: t,
            lastProgressHash: hashes,
            updatedAt: job.updatedAt,
          })
        })
      } catch (error) {
        logger.warn?.(`[dsh-ops-cron] periodic report failed for ${watcher.id}: ${error instanceof Error ? error.message : error}`)
      }
    }
  }

  return {
    store,
    now,
    createJob,
    updateJob,
    pauseJob,
    retriggerJob,
    deleteJob,
    updateSettings,
    dispatchRun,
    tick,
    tickWatcherReports,
    recover,
    startTimer,
    stopTimer,
    handleRequest,
    snapshot,
    getUdsAuth,
    queryJobs,
    listRuns,
    getProgress,
    archiveJobRuns,
    async listJobs(identity = null, query = null) {
      const state = await snapshot()
      let jobs = listJobs(state)
      if (identity) jobs = filterJobsForIdentity(jobs, identity)
      if (query) {
        jobs = filterJobsByQuery(jobs, query)
        const views = jobs.map((job) => jobView(job, state.runs))
        if (query.state) return views.filter((job) => job.state === query.state)
        return views
      }
      return jobs.map((job) => jobView(job, state.runs))
    },
    async getJob(jobId, identity = null) {
      const state = await snapshot()
      const job = getJob(state, jobId)
      if (!job) return null
      if (identity) assertCanAccessJob(job, identity)
      return jobView(job, state.runs)
    },
    async listHistory(jobId, identity = null) {
      const state = await snapshot()
      if (jobId && identity) assertCanAccessJob(getJob(state, jobId), identity)
      const runs = listHistory(state, jobId)
      if (!identity) return runs.map(runView)
      const visible = filterJobsForIdentity(listJobs(state), identity)
      return filterRunsForJobs(runs, visible).map(runView)
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
 * True when the job owner may keep an explicit cwd outside their provisioned tree
 * (super_admin / fallback_admin via canViewAllSessions, canCreateWorkspace, or role).
 */
export function ownerAllowsForeignCwd(ownerEmpNo, uds) {
  const empNo = String(ownerEmpNo || '').trim()
  if (!empNo || empNo.startsWith('__') || !uds) return false
  if (typeof uds.resolveIdentityForEmpNo === 'function') {
    const identity = uds.resolveIdentityForEmpNo(empNo)
    if (canViewAllJobs(identity)) return true
    return !!(
      identity?.permissions?.canViewAllSessions
      || identity?.permissions?.canCreateWorkspace
      || isElevatedCronRole(identity?.role)
    )
  }
  return false
}

/**
 * Placement order:
 * 1. Explicit job.cwd (kept for elevated owners; shared trees outside forest kept when allowExternalCwd;
 *    clamped to owner tree only when inside provision forest but not the owner's path)
 * 2. Owner provisioned path (multi-user)
 * 3. Recent registry workspace — only standalone / non-IM unassigned
 * 4. Shared ops-cron fallback
 * IM-origin jobs never fall back to workspaces[0]; missing cwd → missingCwd.
 * Official attachSession requires header.cwd === workspace.path.
 */
export function resolveSessionPlacement(ctx, job = {}, deps = {}) {
  const workspaces = listWorkspaces(ctx)
  const match = (path) => (path && workspaces.find((row) => workspacePathOf(row) === path)) || null
  const uds = deps.udsAuth || (typeof deps.getUdsAuth === 'function' ? deps.getUdsAuth() : tryGet(ctx, 'udsAuth'))
  const ownerEmpNo = String(job?.ownerEmpNo || '').trim()
  const ownerPath = ownerEmpNo && !ownerEmpNo.startsWith('__') && uds?.getProvisionedWorkspacePath
    ? uds.getProvisionedWorkspacePath(ownerEmpNo)
    : null
  const imOrigin = normalizeOrigin(job?.origin)?.kind === 'im'
  const allowExternalCwd = deps.allowExternalCwd !== false

  let requested = String(job?.cwd || '').trim()
  if (requested && ownerEmpNo && !ownerEmpNo.startsWith('__') && uds?.isUserPath) {
    const allowForeign = ownerAllowsForeignCwd(ownerEmpNo, uds)
    if (!uds.isUserPath(ownerEmpNo, requested) && !allowForeign && ownerPath) {
      const forest = dirname(ownerPath)
      if (forest && isPathInside(requested, forest)) {
        requested = ownerPath
      } else if (allowExternalCwd === false) {
        requested = ownerPath
      }
      // else: outside forest → keep requested (shared business cwd)
    }
  }
  if (requested) return { cwd: requested, workspace: match(requested), missingCwd: false }
  if (imOrigin) {
    return { cwd: '', workspace: null, missingCwd: true }
  }
  if (ownerPath) return { cwd: ownerPath, workspace: match(ownerPath), missingCwd: false }
  // Do not use workspaces[0] for owned multi-user jobs (ownerPath already handled).
  // Standalone / unassigned (non-IM) may still use the most recent registry workspace.
  const recent = workspaces[0]
  const recentPath = workspacePathOf(recent)
  if (recentPath) return { cwd: recentPath, workspace: recent, missingCwd: false }
  const isolated = defaultCwd()
  return { cwd: isolated, workspace: match(isolated), missingCwd: false }
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

export async function listPresetChoices(ctx) {
  const presets = tryGet(ctx, 'agentPresets')
  if (!presets || typeof presets.list !== 'function') {
    return { items: [], current: null }
  }
  let items = []
  try {
    const listed = await presets.list()
    const rows = Array.isArray(listed) ? listed : (Array.isArray(listed?.items) ? listed.items : [])
    items = rows.map((row) => ({
      id: String(row?.id || '').trim(),
      name: String(row?.name || row?.displayName || row?.id || '').trim(),
    })).filter((row) => row.id)
  } catch {
    items = []
  }
  let current = null
  if (typeof presets.resolve === 'function') {
    try {
      const resolved = await presets.resolve()
      const id = typeof resolved?.id === 'string' ? resolved.id.trim() : ''
      if (id) current = { id, name: String(resolved?.name || id) }
    } catch {
      current = null
    }
  }
  return { items, current }
}

export async function resolveJobModel(ctx, job) {
  const split = splitProviderModel(job?.provider, job?.model)
  const provider = split.provider
  const model = split.model
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

async function composeCronAgent(ctx, selection, job) {
  const presets = tryGet(ctx, 'agentPresets')
  if (!presets || typeof presets.resolve !== 'function' || typeof presets.mount !== 'function') {
    return {
      setup: (agentCtx) => {
        bindModelSelection(agentCtx, selection)
      },
    }
  }
  const wanted = typeof job?.agentPreset === 'string' ? job.agentPreset.trim() : ''
  const resolved = wanted
    ? await presets.resolve(wanted)
    : await presets.resolve()
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
      const udsAuth = tryGet(ctx, 'udsAuth')
      const placement = resolveSessionPlacement(ctx, job, { udsAuth, allowExternalCwd: true })
      if (placement.missingCwd) {
        const error = new Error('IM scheduled job has no cwd; recreate it from the channel chat')
        error.code = 'IM_JOB_MISSING_CWD'
        throw error
      }
      const cwd = placement.cwd || defaultCwd()
      await mkdir(cwd, { recursive: true })
      const selection = await resolveJobModel(ctx, job)
      const composition = await composeCronAgent(ctx, selection, job)
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
        const owner = String(job?.ownerEmpNo || '').trim()
        if (owner && !owner.startsWith('__')) {
          udsAuth?.stampSessionOwner?.(sessionId, owner)
        }
      } catch {
        // Ownership stamp is best-effort.
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
    async listPresets() {
      return listPresetChoices(ctx)
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
