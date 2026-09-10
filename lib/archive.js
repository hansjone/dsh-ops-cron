/**
 * Push terminal cron runs to an external archive endpoint.
 * Endpoint receives JSON: { plugin, archivedAt, job, runs }.
 */

export function runsNeedingArchive(runs, jobId) {
  return (runs || []).filter((run) => (
    run
    && run.jobId === jobId
    && run.status !== 'queued'
    && run.status !== 'running'
    && !run.archivedAt
  ))
}

/**
 * @param {string} endpoint
 * @param {{ job: object, runs: object[] }} payload
 * @param {{ fetchImpl?: typeof fetch, now?: () => number }} [opts]
 */
export async function pushArchiveBatch(endpoint, payload, opts = {}) {
  const url = String(endpoint || '').trim()
  if (!url) {
    const error = new Error('archive endpoint is empty')
    error.code = 'INVALID_ARCHIVE'
    throw error
  }
  if (!/^https?:\/\//i.test(url)) {
    const error = new Error('archive endpoint must be http(s) URL')
    error.code = 'INVALID_ARCHIVE'
    throw error
  }
  const fetchImpl = opts.fetchImpl || globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    const error = new Error('fetch is not available for archive push')
    error.code = 'ARCHIVE_UNAVAILABLE'
    throw error
  }
  const body = {
    plugin: 'dsh-ops-cron',
    archivedAt: new Date((opts.now || Date.now)()).toISOString(),
    job: payload.job,
    runs: payload.runs,
  }
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = typeof res.text === 'function' ? await res.text().catch(() => '') : ''
    const error = new Error(`archive endpoint returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
    error.code = 'ARCHIVE_FAILED'
    error.status = res.status
    throw error
  }
  let parsed = null
  try {
    parsed = typeof res.json === 'function' ? await res.json() : null
  } catch {
    parsed = null
  }
  return { ok: true, status: res.status, body: parsed }
}

/**
 * Mark runs archived in state (pure).
 */
export function markRunsArchived(state, runIds, now) {
  const ids = new Set(runIds || [])
  if (!ids.size) return state
  return {
    ...state,
    runs: (state.runs || []).map((run) => (
      ids.has(run.id) ? { ...run, archivedAt: now } : run
    )),
  }
}

/**
 * After archive, drop old archived terminals for archive-policy jobs,
 * keeping the newest `keep` archived + all non-archived + all active.
 */
export function pruneArchivedRuns(state, keep = 50) {
  const jobs = state.jobs || []
  const byJob = new Map(jobs.map((job) => [job.id, job]))
  const active = []
  const pending = []
  const archivedByJob = new Map()
  for (const run of state.runs || []) {
    if (!run) continue
    if (run.status === 'queued' || run.status === 'running') {
      active.push(run)
      continue
    }
    const job = byJob.get(run.jobId)
    if (job?.persistHistory?.kind === 'archive' && run.archivedAt) {
      if (!archivedByJob.has(run.jobId)) archivedByJob.set(run.jobId, [])
      archivedByJob.get(run.jobId).push(run)
      continue
    }
    pending.push(run)
  }
  const keptArchived = []
  for (const rows of archivedByJob.values()) {
    rows.sort((a, b) => (b.archivedAt || b.actualAt || 0) - (a.archivedAt || a.actualAt || 0))
    keptArchived.push(...rows.slice(0, Math.max(0, keep)))
  }
  return { ...state, runs: [...active, ...pending, ...keptArchived] }
}
