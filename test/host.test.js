import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { adoptSessionIntoWorkspace, bindModelSelection, createHostService, listModelChoices, listWorkspaceChoices, makeLiveSessionPort, resolveDefaultModel, resolveJobModel, resolveSessionPlacement, unarchiveSession, waitForAgentTurn } from '../lib/host.js'
import { workspaceVisibleIds } from '../lib/isolation.js'

function createFakeAgent() {
  let status = 'idle'
  return {
    get status() { return status },
    session: {
      deriveMessages() {
        return [{ role: 'assistant', content: [{ type: 'text', text: '测试成功' }] }]
      },
    },
    followup() {
      status = 'running'
    },
    whenIdle() {
      if (status === 'idle') return Promise.resolve()
      return new Promise((resolve) => {
        setTimeout(() => {
          status = 'idle'
          resolve()
        }, 15)
      })
    },
  }
}

function fakeLiveCtx(archived) {
  const agentsById = new Map()
  return {
    get(name) {
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
      }
      if (name === 'agents') {
        return {
          async create({ sessionId }) {
            const agent = createFakeAgent()
            agentsById.set(sessionId, agent)
            return { agent, dispose: async () => {} }
          },
          get(id) { return agentsById.get(id) },
        }
      }
      if (name === 'workspaceRegistry') {
        return {
          async archiveSession(sessionId) { archived.push(sessionId) },
        }
      }
      return undefined
    },
  }
}

