/**
 * Job ownership helpers for per-user cron isolation (aligns with uds-auth roles).
 */

export const UNASSIGNED_OWNER = '__unassigned__'

export function normalizeOwnerEmpNo(value) {
  const empNo = String(value || '').trim()
  return empNo || UNASSIGNED_OWNER
}

export function canViewAllJobs(identity) {
  return !!identity?.permissions?.canViewAllSessions
}

function empNoFromUserWorkspacePath(cwd) {
  const norm = String(cwd || '').replace(/\\/g, '/')
  const match = norm.match(/\/user-workspaces\/([^/]+)(?:\/|$)/)
  return match ? decodeURIComponent(match[1]) : null
}

export function jobVisibleToIdentity(job, identity) {
  if (!identity?.empNo) return false
  if (canViewAllJobs(identity)) return true
  const owner = normalizeOwnerEmpNo(job?.ownerEmpNo)
  // Unclaimed jobs are admin-only (super_admin / fallback_admin via canViewAll).
  if (owner === UNASSIGNED_OWNER) return false
  return owner === String(identity.empNo)
}

export function assertCanAccessJob(job, identity) {
  if (!job) {
    const error = new Error('job not found')
    error.code = 'NOT_FOUND'
    throw error
  }
  if (!identity?.empNo) {
    const error = new Error('login_required')
    error.code = 'LOGIN_REQUIRED'
    throw error
  }
  if (!jobVisibleToIdentity(job, identity)) {
    const error = new Error('job not found')
    error.code = 'NOT_FOUND'
    throw error
  }
  return job
}

export function filterJobsForIdentity(jobs, identity) {
  const list = Array.isArray(jobs) ? jobs : []
  if (!identity?.empNo) return []
  if (canViewAllJobs(identity)) return [...list]
  return list.filter((job) => jobVisibleToIdentity(job, identity))
}

export function filterRunsForJobs(runs, jobs) {
  const allowed = new Set((jobs || []).map((job) => job.id))
  return (Array.isArray(runs) ? runs : []).filter((run) => allowed.has(run.jobId))
}

/**
 * Infer owner for legacy jobs missing ownerEmpNo.
 * @param {object} job
 * @param {{ getSessionOwner?: (sessionId: string) => string|null }} [deps]
 */
export function inferOwnerEmpNo(job, deps = {}) {
  if (job?.ownerEmpNo) return normalizeOwnerEmpNo(job.ownerEmpNo)
  const origin = job?.origin
  if (origin?.kind === 'im') return UNASSIGNED_OWNER
  const sessionId = origin?.kind === 'web' && typeof origin.sessionId === 'string'
    ? origin.sessionId.trim()
    : ''
  if (sessionId && typeof deps.getSessionOwner === 'function') {
    const owner = deps.getSessionOwner(sessionId)
    if (owner) return normalizeOwnerEmpNo(owner)
  }
  return UNASSIGNED_OWNER
}

/**
 * Migrate jobs in-place; returns { state, changed }.
 */
export function migrateJobOwners(state, deps = {}) {
  const jobs = Array.isArray(state?.jobs) ? state.jobs : []
  let changed = false
  const nextJobs = jobs.map((job) => {
    if (!job || typeof job !== 'object') return job
    if (job.ownerEmpNo) {
      const normalized = normalizeOwnerEmpNo(job.ownerEmpNo)
      if (normalized === job.ownerEmpNo && job.ownerDisplayName !== undefined) return job
      changed = true
      return {
        ...job,
        ownerEmpNo: normalized,
        ownerDisplayName: job.ownerDisplayName || '',
      }
    }
    changed = true
    return {
      ...job,
      ownerEmpNo: inferOwnerEmpNo(job, deps),
      ownerDisplayName: job.ownerDisplayName || '',
    }
  })
  if (!changed) return { state, changed: false }
  return { state: { ...state, jobs: nextJobs }, changed: true }
}

export function viewerPayload(identity) {
  if (!identity?.empNo) return null
  return {
    empNo: identity.empNo,
    role: identity.role || 'user',
    displayName: identity.displayName || identity.empNo,
    canViewAll: canViewAllJobs(identity),
    workspacePath: identity.workspacePath || null,
  }
}

/**
 * Claim unassigned jobs that clearly belong to the viewer (origin session / cwd).
 * Returns { state, changed }.
 */
export function claimUnassignedForViewer(state, identity, deps = {}) {
  if (!identity?.empNo || canViewAllJobs(identity)) {
    return { state, changed: false }
  }
  const jobs = Array.isArray(state?.jobs) ? state.jobs : []
  let changed = false
  const nextJobs = jobs.map((job) => {
    if (!job || normalizeOwnerEmpNo(job.ownerEmpNo) !== UNASSIGNED_OWNER) return job
    const sessionId = job.origin?.kind === 'web' && typeof job.origin.sessionId === 'string'
      ? job.origin.sessionId.trim()
      : ''
    let mine = false
    // Only claim when evidence ties the job to this viewer. Remaining unassigned
    // jobs stay admin-only until a super/fallback admin reassigns them.
    if (sessionId && typeof deps.getSessionOwner === 'function') {
      mine = deps.getSessionOwner(sessionId) === identity.empNo
    }
    if (!mine && job.cwd) {
      const pathOwner = empNoFromUserWorkspacePath(job.cwd)
      if (pathOwner === identity.empNo) mine = true
    }
    if (!mine) return job
    changed = true
    return {
      ...job,
      ownerEmpNo: identity.empNo,
      ownerDisplayName: identity.displayName || identity.empNo,
    }
  })
  if (!changed) return { state, changed: false }
  return { state: { ...state, jobs: nextJobs }, changed: true }
}
