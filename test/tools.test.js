import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHostService } from '../lib/host.js'
import { callerWorkingDirectory, cronToolDefinitions, registerCronGuidance, registerCronTools, resolveCreateCwd, resolveCreateModel, resolveToolIdentity, scheduleFromArgs } from '../lib/tools.js'

async function makeService(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cron-tools-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return createHostService({
    filePath: join(dir, 'store.json'),
    now: () => Date.parse('2026-08-24T01:00:00.000Z'),
    sessionPort: {
      async createAndPrompt() {
        return { sessionId: 'tool-sess', status: 'succeeded', summary: 'ok' }
      },
    },
  })
}

function byName(defs) {
  return Object.fromEntries(defs.map((row) => [row.name, row]))
}

test('cron_create then cron_list round-trip, pause and delete', async (t) => {
  const service = await makeService(t)
  const tools = byName(cronToolDefinitions(service))
  const created = await tools.cron_create.execute({
    name: '晨间摘要',
    prompt: 'Summarize overnight CI.',
    expr: '0 9 * * 1-5',
    timezone: 'Asia/Shanghai',
  }, {})
  assert.equal(created.job.name, '晨间摘要')
  assert.equal(created.job.schedule.kind, 'cron')
  assert.equal(created.job.schedule.expr, '0 9 * * 1-5')
  assert.ok(created.job.id)

  const listed = await tools.cron_list.execute({}, {})
  assert.equal(listed.count, 1)
  assert.equal(listed.jobs[0].id, created.job.id)

  const paused = await tools.cron_pause.execute({ id: created.job.id }, {})
  assert.equal(paused.job.enabled, false)

  const resumed = await tools.cron_resume.execute({ id: created.job.id }, {})
  assert.equal(resumed.job.enabled, true)

  const deleted = await tools.cron_delete.execute({ id: created.job.id }, {})
  assert.deepEqual(deleted, { id: created.job.id, deleted: true })
  const empty = await tools.cron_list.execute({}, {})
  assert.equal(empty.count, 0)
})

test('cron_create cwd defaults to the calling session workspace path', async (t) => {
  const service = await makeService(t)
  const tools = byName(cronToolDefinitions(service))
  const exec = { agent: { session: { header: { cwd: '/tmp/ws-app' } } } }
  const created = await tools.cron_create.execute({
    name: 'from-chat',
    prompt: 'do the thing',
    hour: 23,
    minute: 0,
    timezone: 'Asia/Shanghai',
  }, exec)
  assert.equal(created.job.cwd, '/tmp/ws-app')

  const explicit = await tools.cron_create.execute({
    name: 'custom-cwd',
    prompt: 'do the thing',
    hour: 23,
    minute: 1,
    timezone: 'Asia/Shanghai',
    cwd: '/tmp/isolated',
  }, exec)
  assert.equal(explicit.job.cwd, '/tmp/isolated')
})

test('cron_create snapshots the calling session model when provider is omitted', async (t) => {
  const service = await makeService(t)
  const tools = byName(cronToolDefinitions(service))
  const created = await tools.cron_create.execute({
    name: 'from-chat-model',
    prompt: 'ping',
    hour: 23,
    minute: 1,
    timezone: 'Asia/Shanghai',
  }, { agent: { options: { provider: 'minimax-cn', model: 'MiniMax-M3' }, session: { header: { cwd: '/tmp/ws-app' } } } })
  assert.equal(created.job.provider, 'minimax-cn')
  assert.equal(created.job.model, 'MiniMax-M3')

  const explicit = await tools.cron_create.execute({
    name: 'pinned',
    prompt: 'ping',
    hour: 23,
    minute: 2,
    timezone: 'Asia/Shanghai',
    provider: 'deepseek',
    model: 'deepseek-chat',
  }, { agent: { options: { provider: 'minimax-cn', model: 'MiniMax-M3' } } })
  assert.equal(explicit.job.provider, 'deepseek')
  assert.equal(explicit.job.model, 'deepseek-chat')
})