async function listen(service) {
  const server = createServer((req, res) => {
    service.handleRequest(req, res).catch((error) => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: String(error) }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function jsonRequest(base, path, options = {}) {
  const empNo = options.empNo || 'tester'
  const cookie = options.anonymous
    ? ''
    : (options.cookie || `PORTALSSOUser=${encodeURIComponent(empNo)}`)
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      accept: 'application/json',
      origin: base,
      host: new URL(base).host,
      'sec-fetch-site': 'same-origin',
      cookie,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  const body = await response.json()
  return { status: response.status, body }
}

function mockUdsAuth(options = {}) {
  const owners = new Map()
  const users = {
    tester: { role: 'user', canViewAll: false, path: '/tmp/user-workspaces/tester', displayName: 'Tester' },
    peer: { role: 'user', canViewAll: false, path: '/tmp/user-workspaces/peer', displayName: 'Peer' },
    admin1: { role: 'super_admin', canViewAll: true, path: '/tmp/user-workspaces/admin1', displayName: 'Admin' },
    '10329667': { role: 'super_admin', canViewAll: true, path: '/tmp/deepseek-harness/10329667', displayName: 'Super' },
    administrator: { role: 'fallback_admin', canViewAll: true, path: '/tmp/user-workspaces/administrator', displayName: 'Fallback' },
    ...(options.users || {}),
  }
  return {
    async resolveRequestIdentity(req) {
      const cookie = req?.headers?.cookie || ''
      const match = /(?:PORTALSSOUser|UDS_FALLBACK_USER|UDS_FALLBACK_UI)=([^;]+)/.exec(cookie)
      if (!match) return null
      const empNo = decodeURIComponent(match[1].trim())
      const row = users[empNo] || {
        role: 'user',
        canViewAll: false,
        path: `/tmp/user-workspaces/${empNo}`,
        displayName: empNo,
      }
      return {
        empNo,
        role: row.role,
        displayName: row.displayName || empNo,
        permissions: {
          canViewAllSessions: !!row.canViewAll,
          canCreateWorkspace: !!row.canViewAll,
        },
        workspacePath: row.path,
      }
    },
    resolveIdentityForEmpNo(empNo) {
      const id = String(empNo || '').trim()
      if (!id || id.startsWith('__')) return null
      const row = users[id] || {
        role: 'user',
        canViewAll: false,
        path: `/tmp/user-workspaces/${id}`,
        displayName: id,
      }
      return {
        empNo: id,
        role: row.role,
        displayName: row.displayName || id,
        permissions: {
          canViewAllSessions: !!row.canViewAll,
          canCreateWorkspace: !!row.canViewAll,
        },
        workspacePath: row.path,
      }
    },
    canViewAllJobs(identity) {
      return !!identity?.permissions?.canViewAllSessions
    },
    getProvisionedWorkspacePath(empNo) {
      return users[empNo]?.path || `/tmp/user-workspaces/${empNo}`
    },
    isUserPath(empNo, candidatePath) {
      if (!candidatePath) return false
      if (options.strictPath) {
        const root = this.getProvisionedWorkspacePath(empNo)
        const cand = String(candidatePath).replace(/\\/g, '/')
        const normRoot = String(root).replace(/\\/g, '/')
        return cand === normRoot || cand.startsWith(`${normRoot}/`)
      }
      return true
    },
    stampSessionOwner(sessionId, empNo) {
      if (sessionId && empNo) owners.set(String(sessionId), String(empNo))
    },
    getSessionOwner(sessionId) {
      return owners.get(String(sessionId)) || null
    },
  }
}

function createTestHost(options = {}) {
  const { udsAuthOptions, udsAuth, ...rest } = options
  const auth = udsAuth || mockUdsAuth(udsAuthOptions)
  return createHostService({
    ...rest,
    getUdsAuth: () => auth,
  })
}


test('host service: create, list, run-now, history, and workspace isolation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ops-cron-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const archived = []
  let clock = Date.parse('2026-08-24T01:00:00.000Z')
  let sessionSeq = 0
  const service = createTestHost({
    filePath: join(dir, 'store.json'),
    now: () => clock,
    sessionPort: {
      async createAndPrompt({ job }) {
        sessionSeq += 1
        const sessionId = `sess-${job.id}-${sessionSeq}`
        return { sessionId, status: 'succeeded', summary: `ran ${job.name}` }
      },
      async archiveSession(sessionId) {
        archived.push(sessionId)
      },
    },
  })

  const job = await service.createJob({
    name: 'weekday briefing',
    prompt: 'Summarize overnight CI failures.',
    cwd: '/tmp/cron-workspace',
    timeoutMinutes: 15,
    schedule: { kind: 'cron', expr: '0 9 * * 1-5', timezone: 'Asia/Shanghai' },
  })
  assert.equal(job.name, 'weekday briefing')
  assert.equal(job.enabled, true)
  assert.equal(job.cwd, '/tmp/cron-workspace')
  assert.equal(job.timeoutMinutes, 15)
  assert.equal(job.provider, '')
  assert.equal(job.model, '')
  assert.ok(job.nextRunAt > clock)

  const pinned = await service.createJob({
    name: 'pinned-model',
    prompt: 'use this model',
    schedule: { kind: 'cron', expr: '0 10 * * *', timezone: 'Asia/Shanghai' },
    provider: 'minimax-cn',
    model: 'MiniMax-M3',
  })
  assert.equal(pinned.provider, 'minimax-cn')
  assert.equal(pinned.model, 'MiniMax-M3')

  const listed = await service.listJobs()
  assert.equal(listed.length, 2)
  assert.ok(listed.some((row) => row.id === job.id))
  assert.ok(listed.some((row) => row.id === pinned.id && row.model === 'MiniMax-M3'))

  const result = await service.dispatchRun(job.id, 'run-now')
  assert.ok(result.run)
  assert.ok(result.run.sessionId)
  assert.ok(['succeeded', 'running'].includes(result.run.status))
  assert.equal(archived.includes(result.run.sessionId), true, 'archive helper must be invoked')

  const history = await service.listHistory(job.id)
  assert.ok(history.length >= 1)
  const row = history.find((item) => item.id === result.run.id)
  assert.ok(row)
  assert.equal(row.sessionId, result.run.sessionId)
  assert.ok(row.status)

  const state = await service.snapshot()
  const visible = workspaceVisibleIds(
    [row.sessionId, 'ordinary-session'],
    state.hiddenSessionIds,
  )
  assert.deepEqual(visible, ['ordinary-session'])
  assert.ok(state.hiddenSessionIds.includes(row.sessionId))
})

test('overlap skip writes a skipped history row instead of a second session', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ops-cron-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  let clock = Date.parse('2026-08-24T01:00:00.000Z')
  let inflight = 0
  const service = createTestHost({
    filePath: join(dir, 'store.json'),
    now: () => clock,
    sessionPort: {
      async createAndPrompt() {
        inflight += 1
        return { sessionId: `live-${inflight}`, status: 'running', summary: 'started' }
      },
      async archiveSession() {},
    },
  })
  const job = await service.createJob({
    name: 'overlap-job',
    prompt: 'do the thing',
    schedule: { kind: 'at', at: '2026-08-24T12:00:00+08:00', timezone: 'Asia/Shanghai' },
  })
  const first = await service.dispatchRun(job.id, 'run-now')
  assert.equal(first.run.status, 'running')
  const second = await service.dispatchRun(job.id, 'run-now')
  assert.equal(second.run.status, 'skipped')
  assert.equal(second.run.reason, 'overlap')
  assert.equal(inflight, 1)
})

test('retriggerJob fires recurring immediately and re-arms consumed oneshot', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ops-cron-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  let clock = Date.parse('2026-09-10T08:00:00.000Z')
  let fires = 0
  const service = createTestHost({
    filePath: join(dir, 'store.json'),
    now: () => clock,
    sessionPort: {
      async createAndPrompt() {
        fires += 1
        return { sessionId: `s-${fires}`, status: 'succeeded', summary: `ok-${fires}` }
      },
      async archiveSession() {},
    },
  })

  const cron = await service.createJob({
    name: 'cron-job',
    prompt: 'loop',
    schedule: { kind: 'cron', expr: '0 9 * * *', timezone: 'UTC' },
  })
  const cronNext = cron.nextRunAt
  assert.equal(cron.retriggerable, true)
  await assert.rejects(
    () => service.retriggerJob(cron.id, { after_minutes: 5 }),
    (err) => err.code === 'INVALID_RETRIGGER',
  )
  const cronHit = await service.retriggerJob(cron.id)
  assert.equal(cronHit.mode, 'immediate')
  assert.equal(cronHit.run.status, 'succeeded')
  assert.equal(cronHit.job.nextRunAt, cronNext)
  assert.equal(fires, 1)

  const waiting = await service.createJob({
    name: 'waiting',
    prompt: 'soon',
    schedule: { kind: 'at', at: new Date(clock + 3600_000).toISOString(), timezone: 'UTC' },
  })
  await assert.rejects(() => service.retriggerJob(waiting.id), (err) => err.code === 'INVALID_RETRIGGER')

  const worker = await service.createJob({
    name: 'worker',
    prompt: 'continue',
    enabled: false,
    cwd: '/tmp/user-workspaces/tester',
    schedule: { kind: 'at', at: new Date(clock + 60_000).toISOString(), timezone: 'UTC' },
  }, { empNo: 'tester', displayName: 'Tester', permissions: { canViewAllSessions: false } })
  // Force consume: run-now while enabling via update, then clear next by settling through schedule fire path.
  await service.pauseJob(worker.id, true)
  const first = await service.dispatchRun(worker.id, 'run-now')
  assert.equal(first.run.status, 'succeeded')
  // Manually mark as consumed oneshot (run-now keeps nextRunAt).
  await service.store.mutate((state) => {
    const job = state.jobs.find((row) => row.id === worker.id)
    return {
      ...state,
      jobs: state.jobs.map((row) => (row.id === worker.id
        ? { ...job, nextRunAt: null, lastStatus: 'succeeded', enabled: false }
        : row)),
    }
  })
  const listed = await service.listJobs()
  const view = listed.find((row) => row.id === worker.id)
  assert.equal(view.retriggerable, true)
  assert.equal(view.enabled, false)

  const delayed = await service.retriggerJob(worker.id, { after_minutes: 5 })
  assert.equal(delayed.mode, 'scheduled')
  assert.equal(delayed.job.enabled, true)
  assert.ok(delayed.nextRunAt > clock)
  assert.equal(delayed.job.retriggerable, false)

  // Consume again then immediate retrigger.
  await service.store.mutate((state) => ({
    ...state,
    jobs: state.jobs.map((row) => (row.id === worker.id
      ? { ...row, nextRunAt: null, lastStatus: 'succeeded' }
      : row)),
  }))
  const again = await service.retriggerJob(worker.id)
  assert.equal(again.mode, 'immediate')
  assert.ok(again.run)
  assert.equal(again.run.status, 'succeeded')
  assert.equal(fires, 3)

  // In-flight reject
  await service.store.mutate((state) => ({
    ...state,
    jobs: state.jobs.map((row) => (row.id === worker.id
      ? { ...row, nextRunAt: null, lastStatus: 'succeeded' }
      : row)),
    runs: [
      {
        id: 'inflight',
        jobId: worker.id,
        status: 'running',
        scheduledAt: clock,
        actualAt: clock,
        stateEnteredAt: clock,
      },
      ...(state.runs || []),
    ],
  }))
  await assert.rejects(() => service.retriggerJob(worker.id), (err) => err.code === 'ALREADY_RUNNING')

  const http = await listen(service)
  t.after(() => http.close())
  await service.store.mutate((state) => ({
    ...state,
    runs: (state.runs || []).filter((run) => run.id !== 'inflight'),
    jobs: state.jobs.map((row) => (row.id === worker.id
      ? { ...row, nextRunAt: null, lastStatus: 'succeeded', enabled: true }
      : row)),
  }))
  const httpHit = await jsonRequest(http.url, `/dsh-ops-cron/jobs/${worker.id}/retrigger`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
  assert.equal(httpHit.status, 200)
  assert.equal(httpHit.body.mode, 'immediate')
  assert.ok(httpHit.body.run?.id)
})

test('http api: anonymous list/run-now is rejected', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ops-cron-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const service = createTestHost({
    filePath: join(dir, 'store.json'),
    now: () => Date.parse('2026-08-24T01:00:00.000Z'),
    sessionPort: {
      async createAndPrompt() { return { sessionId: 'x', status: 'succeeded', summary: 'ok' } },
      async archiveSession() {},
    },
  })
  await service.createJob({
    name: 'secret job',
    prompt: 'do not leak',
    schedule: { kind: 'cron', expr: '0 9 * * *', timezone: 'UTC' },
  }, { empNo: 'tester', displayName: 'Tester', permissions: { canViewAllSessions: false } })
  const http = await listen(service)
  t.after(() => http.close())
  const listed = await jsonRequest(http.url, '/dsh-ops-cron/jobs', { anonymous: true })
  assert.equal(listed.status, 401)
  assert.equal(listed.body.error, 'login_required')
  const jobs = await jsonRequest(http.url, '/dsh-ops-cron/jobs')
  assert.equal(jobs.status, 200)
  assert.equal(jobs.body.jobs.length, 1)
  const jobId = jobs.body.jobs[0].id
  const ran = await jsonRequest(http.url, `/dsh-ops-cron/jobs/${jobId}/run`, {
    method: 'POST',
    anonymous: true,
  })
  assert.equal(ran.status, 401)
})

