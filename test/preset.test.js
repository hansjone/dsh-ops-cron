import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeAgentPresetId, resolveCreateAgentPreset } from '../lib/preset.js'
import { createJobRecord, emptyState } from '../lib/store.js'

test('normalizeAgentPresetId accepts empty and valid ids', () => {
  assert.equal(normalizeAgentPresetId(''), '')
  assert.equal(normalizeAgentPresetId('  ops-desk  '), 'ops-desk')
  assert.throws(() => normalizeAgentPresetId('bad preset'), /agentPreset/)
})

test('createJobRecord persists agentPreset', () => {
  const job = createJobRecord({
    name: 'n',
    prompt: 'p',
    schedule: { kind: 'cron', expr: '0 9 * * *', timezone: 'Asia/Shanghai' },
    agentPreset: 'ops-desk',
  }, emptyState(), Date.now())
  assert.equal(job.agentPreset, 'ops-desk')
})

test('createJobRecord defaults mirrorToSession off and accepts explicit true', () => {
  const base = {
    name: 'n',
    prompt: 'p',
    schedule: { kind: 'cron', expr: '0 9 * * *', timezone: 'Asia/Shanghai' },
  }
  assert.equal(createJobRecord(base, emptyState(), Date.now()).mirrorToSession, false)
  assert.equal(
    createJobRecord({ ...base, mirrorToSession: true }, emptyState(), Date.now()).mirrorToSession,
    true,
  )
  assert.equal(
    createJobRecord({ ...base, mirror_to_session: true }, emptyState(), Date.now()).mirrorToSession,
    true,
  )
  assert.equal(
    createJobRecord({ ...base, mirrorToSession: 'yes' }, emptyState(), Date.now()).mirrorToSession,
    false,
  )
})

test('createJobRecord fires ASAP when one-shot at is slightly in the past', () => {
  const now = Date.parse('2026-08-24T01:00:30.000Z')
  const at = new Date(now - 15_000).toISOString()
  const job = createJobRecord({
    name: 'soon',
    prompt: 'ping',
    schedule: { kind: 'at', at, timezone: 'UTC' },
  }, emptyState(), now)
  assert.equal(job.nextRunAt, now)

  assert.throws(
    () => createJobRecord({
      name: 'late',
      prompt: 'ping',
      schedule: { kind: 'at', at: new Date(now - 120_000).toISOString(), timezone: 'UTC' },
    }, emptyState(), now),
    (error) => error.code === 'INVALID_AT',
  )
})

test('resolveCreateAgentPreset prefers explicit then peer then session then host default', async () => {
  assert.equal(
    await resolveCreateAgentPreset({ agent_preset: 'explicit' }, {}, {}),
    'explicit',
  )

  const fromPeer = await resolveCreateAgentPreset({}, { agent: { session: { id: 's1' } } }, {
    dshIm: {
      resolveSessionPeer: async () => ({ agentPreset: 'from-peer' }),
    },
  })
  assert.equal(fromPeer, 'from-peer')

  const fromMeta = await resolveCreateAgentPreset({}, {
    agent: { session: { meta: { agentPreset: 'from-meta' } } },
  }, {})
  assert.equal(fromMeta, 'from-meta')

  const fromHost = await resolveCreateAgentPreset({}, {}, {
    agentPresets: {
      resolve: async () => ({ id: 'host-default' }),
    },
  })
  assert.equal(fromHost, 'host-default')
})