test('resolveCreateCwd prefers explicit cwd then the calling session', () => {
  assert.equal(resolveCreateCwd({ cwd: '/tmp/a' }, { agent: { session: { header: { cwd: '/ws' } } } }), '/tmp/a')
  assert.equal(callerWorkingDirectory({ agent: { session: { header: { cwd: '/ws' } } } }), '/ws')
  assert.equal(resolveCreateCwd({}, { agent: { session: { header: { cwd: '/ws' } } } }), '/ws')
  assert.equal(resolveCreateCwd({}, {}), '')
  assert.deepEqual(resolveCreateModel({}, { agent: { options: { provider: 'minimax-cn', model: 'MiniMax-M3' } } }), {
    provider: 'minimax-cn',
    model: 'MiniMax-M3',
    reasoningEffort: '',
  })
})

test('cron_create hour+minute uses today and rejects a guessed past calendar date', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cron-tools-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const service = createHostService({
    filePath: join(dir, 'store.json'),
    now: () => Date.now(),
    sessionPort: {
      async createAndPrompt() {
        return { sessionId: 'tool-sess', status: 'succeeded', summary: 'ok' }
      },
    },
  })
  const tools = byName(cronToolDefinitions(service))
  const created = await tools.cron_create.execute({
    name: 'tonight',
    prompt: 'ping',
    hour: 23,
    minute: 34,
    timezone: 'Asia/Shanghai',
  }, {})
  assert.equal(created.job.schedule.kind, 'at')
  assert.ok(created.job.nextRunAt > Date.now() - 1000)

  await assert.rejects(
    () => tools.cron_create.execute({
      name: 'past',
      prompt: 'ping',
      at: '2026-05-14T23:34:00+08:00',
      timezone: 'Asia/Shanghai',
    }, {}),
    /already in the past|Current local time/,
  )
})

test('cron_create accepts at and overlapping schedule fields prefer after_minutes then hour then at', async (t) => {
  const service = await makeService(t)
  const tools = byName(cronToolDefinitions(service))
  const created = await tools.cron_create.execute({
    name: 'once',
    prompt: 'ping',
    at: '2026-08-24T12:00:00+08:00',
  }, {})
  assert.equal(created.job.schedule.kind, 'at')

  const now = Date.parse('2026-08-24T00:32:00+08:00')
  const overlapped = scheduleFromArgs({
    at: '00:33',
    hour: 0,
    minute: 33,
    timezone: 'Asia/Shanghai',
  }, now)
  assert.equal(overlapped.kind, 'at')
  assert.equal(new Date(overlapped.at).toISOString(), new Date('2026-08-24T00:33:00+08:00').toISOString())

  const exprPlusHour = scheduleFromArgs({
    expr: '35 0 24 8 *',
    hour: 0,
    minute: 35,
    timezone: 'Asia/Shanghai',
  }, now)
  assert.equal(exprPlusHour.kind, 'at')
  assert.equal(new Date(exprPlusHour.at).toISOString(), new Date('2026-08-24T00:35:00+08:00').toISOString())

  const exprPlusAt = scheduleFromArgs({
    expr: '0 9 * * *',
    at: '2026-08-24T12:00:00+08:00',
    timezone: 'Asia/Shanghai',
  }, now)
  assert.equal(exprPlusAt.kind, 'at')
  assert.equal(exprPlusAt.at, '2026-08-24T12:00:00+08:00')

  const delay = scheduleFromArgs({ after_minutes: 1, at: '00:33', hour: 0, timezone: 'Asia/Shanghai' }, now)
  assert.equal(delay.kind, 'at')
  assert.equal(new Date(delay.at).getTime(), now + 60_000)
})

test('cron_create after_minutes schedules from now even if at and hour are also sent', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cron-tools-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const service = createHostService({
    filePath: join(dir, 'store.json'),
    now: () => Date.now(),
    sessionPort: {
      async createAndPrompt() {
        return { sessionId: 'tool-sess', status: 'succeeded', summary: 'ok' }
      },
    },
  })
  const tools = byName(cronToolDefinitions(service))
  const before = Date.now()
  const created = await tools.cron_create.execute({
    name: 'in-a-minute',
    prompt: 'ping',
    after_minutes: 1,
    at: '00:33',
    hour: 0,
    minute: 33,
    timezone: 'Asia/Shanghai',
  }, {})
  assert.equal(created.job.schedule.kind, 'at')
  assert.ok(created.job.nextRunAt >= before + 50_000)
  assert.ok(created.job.nextRunAt <= before + 80_000)
})