test('shipped HTTP handler: create, list, run-now, history', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ops-cron-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const archived = []
  const service = createTestHost({
    filePath: join(dir, 'store.json'),
    now: () => Date.parse('2026-08-24T01:00:00.000Z'),
    sessionPort: {
      async createAndPrompt() {
        return { sessionId: 'http-sess-1', status: 'succeeded', summary: 'via http' }
      },
      async archiveSession(sessionId) {
        archived.push(sessionId)
      },
    },
  })
  const http = await listen(service)
  t.after(() => http.close())

  const created = await jsonRequest(http.url, '/dsh-ops-cron/jobs', {
    method: 'POST',
    body: JSON.stringify({
      name: 'http job',
      prompt: 'ping',
      schedule: { kind: 'cron', expr: '0 9 * * *', timezone: 'Asia/Shanghai' },
    }),
  })
  assert.equal(created.status, 200)
  assert.equal(created.body.job.name, 'http job')
  const jobId = created.body.job.id

  const listed = await jsonRequest(http.url, '/dsh-ops-cron/jobs')
  assert.equal(listed.body.jobs.length, 1)

  const ran = await jsonRequest(http.url, `/dsh-ops-cron/jobs/${jobId}/run`, { method: 'POST' })
  assert.equal(ran.status, 200)
  assert.equal(ran.body.run.sessionId, 'http-sess-1')
  assert.ok(['succeeded', 'running'].includes(ran.body.run.status))
  assert.deepEqual(archived, ['http-sess-1'])

  const history = await jsonRequest(http.url, '/dsh-ops-cron/history')
  assert.ok(history.body.runs.some((row) => row.sessionId === 'http-sess-1'))
  const visible = await jsonRequest(http.url, '/dsh-ops-cron/workspace-visible?id=http-sess-1&id=other')
  assert.deepEqual(visible.body.visible, ['other'])
})

test('createJob ignores client-supplied id to prevent overwrite', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ops-cron-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const service = createTestHost({
    filePath: join(dir, 'store.json'),
    now: () => Date.parse('2026-08-24T01:00:00.000Z'),
  })
  const first = await service.createJob({
    name: 'keep-me',
    prompt: 'first',
    schedule: { kind: 'cron', expr: '0 9 * * *', timezone: 'Asia/Shanghai' },
  })
  const second = await service.createJob({
    id: first.id,
    name: 'attacker',
    prompt: 'overwrite?',
    schedule: { kind: 'cron', expr: '0 10 * * *', timezone: 'Asia/Shanghai' },
  })
  assert.notEqual(second.id, first.id)
  const listed = await service.listJobs()
  assert.equal(listed.find((job) => job.id === first.id)?.name, 'keep-me')
  assert.equal(listed.find((job) => job.id === second.id)?.name, 'attacker')
})

test('POST /runs/:id/open reveals the run session id', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ops-cron-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const revealed = []
  const service = createTestHost({
    filePath: join(dir, 'store.json'),
    now: () => Date.parse('2026-08-24T01:00:00.000Z'),
    sessionPort: {
      async createAndPrompt() {
        return { sessionId: 'open-sess', status: 'succeeded', summary: 'ok' }
      },
      async revealSession(sessionId) { revealed.push(sessionId) },
    },
  })
  const http = await listen(service)
  t.after(() => http.close())
  const created = await jsonRequest(http.url, '/dsh-ops-cron/jobs', {
    method: 'POST',
    body: JSON.stringify({
      name: 'open-job',
      prompt: 'ping',
      schedule: { kind: 'cron', expr: '0 9 * * *', timezone: 'Asia/Shanghai' },
    }),
  })
  const ran = await jsonRequest(http.url, `/dsh-ops-cron/jobs/${created.body.job.id}/run`, { method: 'POST' })
  const opened = await jsonRequest(http.url, `/dsh-ops-cron/runs/${ran.body.run.id}/open`, { method: 'POST' })
  assert.equal(opened.status, 200)
  assert.equal(opened.body.sessionId, 'open-sess')
  assert.deepEqual(revealed, ['open-sess'])
})

test('bindModelSelection fills {{model}} for persona assembly', async () => {
  let assemble
  const agentCtx = {
    on(event, listener) {
      if (event === 'system-prompt/assemble') assemble = listener
      return () => {}
    },
  }
  bindModelSelection(agentCtx, { provider: 'minimax', model: 'MiniMax-M2.5' })
  const assembled = await assemble({ variables: { cwd: '/tmp' } }, {}, async () => ({ variables: { cwd: '/tmp', model: undefined } }))
  assert.equal(assembled.variables.model, 'MiniMax-M2.5')
  assert.equal(assembled.variables.provider, 'minimax')
})

test('makeLiveSessionPort creates with default model and setup', async () => {
  const created = []
  let assemble
  const ctx = {
    get(name) {
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
      }
      if (name === 'agents') {
        return {
          async create(options) {
            created.push(options)
            const agent = createFakeAgent()
            await options.setup?.({
              on(event, listener) {
                if (event === 'system-prompt/assemble') assemble = listener
                return () => {}
              },
            })
            return { agent, dispose: async () => {} }
          },
          get() {},
        }
      }
      return undefined
    },
  }
  const port = makeLiveSessionPort(ctx)
  const result = await port.createAndPrompt({
    job: { name: 'model-job', timeoutMinutes: 1 },
    run: {},
    text: 'hi',
  })
  assert.ok(result.sessionId)
  assert.equal(created[0].agentOptions.model, 'deepseek-chat')
  assert.equal(created[0].agentOptions.provider, 'deepseek')
  const assembled = await assemble({ variables: {} }, {}, async () => ({ variables: { model: undefined } }))
  assert.equal(assembled.variables.model, 'deepseek-chat')
})

