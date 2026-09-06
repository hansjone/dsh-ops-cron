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
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      accept: 'application/json',
      origin: base,
      host: new URL(base).host,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  const body = await response.json()
  return { status: response.status, body }
}

test('host service: create, list, run-now, history, and workspace isolation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ops-cron-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const archived = []
  let clock = Date.parse('2026-08-24T01:00:00.000Z')
  let sessionSeq = 0
  const service = createHostService({
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
  const service = createHostService({
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

test('shipped HTTP handler: create, list, run-now, history', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ops-cron-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const archived = []
  const service = createHostService({
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
  const service = createHostService({
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
  const service = createHostService({
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
  const service = createHostService({
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
  const service = createHostService({
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
  const service = createHostService({
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
  const service = createHostService({
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
  const service = createHostService({
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
  const service = createHostService({
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
  const service = createHostService({
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