test('registerCronGuidance registers the scheduled-tasks skill only', () => {
  const skills = []
  const off = registerCronGuidance({
    skills: {
      register(skill) {
        skills.push(skill)
        return () => {
          const at = skills.indexOf(skill)
          if (at >= 0) skills.splice(at, 1)
        }
      },
    },
  })
  assert.equal(skills[0].name, 'scheduled-tasks')
  assert.equal(skills[0].source, 'runtime')
  assert.match(skills[0].description, /定时任务/)
  assert.match(skills[0].content, /hour/)
  off()
  assert.equal(skills.length, 0)
})

test('cron_create stamps ownerEmpNo from user-workspaces cwd', async (t) => {
  const service = await makeService(t)
  const tools = byName(cronToolDefinitions(service))
  const exec = { agent: { session: { header: { cwd: '/tmp/user-workspaces/alice/app' } } } }
  assert.equal(resolveToolIdentity(exec, service)?.empNo, 'alice')
  const created = await tools.cron_create.execute({
    name: 'owned',
    prompt: 'ping',
    after_minutes: 5,
    timezone: 'Asia/Shanghai',
  }, exec)
  assert.equal(created.job.ownerEmpNo, 'alice')
  assert.equal(created.job.cwd, '/tmp/user-workspaces/alice/app')

  const listed = await tools.cron_list.execute({}, exec)
  assert.equal(listed.count, 1)
  assert.equal(listed.jobs[0].id, created.job.id)
})

test('resolveToolIdentity restores super_admin permissions via udsAuth', () => {
  const uds = {
    getSessionOwner(sessionId) {
      return sessionId === 'sess-super' ? '10329667' : null
    },
    resolveIdentityForEmpNo(empNo) {
      if (empNo !== '10329667') return null
      return {
        empNo: '10329667',
        role: 'super_admin',
        displayName: 'Super',
        permissions: { canViewAllSessions: true, canCreateWorkspace: true },
        workspacePath: '/tmp/deepseek-harness/10329667',
      }
    },
    getProvisionedWorkspacePath(empNo) {
      return `/tmp/deepseek-harness/${empNo}`
    },
  }
  const identity = resolveToolIdentity(
    { agent: { session: { id: 'sess-super', header: { cwd: 'D:/code/gpt' } } } },
    { getUdsAuth: () => uds },
  )
  assert.equal(identity.empNo, '10329667')
  assert.equal(identity.role, 'super_admin')
  assert.equal(identity.permissions.canViewAllSessions, true)
})

test('cron_create keeps foreign cwd for super_admin tool identity', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cron-tools-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const owners = new Map([['sess-super', '10329667']])
  const uds = {
    getSessionOwner(id) { return owners.get(id) || null },
    resolveIdentityForEmpNo(empNo) {
      if (empNo !== '10329667') {
        return {
          empNo,
          role: 'user',
          permissions: { canViewAllSessions: false },
          workspacePath: `/tmp/user-workspaces/${empNo}`,
        }
      }
      return {
        empNo: '10329667',
        role: 'super_admin',
        permissions: { canViewAllSessions: true, canCreateWorkspace: true },
        workspacePath: '/tmp/deepseek-harness/10329667',
      }
    },
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
  }
  const service = createHostService({
    filePath: join(dir, 'store.json'),
    now: () => Date.parse('2026-08-24T01:00:00.000Z'),
    getUdsAuth: () => uds,
    sessionPort: {
      async createAndPrompt() {
        return { sessionId: 'tool-sess', status: 'succeeded', summary: 'ok' }
      },
    },
  })
  const tools = byName(cronToolDefinitions(service))
  const exec = {
    agent: {
      session: {
        id: 'sess-super',
        header: { cwd: '/tmp/deepseek-harness/10329667' },
      },
    },
  }
  const created = await tools.cron_create.execute({
    name: 'gpt-cron',
    prompt: 'continue BGP',
    after_minutes: 1,
    timezone: 'Asia/Shanghai',
    cwd: 'D:/code/gpt',
  }, exec)
  assert.equal(created.job.cwd, 'D:/code/gpt')
  assert.equal(created.job.ownerEmpNo, '10329667')
})