test('resolveDefaultModel fails loud when Models has no selection', async () => {
  await assert.rejects(
    () => resolveDefaultModel({ get: () => undefined }, { waitMs: 0 }),
    /no default model/,
  )
})

test('POST /conceal archives every run session id', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ops-cron-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const archived = []
  const service = createTestHost({
    filePath: join(dir, 'store.json'),
    now: () => Date.parse('2026-08-24T01:00:00.000Z'),
    sessionPort: {
      async createAndPrompt() {
        return { sessionId: 'hide-sess', status: 'succeeded', summary: 'ok' }
      },
      async archiveSession(sessionId) { archived.push(sessionId) },
    },
  })
  const http = await listen(service)
  t.after(() => http.close())
  const created = await jsonRequest(http.url, '/dsh-ops-cron/jobs', {
    method: 'POST',
    body: JSON.stringify({
      name: 'hide-job',
      prompt: 'ping',
      schedule: { kind: 'cron', expr: '0 9 * * *', timezone: 'Asia/Shanghai' },
    }),
  })
  await jsonRequest(http.url, `/dsh-ops-cron/jobs/${created.body.job.id}/run`, { method: 'POST' })
  archived.length = 0
  const hidden = await jsonRequest(http.url, '/dsh-ops-cron/conceal', { method: 'POST' })
  assert.equal(hidden.status, 200)
  assert.ok(archived.includes('hide-sess'))
})

test('one-shot at job fires once then later ticks wait instead of retriggering', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ops-cron-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const at = Date.parse('2026-08-23T14:57:00.000Z')
  let clock = at - 60_000
  let sessions = 0
  const service = createTestHost({
    filePath: join(dir, 'store.json'),
    now: () => clock,
    sessionPort: {
      async createAndPrompt() {
        sessions += 1
        return { sessionId: `at-sess-${sessions}`, status: 'succeeded', summary: 'once' }
      },
    },
  })
  const job = await service.createJob({
    name: 'once-at',
    prompt: 'ping',
    schedule: { kind: 'at', at: '2026-08-23T22:57:00', timezone: 'Asia/Shanghai' },
  })
  assert.equal(job.nextRunAt, at)
  clock = at + 1000
  const first = await service.dispatchRun(job.id, 'schedule')
  assert.equal(first.run.status, 'succeeded')
  assert.equal(sessions, 1)
  clock = at + 15_000
  const second = await service.dispatchRun(job.id, 'schedule')
  assert.equal(second.run, null)
  assert.equal(sessions, 1)
  clock = at + 5 * 60_000
  const third = await service.tick()
  assert.equal(third.length, 0)
  assert.equal(sessions, 1)
  const history = await service.listHistory(job.id)
  const misfires = history.filter((row) => row.reason === 'misfire')
  assert.equal(misfires.length, 0)
})

test('unarchiveSession drops the id from archivedSessionIds', async () => {
  const state = { workspaceIds: ['w'], archivedSessionIds: ['s1', 's2'], initialized: true }
  const ctx = {
    get(name) {
      if (name !== 'workspaceRegistry') return undefined
      return {
        enqueueOperation: async (fn) => fn(),
        requireState: () => state,
        async setState(next) {
          state.workspaceIds = next.workspaceIds
          state.archivedSessionIds = next.archivedSessionIds
          state.initialized = next.initialized
        },
      }
    },
  }
  const ok = await unarchiveSession(ctx, 's1')
  assert.equal(ok, true)
  assert.deepEqual(state.archivedSessionIds, ['s2'])
})

test('resolveSessionPlacement uses recent workspace path when job cwd is empty', () => {
  const recent = { id: 'ws-recent', path: '/tmp/ws-app', async attachSession() {} }
  const ctx = {
    get(name) {
      if (name === 'workspaceRegistry') return { list: () => [recent] }
      return undefined
    },
  }
  const placed = resolveSessionPlacement(ctx, { cwd: '' })
  assert.equal(placed.cwd, '/tmp/ws-app')
  assert.equal(placed.workspace, recent)
  const explicit = resolveSessionPlacement(ctx, { cwd: '/tmp/isolated' })
  assert.equal(explicit.cwd, '/tmp/isolated')
  assert.equal(explicit.workspace, null)
})

test('resolveSessionPlacement keeps foreign cwd for super_admin owner under strict path ACL', () => {
  const recent = { id: 'ws-recent', path: '/tmp/ws-app', async attachSession() {} }
  const ctx = {
    get(name) {
      if (name === 'workspaceRegistry') return { list: () => [recent] }
      return undefined
    },
  }
  const uds = mockUdsAuth({ strictPath: true })
  const kept = resolveSessionPlacement(ctx, {
    cwd: 'D:/code/gpt',
    ownerEmpNo: '10329667',
  }, { udsAuth: uds })
  assert.equal(kept.cwd, 'D:/code/gpt')

  const clamped = resolveSessionPlacement(ctx, {
    cwd: '/tmp/user-workspaces/peer/x',
    ownerEmpNo: 'tester',
  }, { udsAuth: uds })
  assert.equal(clamped.cwd, '/tmp/user-workspaces/tester')

  const external = resolveSessionPlacement(ctx, {
    cwd: 'D:/code/gpt',
    ownerEmpNo: 'tester',
  }, { udsAuth: uds })
  assert.equal(external.cwd, 'D:/code/gpt')
})

test('resolveSessionPlacement prefers owner provisioned path over recent workspace when cwd empty', () => {
  const recent = { id: 'ws-recent', path: '/tmp/wrong-recent', async attachSession() {} }
  const ctx = {
    get(name) {
      if (name === 'workspaceRegistry') return { list: () => [recent] }
      return undefined
    },
  }
  const uds = mockUdsAuth({ strictPath: true })
  const placed = resolveSessionPlacement(ctx, {
    cwd: '',
    ownerEmpNo: '10329667',
  }, { udsAuth: uds })
  assert.equal(placed.cwd, '/tmp/deepseek-harness/10329667')
})

