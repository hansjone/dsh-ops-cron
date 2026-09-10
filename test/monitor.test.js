import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  isRetriggerable,
  labelsMatch,
  normalizeLabels,
  normalizePersistHistory,
  normalizeProgress,
  normalizeReport,
  normalizeWatch,
  projectJobState,
  readProgressSnapshot,
  selectJobsByWatch,
} from '../lib/monitor.js'
import { createJobRecord, emptyState, listHistoryPage, pruneRuns } from '../lib/store.js'
import { claimOccurrence, publicJob, settleRun } from '../lib/fire.js'
import { createHostService } from '../lib/host.js'
import { cronToolDefinitions } from '../lib/tools.js'

test('isRetriggerable / publicJob.retriggerable for consumed oneshots', () => {
  const now = Date.parse('2026-09-10T08:00:00.000Z')
  const base = {
    id: 'j1',
    name: 'worker',
    enabled: true,
    schedule: { kind: 'at', at: new Date(now - 60_000).toISOString(), timezone: 'UTC' },
    nextRunAt: null,
    lastStatus: 'succeeded',
    lastRunAt: now - 30_000,
    timeoutMinutes: 10,
  }
  assert.equal(isRetriggerable(base, []), true)
  assert.equal(publicJob(base, []).retriggerable, true)

  const cron = {
    ...base,
    schedule: { kind: 'cron', expr: '0 9 * * *', timezone: 'UTC' },
    nextRunAt: now + 60_000,
    lastStatus: null,
  }
  assert.equal(isRetriggerable(cron, []), true)
  assert.equal(publicJob(cron, []).retriggerable, true)
  assert.equal(isRetriggerable(cron, [{ id: 'r1', jobId: 'j1', status: 'running' }]), false)

  assert.equal(isRetriggerable({ ...base, nextRunAt: now + 60_000 }, []), false)
  assert.equal(isRetriggerable({ ...base, lastStatus: null }, []), false)
  assert.equal(isRetriggerable(base, [{ id: 'r1', jobId: 'j1', status: 'running' }]), false)
})

test('settleRun keeps running enter time and stamps exitedAt separately', () => {
  const now = Date.parse('2026-09-10T07:00:00.000Z')
  const started = now - 60_000
  let state = emptyState()
  const job = createJobRecord({
    name: 'dur',
    prompt: 'x',
    schedule: { kind: 'at', at: new Date(now + 60_000).toISOString(), timezone: 'Asia/Shanghai' },
  }, state, now)
  state = { ...state, jobs: [job], runs: [{
    id: 'r1',
    jobId: job.id,
    status: 'running',
    scheduledAt: started,
    actualAt: started,
    stateEnteredAt: started,
    exitedAt: null,
    summary: '',
    error: null,
    sessionId: 's1',
  }] }
  state = settleRun(state, 'r1', { status: 'succeeded', summary: 'ok' }, now)
  const run = state.runs.find((row) => row.id === 'r1')
  assert.equal(run.status, 'succeeded')
  assert.equal(run.stateEnteredAt, started)
  assert.equal(run.actualAt, started)
  assert.equal(run.exitedAt, now)
  assert.ok(run.exitedAt > run.stateEnteredAt)
})

test('labelsMatch any/all', () => {
  const job = { role: 'worker', task: 'theory', owner: 'alice' }
  assert.equal(labelsMatch(job, { role: 'worker', task: 'theory' }, 'all'), true)
  assert.equal(labelsMatch(job, { role: 'worker', owner: 'bob' }, 'all'), false)
  assert.equal(labelsMatch(job, { role: 'worker', owner: 'bob' }, 'any'), true)
})