test('cron_create from IM peer stamps unassigned owner and forces session cwd', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cron-tools-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const peer = {
    botId: 'bot-a',
    conversationKey: 'direct:86138@s.whatsapp.net',
    conversationId: '86138@s.whatsapp.net',
    kind: 'direct',
    phone: '86138',
  }
  const dshIm = {
    resolveSessionPeer: async () => peer,
    listTargets: async () => [{
      targetId: 'auto-dm-86138',
      kind: 'user',
      route: { jid: '86138@s.whatsapp.net' },
    }],
  }
  const uds = {
    getSessionOwner() { return '10329667' },
    resolveIdentityForEmpNo(empNo) {
      return {
        empNo,
        role: 'super_admin',
        permissions: { canViewAllSessions: true, canCreateWorkspace: true },
        workspacePath: '/tmp/deepseek-harness/10329667',
      }
    },
    getProvisionedWorkspacePath(empNo) {
      return `/tmp/deepseek-harness/${empNo}`
    },
    isUserPath() { return false },
  }
  const service = createHostService({
    filePath: join(dir, 'store.json'),
    now: () => Date.parse('2026-08-24T01:00:00.000Z'),
    getUdsAuth: () => uds,
    getDshIm: () => dshIm,
    sessionPort: {
      async createAndPrompt() {
        return { sessionId: 'tool-sess', status: 'succeeded', summary: 'ok' }
      },
    },
  })
  const tools = byName(cronToolDefinitions(service, { getDshIm: () => dshIm }))
  const created = await tools.cron_create.execute({
    name: 'im-cron',
    prompt: 'channel work',
    after_minutes: 2,
    timezone: 'Asia/Shanghai',
    cwd: 'D:/code/gpt',
  }, {
    agent: {
      session: {
        id: 'sess-im',
        header: { cwd: '/data/bot-ws/wa' },
      },
    },
  })
  assert.equal(created.job.ownerEmpNo, '__unassigned__')
  assert.equal(created.job.cwd, '/data/bot-ws/wa')
  assert.equal(created.job.origin?.kind, 'im')
  assert.equal(created.job.delivery?.kind, 'im')
})

test('registerCronTools registers each definition and disposer unregisters', () => {
  const registered = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition.name)
        return () => {
          const at = registered.indexOf(definition.name)
          if (at >= 0) registered.splice(at, 1)
        }
      },
    },
  }
  const off = registerCronTools(ctx, {})
  assert.deepEqual(registered, [
    'cron_create',
    'cron_list',
    'cron_query',
    'cron_runs',
    'cron_progress',
    'cron_pause',
    'cron_resume',
    'cron_delete',
  ])
  off()
  assert.deepEqual(registered, [])
})

test('cron tool output schemas never use type arrays (Host rejects them)', () => {
  const defs = cronToolDefinitions({
    async createJob() { return {} },
    async listJobs() { return [] },
    async queryJobs() { return { jobs: [], items: [], count: 0 } },
    async listRuns() { return { task_id: '', runs: [], next_cursor: null, total: 0 } },
    async getProgress() { return { snapshots: [], count: 0 } },
    async pauseJob() { return {} },
    async resumeJob() { return {} },
    async deleteJob() { return {} },
  })
  const bad = []
  function walk(node, path) {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node.type)) bad.push(`${path}.type=${JSON.stringify(node.type)}`)
    if (Array.isArray(node.oneOf)) node.oneOf.forEach((branch, i) => walk(branch, `${path}.oneOf[${i}]`))
    if (node.properties && typeof node.properties === 'object') {
      for (const [key, child] of Object.entries(node.properties)) walk(child, `${path}.properties.${key}`)
    }
    if (node.items) walk(node.items, `${path}.items`)
  }
  for (const def of defs) walk(def.output?.schema, def.name)
  assert.deepEqual(bad, [])
})