test('super_admin createJob keeps explicit foreign cwd; normal user is clamped', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ops-cron-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const service = createTestHost({
    filePath: join(dir, 'store.json'),
    now: () => Date.parse('2026-08-24T01:00:00.000Z'),
    udsAuthOptions: { strictPath: true },
    sessionPort: {
      async createAndPrompt() {
        return { sessionId: 's1', status: 'succeeded', summary: 'ok' }
      },
      async archiveSession() {},
    },
  })
  const superId = {
    empNo: '10329667',
    role: 'super_admin',
    displayName: 'Super',
    permissions: { canViewAllSessions: true, canCreateWorkspace: true },
    workspacePath: '/tmp/deepseek-harness/10329667',
  }
  const superJob = await service.createJob({
    name: 'gpt-job',
    prompt: 'work in gpt',
    cwd: 'D:/code/gpt',
    schedule: { kind: 'cron', expr: '0 2 * * *', timezone: 'Asia/Shanghai' },
  }, superId)
  assert.equal(superJob.cwd, 'D:/code/gpt')
  assert.equal(superJob.ownerEmpNo, '10329667')

  const userId = {
    empNo: 'tester',
    role: 'user',
    displayName: 'Tester',
    permissions: { canViewAllSessions: false },
    workspacePath: '/tmp/user-workspaces/tester',
  }
  const userJob = await service.createJob({
    name: 'user-job',
    prompt: 'try foreign',
    cwd: 'D:/code/gpt',
    schedule: { kind: 'cron', expr: '0 3 * * *', timezone: 'Asia/Shanghai' },
  }, userId)
  // Shared tree outside provision forest is kept (allowExternalCwd default).
  assert.equal(userJob.cwd, 'D:/code/gpt')

  await assert.rejects(
    () => service.createJob({
      name: 'steal',
      prompt: 'no',
      cwd: '/tmp/user-workspaces/peer/secret',
      schedule: { kind: 'cron', expr: '0 4 * * *', timezone: 'Asia/Shanghai' },
    }, userId),
    (err) => err && err.code === 'CWD_FORBIDDEN',
  )
})

test('createJob elevates via live resolveIdentityForEmpNo when caller permissions are empty', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ops-cron-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const service = createTestHost({
    filePath: join(dir, 'store.json'),
    now: () => Date.parse('2026-08-24T01:00:00.000Z'),
    udsAuthOptions: { strictPath: true },
    sessionPort: {
      async createAndPrompt() {
        return { sessionId: 's1', status: 'succeeded', summary: 'ok' }
      },
      async archiveSession() {},
    },
  })
  // Stale tool identity: empNo only, wrong role flag — must re-resolve from uds-auth.
  const stale = {
    empNo: '10329667',
    role: 'user',
    displayName: '10329667',
    permissions: { canViewAllSessions: false },
    workspacePath: '/tmp/deepseek-harness/10329667',
  }
  const job = await service.createJob({
    name: 'gpt-via-live',
    prompt: 'work in gpt',
    cwd: 'D:/code/gpt',
    schedule: { kind: 'at', at: '2026-08-24T02:00:00.000Z', timezone: 'UTC' },
  }, stale)
  assert.equal(job.cwd, 'D:/code/gpt')
})

test('createJob keeps foreign cwd when only role is stamped super_admin', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ops-cron-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const service = createTestHost({
    filePath: join(dir, 'store.json'),
    now: () => Date.parse('2026-08-24T01:00:00.000Z'),
    udsAuth: {
      getProvisionedWorkspacePath(empNo) {
        return empNo === '10329667'
          ? '/tmp/deepseek-harness/10329667'
          : `/tmp/user-workspaces/${empNo}`
      },
      isUserPath(empNo, candidatePath) {
        const root = this.getProvisionedWorkspacePath(empNo)
        const cand = String(candidatePath || '').replace(/\\/g, '/')
        const normRoot = String(root).replace(/\\/g, '/')
        return cand === normRoot || cand.startsWith(`${normRoot}/`)
      },
    },
    sessionPort: {
      async createAndPrompt() {
        return { sessionId: 's1', status: 'succeeded', summary: 'ok' }
      },
    },
  })
  const job = await service.createJob({
    name: 'role-only',
    prompt: 'p',
    cwd: 'D:/code/gpt',
    schedule: { kind: 'at', at: '2026-08-24T02:00:00.000Z', timezone: 'UTC' },
  }, {
    empNo: '10329667',
    role: 'super_admin',
    permissions: {},
  })
  assert.equal(job.cwd, 'D:/code/gpt')
})

test('live fire uses super_admin job cwd outside provisioned tree', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ops-cron-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const seen = []
  const uds = mockUdsAuth({ strictPath: true })
  const service = createHostService({
    filePath: join(dir, 'store.json'),
    now: () => Date.parse('2026-08-24T01:00:00.000Z'),
    getUdsAuth: () => uds,
    sessionPort: {
      async createAndPrompt({ job }) {
        const placement = resolveSessionPlacement({
          get() { return { list: () => [] } },
        }, job, { udsAuth: uds })
        seen.push(placement.cwd)
        return { sessionId: `run-${seen.length}`, status: 'succeeded', summary: 'ok' }
      },
      async archiveSession() {},
    },
  })
  const job = await service.createJob({
    name: 'fire-gpt',
    prompt: 'ping',
    cwd: 'D:/code/gpt',
    schedule: { kind: 'at', at: '2099-01-01T00:00:00.000Z', timezone: 'UTC' },
  }, {
    empNo: '10329667',
    role: 'super_admin',
    permissions: { canViewAllSessions: true, canCreateWorkspace: true },
  })
  assert.equal(job.cwd, 'D:/code/gpt')
  await service.dispatchRun(job.id, 'run-now')
  assert.deepEqual(seen, ['D:/code/gpt'])
})

test('IM peer create keeps bot cwd unassigned and rejects empty cwd', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ops-cron-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const service = createTestHost({
    filePath: join(dir, 'store.json'),
    now: () => Date.parse('2026-08-24T01:00:00.000Z'),
    udsAuthOptions: { strictPath: true },
    sessionPort: {
      async createAndPrompt() {
        return { sessionId: 's-im', status: 'succeeded', summary: 'ok' }
      },
      async archiveSession() {},
    },
  })
  const job = await service.createJob({
    name: 'im-job',
    prompt: 'from channel',
    cwd: '/data/bot-workspace/wa',
    delivery: { kind: 'im', botId: 'bot-a', targetId: 'auto-dm' },
    origin: {
      kind: 'im',
      sessionId: 'sess-im',
      peer: { botId: 'bot-a', conversationKey: 'direct:1@s.whatsapp.net', conversationId: '1@s.whatsapp.net' },
    },
    schedule: { kind: 'at', at: '2099-01-01T00:00:00.000Z', timezone: 'UTC' },
  }, {
    empNo: '10329667',
    permissions: { canViewAllSessions: true },
  }, { fromImPeer: true })
  assert.equal(job.ownerEmpNo, '__unassigned__')
  assert.equal(job.cwd, '/data/bot-workspace/wa')
  assert.equal(job.origin.kind, 'im')

  await assert.rejects(
    () => service.createJob({
      name: 'im-empty',
      prompt: 'x',
      cwd: '',
      origin: {
        kind: 'im',
        sessionId: 'sess-im',
        peer: { botId: 'bot-a', conversationKey: 'direct:1@s.whatsapp.net' },
      },
      schedule: { kind: 'at', at: '2099-01-01T00:00:00.000Z', timezone: 'UTC' },
    }, null, { fromImPeer: true }),
    (error) => error.code === 'INVALID_CWD',
  )
})

