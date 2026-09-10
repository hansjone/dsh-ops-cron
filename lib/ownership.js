/**
 * Job ownership helpers for per-user cron isolation (aligns with uds-auth roles).
 *
 * Two modes:
 * - standalone (no uds-auth): identity empNo is LOCAL_EMP_NO → everyone sees all jobs
 * - multi-user (uds-auth present): filter/claim by real empNo
 */

export const UNASSIGNED_OWNER = '__unassigned__'
export const LOCAL_EMP_NO = '__local__'

export function normalizeOwnerEmpNo(value) {
  const empNo = String(value || '').trim()
  return empNo || UNASSIGNED_OWNER
}

/** True when uds-auth supplied a real user identity (not standalone local). */
export function isMultiUserIdentity(identity) {
  const empNo = String(identity?.empNo || '').trim()
  return !!empNo && empNo !== LOCAL_EMP_NO
}

export function localIdentity(overrides = {}) {
  return {
    empNo: LOCAL_EMP_NO,
    role: 'local',
    displayName: 'local',
    permissions: { canViewAllSessions: true },
    workspacePath: null,
    mode: 'local',
    ...overrides,
  }
}

/** Roles that may keep foreign cwd and see every job (aligns with uds-auth). */
export function isElevatedCronRole(role) {
  const value = String(role || '').trim()
  return value === 'super_admin' || value === 'fallback_admin'
}

export function canViewAllJobs(identity) {
  if (!isMultiUserIdentity(identity)) return true
  if (identity?.permissions?.canViewAllSessions) return true
  // Defense: some callers stamp role without copying permissions.
  return isElevatedCronRole(identity?.role)
}

export function jobVisibleToIdentity(job, identity) {
  if (!identity?.empNo) return false
  // Standalone / local: no empNo isolation.
  if (!isMultiUserIdentity(identity) || canViewAllJobs(identity)) return true
  const owner = normalizeOwnerEmpNo(job?.ownerEmpNo)
  // Unclaimed jobs are admin-only in multi-user mode.
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
  if (!isMultiUserIdentity(identity) || canViewAllJobs(identity)) return [...list]
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
  const multi = isMultiUserIdentity(identity)
  return {
    empNo: identity.empNo,
    role: identity.role || (multi ? 'user' : 'local'),
    displayName: identity.displayName || identity.empNo,
    canViewAll: canViewAllJobs(identity),
    workspacePath: identity.workspacePath || null,
    mode: multi ? 'multi' : 'local',
  }
}

/**
 * Default cwd when creating a job in the sidebar.
 * - super_admin / fallback_admin: prefer the currently open session workspace
 *   (they often work in a shared tree like D:\\code\\gpt, not their empty provisioned dir).
 * - ordinary multi-user: prefer provisioned path so a random open clone is not stamped.
 */
export function preferredNewJobCwd({ viewer = null, sessionCwd = '' } = {}) {
  const session = String(sessionCwd || '').trim()
  const provisioned = String(viewer?.workspacePath || '').trim()
  if (viewer?.canViewAll && session) return session
  if (isElevatedCronRole(viewer?.role) && session) return session
  if (viewer?.mode === 'multi' && provisioned) return provisioned
  if (provisioned) return provisioned
  return session
}

/**
 * Claim unassigned jobs that clearly belong to the viewer (origin session / cwd).
 * No-op in standalone / canViewAll. Returns { state, changed }.
 */
export function claimUnassignedForViewer(state, identity, deps = {}) {
  if (!isMultiUserIdentity(identity) || canViewAllJobs(identity)) {
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
    // Only claim when evidence ties the job to this viewer.
    if (sessionId && typeof deps.getSessionOwner === 'function') {
      mine = deps.getSessionOwner(sessionId) === identity.empNo
    }
    if (!mine && job.cwd) {
      const norm = String(job.cwd).replace(/\\/g, '/')
      const match = norm.match(/\/user-workspaces\/([^/]+)(?:\/|$)/)
      mine = !!(match && decodeURIComponent(match[1]) === identity.empNo)
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
