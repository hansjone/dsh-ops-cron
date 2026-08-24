/**
 * Workspace-list isolation for scheduled-run sessions.
 * Pure helpers: a run session id is hidden from the ordinary workspace
 * projection and retained in history. No Cordis imports.
 */

export const HIDDEN_REASON = 'cron-run'
export const TITLE_PREFIX = '定时任务 · '

/**
 * Strip the scheduler title prefix so a forked child can sit in the
 * ordinary workspace list. Official fork keeps the source title and
 * appends ` (1)`, which would otherwise stay hidden by hideNativeCronRows.
 */
export function workspaceTitleFromCronFork(title) {
  const value = String(title || '').trim()
  if (value.startsWith(TITLE_PREFIX)) {
    return value.slice(TITLE_PREFIX.length).trim() || value
  }
  if (value.startsWith('定时任务')) {
    const stripped = value.replace(/^定时任务(?:\s*·\s*|\s+)/, '').trim()
    return stripped || value
  }
  return value
}

function cronSessionIdSet(cronSessionIds) {
  if (cronSessionIds instanceof Set) return cronSessionIds
  return new Set(cronSessionIds || [])
}

/**
 * A native "fork in a new conversation" off a scheduled-run session:
 * new id, lineage parent is a known run, or we just left a run and the
 * child still carries the scheduler title.
 */
/**
 * Native workspace groups omit session rows when collapsed. Do not hide
 * 未分组 just because there are zero row nodes — that makes a loose fork
 * disappear after the user switches away.
 */
export function shouldHideNativeWorkspaceGroup({ sessionRowCount, visibleSessionCount, ungrouped, cronLabeled }) {
  const rows = Number(sessionRowCount) || 0
  const visible = Number(visibleSessionCount) || 0
  if (rows === 0) return false
  return visible === 0 && (ungrouped === true || cronLabeled === true)
}

export function shouldPromoteCronFork(row, cronSessionIds, previousId) {
  if (!row || typeof row !== 'object') return false
  const id = String(row.id || row.sessionId || '').trim()
  if (!id) return false
  const ids = cronSessionIdSet(cronSessionIds)
  if (ids.has(id)) return false
  const parent = String(row.parentId || row.parentSessionId || '').trim()
  if (parent && ids.has(parent)) return true
  const title = String(row.title || row.displayTitle || '')
  const looksCron = title.startsWith(TITLE_PREFIX) || title.startsWith('定时任务')
  if (previousId && ids.has(String(previousId)) && looksCron) return true
  return false
}

/**
 * Record that `sessionId` belongs to a scheduled run and must not appear
 * in the workspace/sidebar session list.
 *
 * @param {object} state
 * @param {string} sessionId
 * @returns {object} next state (copy-on-write)
 */
export function recordHiddenSession(state, sessionId) {
  const id = String(sessionId || '').trim()
  if (!id) throw new Error('sessionId is required')
  const hidden = new Set(state?.hiddenSessionIds || [])
  hidden.add(id)
  return {
    ...state,
    hiddenSessionIds: [...hidden],
  }
}

export function isHiddenFromWorkspace(sessionId, hiddenSessionIds) {
  const id = String(sessionId || '')
  if (!id) return false
  if (Array.isArray(hiddenSessionIds)) return hiddenSessionIds.includes(id)
  if (hiddenSessionIds instanceof Set) return hiddenSessionIds.has(id)
  return false
}

/**
 * Workspace-visible projection: drop every id the scheduler marked hidden.
 * Archived ids from the host are also excluded when provided.
 *
 * @param {string[]} allSessionIds
 * @param {string[]|Set<string>} hiddenSessionIds
 * @param {string[]|Set<string>} [archivedSessionIds]
 * @returns {string[]}
 */
export function workspaceVisibleIds(allSessionIds, hiddenSessionIds, archivedSessionIds) {
  const all = Array.isArray(allSessionIds) ? allSessionIds : []
  return all.filter((id) => {
    if (isHiddenFromWorkspace(id, hiddenSessionIds)) return false
    if (archivedSessionIds && isHiddenFromWorkspace(id, archivedSessionIds)) return false
    return true
  })
}

/**
 * Apply isolation after a run is recorded: hide the session and keep the
 * history row (history is the caller's array; we only verify the id is present).
 */
export function applyRunIsolation(state, run) {
  if (!run || typeof run !== 'object') throw new Error('run is required')
  const sessionId = run.sessionId
  const next = sessionId ? recordHiddenSession(state, sessionId) : { ...state, hiddenSessionIds: [...(state?.hiddenSessionIds || [])] }
  const history = Array.isArray(next.runs) ? next.runs : []
  const hasRow = history.some((row) => row && row.id === run.id)
  const runs = hasRow ? history : [...history, run]
  return { ...next, runs }
}
