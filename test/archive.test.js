import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  markRunsArchived,
  pruneArchivedRuns,
  pushArchiveBatch,
  runsNeedingArchive,
} from '../lib/archive.js'
import { createHostService } from '../lib/host.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('runsNeedingArchive skips active and already archived', () => {
  const runs = [
    { id: '1', jobId: 'j', status: 'running' },
    { id: '2', jobId: 'j', status: 'succeeded' },
    { id: '3', jobId: 'j', status: 'failed', archivedAt: 1 },
    { id: '4', jobId: 'other', status: 'succeeded' },
  ]
  assert.deepEqual(runsNeedingArchive(runs, 'j').map((r) => r.id), ['2'])
})

test('pushArchiveBatch posts JSON and mark/prune archive local copy', async () => {
  const posts = []
  const result = await pushArchiveBatch('https://archive.example/cron', {
    job: { id: 'j1', name: 'n' },
    runs: [{ id: 'r1', status: 'succeeded' }],
  }, {
    now: () => Date.parse('2026-09-10T08:00:00.000Z'),
    fetchImpl: async (url, init) => {
      posts.push({ url, init })
      return { ok: true, status: 200, async json() { return { received: 1 } } }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(posts[0].url, 'https://archive.example/cron')
  assert.match(posts[0].init.body, /"plugin":"dsh-ops-cron"/)

  let state = {
    jobs: [{ id: 'j1', persistHistory: { kind: 'archive', endpoint: 'https://archive.example/cron' } }],
    runs: Array.from({ length: 60 }, (_, i) => ({
      id: `r${i}`,
      jobId: 'j1',
      status: 'succeeded',
      actualAt: i,
      archivedAt: i < 55 ? 1000 + i : undefined,
    })),
  }
  state = markRunsArchived(state, ['r59'], 9999)
  state = pruneArchivedRuns(state, 10)
  const archived = state.runs.filter((r) => r.archivedAt)
  assert.ok(archived.length <= 10)
  assert.ok(state.runs.some((r) => r.id === 'r59'))
})

test('host archiveJobRuns pushes and marks runs', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cron-arch-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const posts = []
  const service = createHostService({
    filePath: join(dir, 'store.json'),
    now: () => Date.parse('2026-09-10T08:00:00.000Z'),
    fetchImpl: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) })
      return { ok: true, status: 204, async json() { return null } }
    },
    sessionPort: {
      async createAndPrompt() {
        return { sessionId: 's-arch', status: 'succeeded', summary: 'done' }
      },
    },
  })
  const job = await service.createJob({
    name: 'arch-job',
    prompt: 'work',
    schedule: { kind: 'at', at: new Date(Date.parse('2026-09-10T08:01:00.000Z')).toISOString(), timezone: 'Asia/Shanghai' },
    cwd: dir,
    persistHistory: { kind: 'archive', endpoint: 'https://archive.example/intake' },
  })
  await service.dispatchRun(job.id, 'run-now')
  assert.ok(posts.length >= 1, 'settle should auto-archive')
  assert.equal(posts[0].url, 'https://archive.example/intake')
  assert.equal(posts[0].body.job.id, job.id)
  const snap = await service.snapshot()
  const run = (snap.runs || []).find((row) => row.jobId === job.id && row.status === 'succeeded')
  assert.ok(run?.archivedAt)
  const again = await service.archiveJobRuns(job.id, { limit: 10 })
  assert.equal(again.archived, 0)
})
