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
      conversationId: '86138@s.whatsapp.net',
      kind: 'direct',
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

test('resolveCreateDelivery auto-creates group target when none exists', async () => {
  const created = []
  const dshIm = {
    resolveSessionPeer: async () => ({
      botId: 'bot_wa',
      kind: 'group',
      conversationKey: 'group:120363@g.us:user:86138@s.whatsapp.net',
      conversationId: '120363@g.us',
      label: '运维群',
    }),
    listTargets: async () => ([]),
    createTarget: async (botId, target) => {
      created.push({ botId, target })
      return target
    },
  }
  const delivery = await resolveCreateDelivery({}, {
    agent: { session: { id: 'sess-group' } },
  }, { dshIm })
  assert.equal(created.length, 1)
  assert.equal(created[0].botId, 'bot_wa')
  assert.equal(created[0].target.kind, 'group')
  assert.equal(created[0].target.route.jid, '120363@g.us')
  assert.deepEqual(delivery, {
    kind: 'im',
    botId: 'bot_wa',
    targetId: created[0].target.targetId,
  })
})

test('matchTargetForPeer matches phone-mapped DM against phone JID target', () => {
  const peer = {
    botId: 'bot_1',
    conversationKey: 'direct:910xxx@lid',
    conversationId: '910xxx@lid',
    phone: '8613800000000',
  }
  const targets = [
    { targetId: 'alerts', kind: 'user', route: { jid: '8613800000000@s.whatsapp.net' } },
  ]
  assert.equal(matchTargetForPeer(targets, peer).targetId, 'alerts')
})

test('matchTargetForPeer does not bind group peer to a DM via sender phone', () => {
  const peer = {
    botId: 'bot_1',
    kind: 'group',
    conversationKey: 'group:120363999@g.us:user:8613800000000@s.whatsapp.net',
    conversationId: '120363999@g.us',
    phone: '8613800000000',
    label: 'Ops Room · Alice · 8613800000000',
  }
  const targets = [
    { targetId: 'my-dm', kind: 'user', route: { jid: '8613800000000@s.whatsapp.net' } },
    { targetId: 'ops-group', kind: 'group', route: { jid: '120363999@g.us' } },
  ]
  assert.equal(matchTargetForPeer(targets, peer).targetId, 'ops-group')
})

test('matchTargetForPeer ignores DM-only catalog when peer is a group', () => {
  const peer = {
    botId: 'bot_1',
    kind: 'group',
    conversationKey: 'group:120363999@g.us:user:8613800000000@s.whatsapp.net',
    conversationId: '120363999@g.us',
    phone: '8613800000000',
  }
  const targets = [
    { targetId: 'my-dm', kind: 'user', route: { jid: '8613800000000@s.whatsapp.net' } },
  ]
  assert.equal(matchTargetForPeer(targets, peer), null)
})

test('resolveCreateDelivery pins group creator mention from peer', async () => {
  const dshIm = {
    resolveSessionPeer: async () => ({
      botId: 'bot_wa',
      kind: 'group',
      conversationKey: 'group:120363@g.us:user:910xxx@lid',
      conversationId: '120363@g.us',
      senderId: '910xxx@lid',
      phone: '8613800000000',
      pushName: 'Alice',
      label: 'Ops · Alice · 8613800000000',
    }),
    listTargets: async () => ([
      { targetId: 'ops-group', kind: 'group', route: { jid: '120363@g.us' } },
    ]),
  }
  const delivery = await resolveCreateDelivery({}, {
    agent: { session: { id: 'sess-group' } },
  }, { dshIm })
  assert.deepEqual(delivery, {
    kind: 'im',
    botId: 'bot_wa',
    targetId: 'ops-group',
    // Prefer phone JID over LID so WhatsApp can show nickname + notify.
    mentionJid: '8613800000000@s.whatsapp.net',
    mentionName: 'Alice',
  })
})

test('deliverRunToIm @mentions the creator in group deliveries', async () => {
  const sent = []
  await deliverRunToIm(
    {
      name: 'ping',
      delivery: {
        kind: 'im',
        botId: 'b',
        targetId: 't',
        mentionJid: '8613800000000@s.whatsapp.net',
        mentionName: 'Alice',
      },
    },
    'hello world',
    {
      dshIm: {
        send: async (...args) => { sent.push(args) },
      },
    },
  )
  assert.equal(sent.length, 1)
  assert.match(sent[0][2], /^@8613800000000\n/)
  assert.match(sent[0][2], /定时任务/)
  assert.deepEqual(sent[0][3], { mentions: ['8613800000000@s.whatsapp.net'] })
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
  assert.match(sent[0][2], /定时任务/)
  assert.match(sent[0][2], /hello world/)
})
