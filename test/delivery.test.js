import assert from 'node:assert/strict'
import test from 'node:test'
import {
  matchTargetForPeer,
  normalizeDelivery,
  resolveCreateDelivery,
  deliverRunToIm,
} from '../lib/delivery.js'

test('normalizeDelivery defaults to dsh', () => {
  assert.deepEqual(normalizeDelivery({}), { kind: 'dsh' })
})

test('normalizeDelivery requires botId+targetId for im', () => {
  assert.throws(() => normalizeDelivery({ kind: 'im', botId: 'b' }), /im delivery/)
  assert.deepEqual(
    normalizeDelivery({ kind: 'im', botId: 'bot_1', targetId: 'alerts' }),
    { kind: 'im', botId: 'bot_1', targetId: 'alerts' },
  )
})

test('matchTargetForPeer matches whatsapp jid from conversationKey', () => {
  const peer = { botId: 'bot_1', conversationKey: 'direct:8613800000000@s.whatsapp.net' }
  const targets = [
    { targetId: 'other', route: { jid: '1@s.whatsapp.net' } },
    { targetId: 'alerts', route: { jid: '8613800000000@s.whatsapp.net' } },
  ]
  assert.equal(matchTargetForPeer(targets, peer).targetId, 'alerts')
})

test('resolveCreateDelivery uses explicit im args', async () => {
  const delivery = await resolveCreateDelivery({
    delivery: 'im',
    im_bot_id: 'bot_x',
    im_target_id: 'tgt_y',
  }, {})
  assert.deepEqual(delivery, { kind: 'im', botId: 'bot_x', targetId: 'tgt_y' })
})

test('resolveCreateDelivery auto-matches peer target', async () => {
  const dshIm = {
    resolveSessionPeer: async () => ({
      botId: 'bot_1',
      conversationKey: 'direct:86138@s.whatsapp.net',
    }),
    listTargets: async () => ([
      { targetId: 'wa-dm', route: { jid: '86138@s.whatsapp.net' } },
    ]),
  }
  const delivery = await resolveCreateDelivery({}, {
    agent: { session: { id: 'sess-1' } },
  }, { dshIm })
  assert.deepEqual(delivery, { kind: 'im', botId: 'bot_1', targetId: 'wa-dm' })
})

test('deliverRunToIm sends via dshIm', async () => {
  const sent = []
  await deliverRunToIm(
    { name: 'ping', delivery: { kind: 'im', botId: 'b', targetId: 't' } },
    'hello world',
    { dshIm: { send: async (...args) => { sent.push(args) } } },
  )
  assert.equal(sent.length, 1)
  assert.equal(sent[0][0], 'b')
  assert.equal(sent[0][1], 't')
  assert.match(sent[0][2], /运维定时/)
  assert.match(sent[0][2], /hello world/)
})