test('HTTP web create strips forged IM origin and rejects IM delivery for normal users', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ops-cron-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const service = createTestHost({
    filePath: join(dir, 'store.json'),
    now: () => Date.parse('2026-08-24T01:00:00.000Z'),
    sessionPort: {
      async createAndPrompt() {
        return { sessionId: 's', status: 'succeeded', summary: 'ok' }
      },
      async archiveSession() {},
    },
  })
  const { url, close } = await listen(service)
  t.after(close)

  const forged = await jsonRequest(url, '/dsh-ops-cron/jobs', {
    empNo: 'tester',
    method: 'POST',
    body: JSON.stringify({
      name: 'forge',
      prompt: 'x',
      schedule: { kind: 'at', at: '2099-01-01T00:00:00.000Z', timezone: 'UTC' },
      cwd: '/tmp/user-workspaces/tester',
      origin: {
        kind: 'im',
        sessionId: 'sess-1',
        peer: { botId: 'bot-a', conversationKey: 'direct:x' },
      },
    }),
  })
  assert.equal(forged.status, 200)
  assert.equal(forged.body.job.ownerEmpNo, 'tester')
  assert.equal(forged.body.job.origin?.kind, 'web')

  const denied = await jsonRequest(url, '/dsh-ops-cron/jobs', {
    empNo: 'tester',
    method: 'POST',
    body: JSON.stringify({
      name: 'im-web',
      prompt: 'x',
      schedule: { kind: 'at', at: '2099-01-01T00:00:00.000Z', timezone: 'UTC' },
      delivery: { kind: 'im', botId: 'bot-a', targetId: 't1' },
    }),
  })
  assert.equal(denied.status, 400)
  assert.equal(denied.body.code, 'IM_DELIVERY_FORBIDDEN')
})

test('resolveSessionPlacement refuses recent-workspace fallback for IM jobs without cwd', () => {
  const recent = { id: 'ws-recent', path: '/tmp/wrong-recent', async attachSession() {} }
  const ctx = {
    get(name) {
      if (name === 'workspaceRegistry') return { list: () => [recent] }
      return undefined
    },
  }
  const placed = resolveSessionPlacement(ctx, {
    cwd: '',
    ownerEmpNo: '__unassigned__',
    origin: {
      kind: 'im',
      peer: { botId: 'bot-a', conversationKey: 'direct:1' },
    },
  })
  assert.equal(placed.missingCwd, true)
  assert.equal(placed.cwd, '')
})

test('adoptSessionIntoWorkspace attaches a fork whose cwd matches a workspace', async () => {
  const attached = []
  const workspace = {
    id: 'ws-1',
    path: '/tmp/ws-app',
    async attachSession(sessionId) { attached.push(sessionId) },
  }
  const ctx = {
    get(name) {
      if (name === 'workspaceRegistry') {
        return {
          list: () => [workspace],
          async enqueueOperation(fn) { await fn() },
          requireState: () => ({ archivedSessionIds: ['child-1'] }),
          async setState() {},
        }
      }
      if (name === 'sessions') {
        return { get: () => ({ header: { cwd: '/tmp/ws-app' } }) }
      }
      return undefined
    },
  }
  const result = await adoptSessionIntoWorkspace(ctx, 'child-1')
  assert.equal(result.attached, true)
  assert.deepEqual(attached, ['child-1'])
})

test('resolveJobModel prefers a pinned job model over the New Session default', async () => {
  const ctx = {
    get(name) {
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
      }
      return undefined
    },
  }
  const pinned = await resolveJobModel(ctx, { provider: 'minimax-cn', model: 'MiniMax-M3' })
  assert.deepEqual(pinned, { provider: 'minimax-cn', model: 'MiniMax-M3' })
  const fallback = await resolveJobModel(ctx, { provider: '', model: '' })
  assert.equal(fallback.provider, 'deepseek')
  assert.equal(fallback.model, 'deepseek-chat')
})

test('listModelChoices maps llm providers and the current default', async () => {
  const ctx = {
    get(name) {
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
      }
      if (name === 'llm') {
        return {
          listProviders: () => [{ id: 'minimax-cn', name: 'MiniMax' }],
          async listModels(provider) {
            assert.equal(provider, 'minimax-cn')
            return [{ id: 'MiniMax-M3', name: 'M3', provider }]
          },
        }
      }
      return undefined
    },
  }
  const catalog = await listModelChoices(ctx)
  assert.equal(catalog.current.model, 'deepseek-chat')
  assert.deepEqual(catalog.groups, [{
    provider: 'minimax-cn',
    displayName: 'MiniMax',
    models: [{ id: 'MiniMax-M3', name: 'M3' }],
  }])
})

test('GET /models lists session-port catalog', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ops-cron-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const service = createTestHost({
    filePath: join(dir, 'store.json'),
    sessionPort: {
      async listModels() {
        return { groups: [{ provider: 'deepseek', displayName: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'Chat' }] }], current: { provider: 'deepseek', model: 'deepseek-chat' } }
      },
    },
  })
  const http = await listen(service)
  t.after(() => http.close())
  const res = await jsonRequest(http.url, '/dsh-ops-cron/models')
  assert.equal(res.status, 200)
  assert.equal(res.body.current.model, 'deepseek-chat')
  assert.equal(res.body.groups[0].models[0].id, 'deepseek-chat')
})

test('listWorkspaceChoices maps registry entries to title and path', () => {
  const ctx = {
    get(name) {
      if (name === 'workspaceRegistry') {
        return {
          list: () => [
            { id: 'ws-1', title: 'dsh-test', path: '/tmp/ws-dsh-test' },
            { id: 'ws-2', path: '/tmp/ws-other' },
          ],
        }
      }
      return undefined
    },
  }
  assert.deepEqual(listWorkspaceChoices(ctx), [
    { id: 'ws-1', title: 'dsh-test', path: '/tmp/ws-dsh-test' },
    { id: 'ws-2', title: 'ws-other', path: '/tmp/ws-other' },
  ])
})