test('normalize watch / progress / report / persist_history', () => {
  assert.deepEqual(normalizeWatch({ taskId: 'abc', timeout_min: 30 }).taskId, 'abc')
  assert.equal(normalizeWatch({ labels: { task: 'theory' }, match: 'any' }).match, 'any')
  assert.throws(() => normalizeWatch({}), { code: 'INVALID_WATCH' })
  const progress = normalizeProgress({
    channel: { file: '进度.json' },
    metrics: [{ key: 'done', label: '已完成', unit: '个' }],
  })
  assert.equal(progress.channel.kind, 'file')
  assert.equal(progress.metrics[0].key, 'done')
  assert.equal(normalizeReport({ mode: 'periodic', delivery: 'im', interval_min: 5 }).intervalMin, 5)
  assert.equal(normalizePersistHistory('forever').kind, 'forever')
  assert.equal(normalizePersistHistory('retain:50').limit, 50)
  assert.equal(normalizePersistHistory('archive:https://example/archive').endpoint, 'https://example/archive')
})

test('projectJobState maps run statuses', () => {
  const job = {
    id: 'j1',
    enabled: true,
    timeoutMinutes: 10,
    schedule: { kind: 'cron', expr: '0 * * * *', timezone: 'Asia/Shanghai' },
    createdAt: 1,
    updatedAt: 1,
  }
  assert.equal(projectJobState(job, []).state, 'idle')
  assert.equal(projectJobState(job, [{ id: 'r1', status: 'queued', stateEnteredAt: 10 }]).state, 'pending')
  assert.equal(projectJobState(job, [{ id: 'r1', status: 'running', stateEnteredAt: 10 }]).state, 'running')
  assert.equal(projectJobState({ ...job, enabled: false }, []).state, 'paused')
  const stuck = projectJobState(
    job,
    [{ id: 'r1', status: 'running', stateEnteredAt: Date.now() - 2 * 60 * 60_000 }],
    Date.now(),
  )
  assert.equal(stuck.stuck, true)
})

test('createJobRecord stores monitor fields; publicJob exposes state', () => {
  const state = emptyState()
  const now = Date.parse('2026-09-10T07:00:00.000Z')
  const job = createJobRecord({
    name: 'worker',
    prompt: 'work',
    schedule: { kind: 'at', at: new Date(now + 60_000).toISOString(), timezone: 'Asia/Shanghai' },
    labels: { role: 'worker', task: 'theory' },
    progress: { channel: { file: 'p.json' }, metrics: [{ key: 'done' }] },
    persist_history: 'forever',
  }, state, now)
  assert.deepEqual(job.labels, { role: 'worker', task: 'theory' })
  assert.equal(job.persistHistory.kind, 'forever')
  assert.equal(job.progress.channel.file, 'p.json')
  const view = publicJob(job, [])
  assert.equal(view.state, 'idle')
  assert.deepEqual(view.labels, job.labels)
})

test('label overlap skips second worker', () => {
  const now = Date.parse('2026-09-10T07:00:00.000Z')
  let state = emptyState()
  const a = createJobRecord({
    name: 'w1',
    prompt: 'a',
    schedule: { kind: 'at', at: new Date(now + 60_000).toISOString(), timezone: 'Asia/Shanghai' },
    labels: { role: 'worker', task: 'theory' },
  }, state, now)
  const b = createJobRecord({
    name: 'w2',
    prompt: 'b',
    schedule: { kind: 'at', at: new Date(now + 60_000).toISOString(), timezone: 'Asia/Shanghai' },
    labels: { role: 'worker', task: 'theory' },
  }, state, now)
  state = { ...state, jobs: [a, b], runs: [{
    id: 'run-a',
    jobId: a.id,
    status: 'running',
    scheduledAt: now,
    actualAt: now,
    stateEnteredAt: now,
  }] }
  const claimed = claimOccurrence(state, b.id, now, 'run-now', state.settings)
  assert.equal(claimed.decision.action, 'skip')
  assert.equal(claimed.decision.reason, 'label_overlap')
})

test('pruneRuns forever keeps all terminals for that job', () => {
  const jobs = [{
    id: 'j1',
    persistHistory: { kind: 'forever' },
  }, {
    id: 'j2',
    persistHistory: { kind: 'retain', limit: 10 },
  }]
  const runs = []
  for (let i = 0; i < 30; i++) {
    runs.push({ id: `a${i}`, jobId: 'j1', status: 'succeeded', actualAt: i })
    runs.push({ id: `b${i}`, jobId: 'j2', status: 'succeeded', actualAt: i })
  }
  const pruned = pruneRuns(runs, 10, jobs)
  assert.equal(pruned.filter((r) => r.jobId === 'j1').length, 30)
  assert.equal(pruned.filter((r) => r.jobId === 'j2').length, 10)
})