test('GET /workspaces lists session-port choices', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ops-cron-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const service = createTestHost({
    filePath: join(dir, 'store.json'),
    sessionPort: {
      async listWorkspaces() {
        return [{ id: 'ws-1', title: 'app', path: '/tmp/app' }]
      },
    },
  })
  const http = await listen(service)
  t.after(() => http.close())
  const res = await jsonRequest(http.url, '/dsh-ops-cron/workspaces')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.workspaces, [{ id: 'ws-1', title: 'app', path: '/tmp/app' }])
})

test('POST /sessions/:id/adopt uses the session port', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ops-cron-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const adopted = []
  const service = createTestHost({
    filePath: join(dir, 'store.json'),
    sessionPort: {
      async adoptSession(sessionId) {
        adopted.push(sessionId)
        return { attached: true, workspaceId: 'ws-1', cwd: '/tmp/app' }
      },
    },
  })
  const http = await listen(service)
  t.after(() => http.close())
  const res = await jsonRequest(http.url, '/dsh-ops-cron/sessions/child-9/adopt', { method: 'POST' })
  assert.equal(res.status, 200)
  assert.equal(res.body.attached, true)
  assert.deepEqual(adopted, ['child-9'])
})

test('waitForAgentTurn waits for running then idle, and fails if the agent never starts', async () => {
  const agent = createFakeAgent()
  agent.followup()
  const finished = await waitForAgentTurn(agent, { startTimeoutMs: 500, turnTimeoutMs: 500 })
  assert.equal(finished.status, 'succeeded')

  const idle = { status: 'idle', whenIdle: async () => {} }
  const missed = await waitForAgentTurn(idle, { startTimeoutMs: 50, turnTimeoutMs: 50 })
  assert.equal(missed.status, 'failed')
  assert.equal(missed.error, 'agent_never_started')
})

test('after one live-shaped dispatch, the next run-now still fires', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ops-cron-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const archived = []
  const sessionPort = makeLiveSessionPort(fakeLiveCtx(archived))
  const service = createTestHost({
    filePath: join(dir, 'store.json'),
    now: () => Date.parse('2026-08-24T01:00:00.000Z'),
    sessionPort,
  })

  const job = await service.createJob({
    name: 'live-shape',
    prompt: 'do the live-shaped thing',
    schedule: { kind: 'cron', expr: '0 9 * * 1-5', timezone: 'Asia/Shanghai' },
  })
  const first = await service.dispatchRun(job.id, 'run-now')
  assert.ok(first.run.sessionId)
  assert.equal(first.run.status, 'succeeded')
  assert.equal(first.run.summary, '测试成功')

  const second = await service.dispatchRun(job.id, 'run-now')
  assert.ok(second.run)
  assert.notEqual(second.run.status, 'skipped')
  assert.equal(second.run.status, 'succeeded')
  assert.ok(second.run.sessionId)
  assert.notEqual(second.run.sessionId, first.run.sessionId)
  assert.equal(second.run.summary, '测试成功')

  const history = await service.listHistory(job.id)
  const terminals = history.filter((row) => row.status === 'succeeded')
  assert.equal(terminals.length, 2)
})

test('after a live-shaped due tick settles, the next due occurrence still fires', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ops-cron-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const archived = []
  let clock = Date.parse('2026-08-24T01:00:00.000Z')
  const sessionPort = makeLiveSessionPort(fakeLiveCtx(archived))
  const service = createTestHost({
    filePath: join(dir, 'store.json'),
    now: () => clock,
    sessionPort,
  })

  const job = await service.createJob({
    name: 'every-minute',
    prompt: 'tick',
    schedule: { kind: 'cron', expr: '* * * * *', timezone: 'UTC' },
  })
  assert.ok(job.nextRunAt > clock)
  clock = job.nextRunAt
  const firstTick = await service.tick()
  assert.equal(firstTick.length, 1)
  assert.equal(firstTick[0].run.status, 'succeeded')

  const afterFirst = (await service.listJobs())[0]
  clock = afterFirst.nextRunAt
  const secondTick = await service.tick()
  assert.equal(secondTick.length, 1)
  assert.equal(secondTick[0].run.status, 'succeeded')
  assert.notEqual(secondTick[0].run.sessionId, firstTick[0].run.sessionId)
  assert.notEqual(secondTick[0].run.status, 'skipped')
})


test('host HTTP: per-user job isolation and super sees all', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ops-cron-acl-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const service = createTestHost({
    filePath: join(dir, 'store.json'),
    now: () => Date.parse('2026-08-24T01:00:00.000Z'),
    sessionPort: {
      async createAndPrompt({ job }) {
        return { sessionId: `sess-${job.id}`, status: 'succeeded', summary: 'ok' }
      },
      async archiveSession() { return true },
    },
  })
  const http = await listen(service)
  t.after(() => http.close())

  const noAuth = await jsonRequest(http.url, '/dsh-ops-cron/jobs', { anonymous: true })
  assert.equal(noAuth.status, 401)

  const createdA = await jsonRequest(http.url, '/dsh-ops-cron/jobs', {
    method: 'POST',
    empNo: 'tester',
    body: JSON.stringify({
      name: 'tester-job',
      prompt: 'do a',
      schedule: { kind: 'at', at: '2099-01-01T00:00:00.000Z', timezone: 'UTC' },
    }),
  })
  assert.equal(createdA.status, 200)
  assert.equal(createdA.body.job.ownerEmpNo, 'tester')
  assert.ok(createdA.body.job.ownerDisplayName)

  const createdB = await jsonRequest(http.url, '/dsh-ops-cron/jobs', {
    method: 'POST',
    empNo: 'peer',
    body: JSON.stringify({
      name: 'peer-job',
      prompt: 'do b',
      schedule: { kind: 'at', at: '2099-01-01T00:00:00.000Z', timezone: 'UTC' },
    }),
  })
  assert.equal(createdB.status, 200)
  assert.equal(createdB.body.job.ownerEmpNo, 'peer')

  const listTester = await jsonRequest(http.url, '/dsh-ops-cron/jobs', { empNo: 'tester' })
  assert.equal(listTester.status, 200)
  assert.equal(listTester.body.jobs.length, 1)
  assert.equal(listTester.body.jobs[0].name, 'tester-job')
  assert.equal(listTester.body.viewer.canViewAll, false)

  const listPeer = await jsonRequest(http.url, '/dsh-ops-cron/jobs', { empNo: 'peer' })
  assert.equal(listPeer.body.jobs.length, 1)
  assert.equal(listPeer.body.jobs[0].name, 'peer-job')

  const forbidden = await jsonRequest(http.url, `/dsh-ops-cron/jobs/${createdB.body.job.id}`, { empNo: 'tester' })
  assert.equal(forbidden.status, 404)

  const listAdmin = await jsonRequest(http.url, '/dsh-ops-cron/jobs', { empNo: 'admin1' })
  assert.equal(listAdmin.status, 200)
  assert.equal(listAdmin.body.viewer.canViewAll, true)
  assert.equal(listAdmin.body.jobs.length, 2)

  const reassigned = await jsonRequest(http.url, `/dsh-ops-cron/jobs/${createdB.body.job.id}`, {
    method: 'PATCH',
    empNo: 'admin1',
    body: JSON.stringify({ ownerEmpNo: 'tester', ownerDisplayName: 'Tester' }),
  })
  assert.equal(reassigned.status, 200)
  assert.equal(reassigned.body.job.ownerEmpNo, 'tester')

  const listTester2 = await jsonRequest(http.url, '/dsh-ops-cron/jobs', { empNo: 'tester' })
  assert.equal(listTester2.body.jobs.length, 2)
})