test('listHistoryPage paginates', () => {
  const state = {
    runs: [
      { id: 'r3', jobId: 'j', status: 'succeeded', actualAt: 30 },
      { id: 'r2', jobId: 'j', status: 'succeeded', actualAt: 20 },
      { id: 'r1', jobId: 'j', status: 'succeeded', actualAt: 10 },
    ],
  }
  const page1 = listHistoryPage(state, 'j', { limit: 2 })
  assert.equal(page1.runs.length, 2)
  assert.equal(page1.nextCursor, 'r2')
  const page2 = listHistoryPage(state, 'j', { limit: 2, cursor: page1.nextCursor })
  assert.equal(page2.runs.length, 1)
  assert.equal(page2.runs[0].id, 'r1')
})

test('cron_query / cron_progress / cron_runs tools', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cron-mon-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const progressPath = join(dir, 'progress.json')
  await writeFile(progressPath, JSON.stringify({
    taskId: 'x',
    state: 'running',
    updatedAt: '2026-09-10T15:00:00+08:00',
    metrics: { total: 10, done: 3, percent: 30 },
  }), 'utf8')

  const service = createHostService({
    filePath: join(dir, 'store.json'),
    now: () => Date.parse('2026-09-10T07:00:00.000Z'),
    sessionPort: {
      async createAndPrompt() {
        return { sessionId: 's1', status: 'succeeded', summary: 'ok' }
      },
    },
  })
  const tools = Object.fromEntries(cronToolDefinitions(service).map((row) => [row.name, row]))
  const created = await tools.cron_create.execute({
    name: 'theory-worker',
    prompt: 'do theory',
    after_minutes: 5,
    labels: { role: 'worker', task: 'theory' },
    progress: { channel: { file: progressPath }, metrics: [{ key: 'done' }, { key: 'total' }] },
    persist_history: 'forever',
    cwd: dir,
  }, { agent: { session: { header: { cwd: dir } } } })
  assert.equal(created.job.labels.role, 'worker')
  assert.equal(created.job.state, 'idle')

  const watcher = await tools.cron_create.execute({
    name: 'theory-watch',
    prompt: 'watch workers via cron_query',
    expr: '*/5 * * * *',
    watch: { labels: { task: 'theory' }, match: 'all' },
    report: { mode: 'on_complete', delivery: 'none' },
    cwd: dir,
  }, { agent: { session: { header: { cwd: dir } } } })
  assert.equal(watcher.job.watch.labels.task, 'theory')

  const queried = await tools.cron_query.execute({
    labels: { task: 'theory' },
    match: 'all',
    decode_progress: true,
  }, {})
  assert.ok(queried.count >= 1)
  assert.ok(queried.items.some((item) => item.progress?.metrics?.done === 3))

  const listed = await tools.cron_list.execute({ labels: { role: 'worker' }, state: 'idle' }, {})
  assert.ok(listed.jobs.some((job) => job.id === created.job.id))

  await service.dispatchRun(created.job.id, 'run-now')
  const runs = await tools.cron_runs.execute({ task_id: created.job.id, limit: 10 }, {})
  assert.ok(runs.runs.length >= 1)
  assert.ok(runs.runs[0].stateEnteredAt)

  const progress = await tools.cron_progress.execute({ task_id: created.job.id }, {})
  assert.equal(progress.snapshots[0].progress.metrics.done, 3)

  assert.deepEqual(
    selectJobsByWatch([created.job, watcher.job], { labels: { task: 'theory' } }).map((j) => j.name),
    ['theory-worker'],
  )
  assert.deepEqual(
    selectJobsByWatch([created.job, watcher.job], watcher.job.watch).map((j) => j.name),
    ['theory-worker'],
  )
  assert.deepEqual(normalizeLabels({ a: 1 }), { a: '1' })
  assert.ok(await readProgressSnapshot(created.job))
})