test('GET /jobs claims unassigned jobs that match viewer cwd', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ops-cron-claim-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const service = createTestHost({
    filePath: join(dir, 'store.json'),
    now: () => Date.parse('2026-08-24T01:00:00.000Z'),
  })
  const mine = await service.createJob({
    name: 'orphan-mine',
    prompt: 'x',
    schedule: { kind: 'at', at: '2099-01-01T00:00:00.000Z', timezone: 'UTC' },
    cwd: '/tmp/plain-a',
  })
  const other = await service.createJob({
    name: 'orphan-other',
    prompt: 'y',
    schedule: { kind: 'at', at: '2099-01-01T00:00:00.000Z', timezone: 'UTC' },
    cwd: '/tmp/plain-b',
  })
  // Simulate legacy rows: unassigned but cwd clearly under the viewer's workspace.
  await service.store.mutate((current) => ({
    ...current,
    jobs: current.jobs.map((job) => {
      if (job.id === mine.id) {
        return {
          ...job,
          ownerEmpNo: '__unassigned__',
          ownerDisplayName: '',
          cwd: '/tmp/user-workspaces/tester/ws',
        }
      }
      if (job.id === other.id) {
        return {
          ...job,
          ownerEmpNo: '__unassigned__',
          ownerDisplayName: '',
          cwd: '/tmp/user-workspaces/peer/ws',
        }
      }
      return job
    }),
  }))
  const http = await listen(service)
  t.after(() => http.close())
  const listed = await jsonRequest(http.url, '/dsh-ops-cron/jobs', { empNo: 'tester' })
  assert.equal(listed.status, 200)
  assert.equal(listed.body.jobs.length, 1)
  assert.equal(listed.body.jobs[0].name, 'orphan-mine')
  assert.equal(listed.body.jobs[0].ownerEmpNo, 'tester')
})


test('HTTP works standalone without uds-auth (local mode)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ops-cron-local-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const service = createHostService({
    filePath: join(dir, 'store.json'),
    now: () => Date.parse('2026-08-24T01:00:00.000Z'),
    sessionPort: {
      async createAndPrompt() {
        return { sessionId: 'local-sess', status: 'succeeded', summary: 'ok' }
      },
      async archiveSession() {},
    },
    getUdsAuth: () => undefined,
  })
  const http = await listen(service)
  t.after(() => http.close())

  const created = await jsonRequest(http.url, '/dsh-ops-cron/jobs', {
    method: 'POST',
    body: JSON.stringify({
      name: 'local job',
      prompt: 'ping',
      schedule: { kind: 'cron', expr: '0 9 * * *', timezone: 'UTC' },
    }),
  })
  assert.equal(created.status, 200)
  assert.equal(created.body.job.name, 'local job')
  assert.ok(!created.body.job.ownerEmpNo || created.body.job.ownerEmpNo === '__unassigned__')

  const listed = await jsonRequest(http.url, '/dsh-ops-cron/jobs')
  assert.equal(listed.status, 200)
  assert.equal(listed.body.viewer.mode, 'local')
  assert.equal(listed.body.viewer.canViewAll, true)
  assert.equal(listed.body.jobs.length, 1)

  const ran = await jsonRequest(http.url, `/dsh-ops-cron/jobs/${created.body.job.id}/run`, { method: 'POST' })
  assert.equal(ran.status, 200)
  assert.equal(ran.body.run.sessionId, 'local-sess')
})

test('migrateJobOwners assigns unassigned for legacy jobs', async () => {
  const { migrateJobOwners, UNASSIGNED_OWNER } = await import('../lib/ownership.js')
  const state = {
    jobs: [
      { id: '1', name: 'a', origin: { kind: 'im', peer: { botId: 'b' } } },
      { id: '2', name: 'b', origin: { kind: 'web', sessionId: 's1' } },
      { id: '3', name: 'c', ownerEmpNo: 'u1' },
    ],
  }
  const { state: next, changed } = migrateJobOwners(state, {
    getSessionOwner: (id) => (id === 's1' ? 'from-session' : null),
  })
  assert.equal(changed, true)
  assert.equal(next.jobs[0].ownerEmpNo, UNASSIGNED_OWNER)
  assert.equal(next.jobs[1].ownerEmpNo, 'from-session')
  assert.equal(next.jobs[2].ownerEmpNo, 'u1')
})

test('session mirror is off by default and runs only when mirrorToSession is true', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ops-cron-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const appended = []
  const agents = {
    get(sessionId) {
      if (sessionId !== 'origin-web') return null
      return {
        session: {
          append(...args) { appended.push(args) },
        },
      }
    },
  }
  const service = createTestHost({
    filePath: join(dir, 'store.json'),
    now: () => Date.parse('2026-08-24T01:00:00.000Z'),
    getAgents: () => agents,
    sessionPort: {
      async createAndPrompt({ job }) {
        return { sessionId: `run-${job.id}`, status: 'succeeded', summary: `done ${job.name}` }
      },
      async archiveSession() {},
    },
  })

  const off = await service.createJob({
    name: 'no-mirror',
    prompt: 'p',
    schedule: { kind: 'at', at: '2099-01-01T00:00:00.000Z', timezone: 'UTC' },
    origin: { kind: 'web', sessionId: 'origin-web' },
  })
  assert.equal(off.mirrorToSession, false)
  await service.dispatchRun(off.id, 'run-now')
  assert.equal(appended.length, 0)

  const on = await service.createJob({
    name: 'with-mirror',
    prompt: 'p',
    schedule: { kind: 'at', at: '2099-01-02T00:00:00.000Z', timezone: 'UTC' },
    origin: { kind: 'web', sessionId: 'origin-web' },
    mirrorToSession: true,
  })
  assert.equal(on.mirrorToSession, true)
  await service.dispatchRun(on.id, 'run-now')
  assert.equal(appended.length, 1)
  assert.match(appended[0][1].content[0].text, /with-mirror/)

  const patched = await service.updateJob(off.id, { mirrorToSession: true })
  assert.equal(patched.mirrorToSession, true)
  await service.dispatchRun(off.id, 'run-now')
  assert.equal(appended.length, 2)
})
