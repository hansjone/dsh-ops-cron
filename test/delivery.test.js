import assert from 'node:assert/strict'
import test from 'node:test'
import {
  matchTargetForPeer,
  normalizeDelivery,
  normalizeOrigin,
  resolveCreateDelivery,
  resolveCreateOrigin,
  resolveMirrorSession,
  formatRunResultBody,
  deliverRunToIm,
  mirrorRunToSession,
  jobVisibleToPeer,
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

test('normalizeOrigin pins web and im shapes', () => {
  assert.equal(normalizeOrigin(null), null)
  assert.deepEqual(
    normalizeOrigin({ kind: 'web', sessionId: 'sess-web' }),
    { kind: 'web', sessionId: 'sess-web' },
  )
  assert.deepEqual(
    normalizeOrigin({
      kind: 'im',
      sessionId: 'sess-im',
      peer: { botId: 'bot_1', conversationKey: 'direct:86138@s.whatsapp.net', kind: 'direct' },
    }),
    {
      kind: 'im',
      sessionId: 'sess-im',
      peer: { botId: 'bot_1', conversationKey: 'direct:86138@s.whatsapp.net', kind: 'direct' },
    },
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

test('resolveCreateOrigin captures im peer from caller session', async () => {
  const dshIm = {
    resolveSessionPeer: async () => ({
      botId: 'bot_1',
      conversationKey: 'group:120363@g.us:user:86138@s.whatsapp.net',
      conversationId: '120363@g.us',
      kind: 'group',
    }),
  }
  const origin = await resolveCreateOrigin({}, {
    agent: { session: { id: 'sess-group' } },
  }, { dshIm })
  assert.deepEqual(origin, {
    kind: 'im',
    sessionId: 'sess-group',
    peer: {
      botId: 'bot_1',
      conversationKey: 'group:120363@g.us:user:86138@s.whatsapp.net',
      conversationId: '120363@g.us',
      kind: 'group',
    },
  })
})

test('resolveCreateOrigin falls back to web when no peer', async () => {
  const origin = await resolveCreateOrigin({}, {
    agent: { session: { id: 'sess-web' } },
  }, { dshIm: { resolveSessionPeer: async () => null } })
  assert.deepEqual(origin, { kind: 'web', sessionId: 'sess-web' })
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

test('resolveMirrorSession prefers live conversation binding over stale origin.sessionId', async () => {
  const hit = await resolveMirrorSession({
    origin: {
      kind: 'im',
      sessionId: 'stale-sess',
      peer: { botId: 'bot_1', conversationKey: 'direct:86138@s.whatsapp.net' },
    },
    delivery: { kind: 'im', botId: 'bot_1', targetId: 'wa-dm' },
  }, {
    dshIm: {
      resolveConversationSession: async () => ({
        sessionId: 'live-sess',
        botId: 'bot_1',
        conversationKey: 'direct:86138@s.whatsapp.net',
      }),
    },
  })
  assert.deepEqual(hit, { sessionId: 'live-sess', via: 'conversation' })
})

test('resolveMirrorSession falls back to origin.sessionId', async () => {
  const hit = await resolveMirrorSession({
    origin: { kind: 'web', sessionId: 'origin-web' },
    delivery: { kind: 'dsh' },
  }, {})
  assert.deepEqual(hit, { sessionId: 'origin-web', via: 'origin' })
})

test('mirrorRunToSession appends plugin notice without waking a turn', async () => {
  const appended = []
  const result = await mirrorRunToSession(
    {
      name: '日报',
      origin: { kind: 'web', sessionId: 'origin-1' },
      delivery: { kind: 'dsh' },
    },
    'line one',
    {
      getAgents: () => ({
        get: () => ({
          session: {
            append: (...args) => { appended.push(args) },
          },
        }),
      }),
      newId: () => 'msg-1',
      pluginName: 'dsh-ops-cron',
    },
  )
  assert.equal(result.mirrored, true)
  assert.equal(result.method, 'append')
  assert.equal(appended.length, 1)
  assert.equal(appended[0][0], 'user/message')
  assert.match(appended[0][1].content[0].text, /日报/)
  assert.match(appended[0][1].content[0].text, /line one/)
  assert.match(appended[0][1].content[0].text, /<system-reminder>/)
  assert.equal(appended[0][1].source.kind, 'plugin')
  assert.deepEqual(appended[0][2], { surfaceOp: 'append' })
})

test('matchTargetForPeer requires exact JID equality', () => {
  const targets = [{
    targetId: 'suffix-trap',
    kind: 'user',
    route: { jid: '8613800138000@s.whatsapp.net' },
  }]
  const peer = {
    kind: 'direct',
    conversationId: '13800138000@s.whatsapp.net',
    phone: '13800138000',
  }
  assert.equal(matchTargetForPeer(targets, peer), null)
})

test('jobVisibleToPeer scopes IM ownership to origin conversation', () => {
  const peer = {
    botId: 'bot-a',
    conversationKey: 'group:120363@g.us:user:1@lid',
    conversationId: '120363@g.us',
  }
  assert.equal(jobVisibleToPeer({
    origin: {
      kind: 'im',
      peer: { botId: 'bot-a', conversationKey: 'group:120363@g.us:user:1@lid', conversationId: '120363@g.us' },
    },
  }, peer), true)
  assert.equal(jobVisibleToPeer({
    origin: {
      kind: 'im',
      peer: { botId: 'bot-a', conversationKey: 'group:other@g.us', conversationId: 'other@g.us' },
    },
  }, peer), false)
  assert.equal(jobVisibleToPeer({
    origin: { kind: 'web', sessionId: 'web-1' },
  }, peer), false)
})

test('resolveCreateDelivery binds IM peers to the current chat', async () => {
  const peer = {
    botId: 'bot-a',
    conversationKey: 'direct:86138@s.whatsapp.net',
    conversationId: '86138@s.whatsapp.net',
    kind: 'direct',
    phone: '86138',
  }
  const delivery = await resolveCreateDelivery(
    { delivery: 'im', im_bot_id: 'other-bot', im_target_id: 'other-target' },
    { agent: { session: { id: 'sess-im' } } },
    {
      dshIm: {
        resolveSessionPeer: async () => peer,
        listTargets: async () => [{
          targetId: 'auto-dm',
          kind: 'user',
          route: { jid: '86138@s.whatsapp.net' },
        }],
      },
    },
  )
  assert.equal(delivery.kind, 'im')
  assert.equal(delivery.botId, 'bot-a')
  assert.equal(delivery.targetId, 'auto-dm')
})

test('mirrorRunToSession resumes a cold origin session instead of create', async () => {
  const appended = []
  const resumed = []
  const result = await mirrorRunToSession(
    {
      name: '冷会话',
      origin: { kind: 'web', sessionId: 'cold-1' },
    },
    'hello',
    {
      getAgents: () => ({
        get: () => null,
        create: async () => {
          throw new Error('create must not be used for origin mirror')
        },
        resume: async (opts) => {
          resumed.push(opts)
          return {
            agent: {
              session: {
                append: (...args) => { appended.push(args) },
              },
            },
          }
        },
      }),
      newId: () => 'msg-2',
    },
  )
  assert.equal(result.mirrored, true)
  assert.equal(result.resumed, true)
  assert.deepEqual(resumed, [{ resumeSessionId: 'cold-1' }])
  assert.equal(appended[0][0], 'user/message')
})

test('mirrorRunToSession skips when origin session is unavailable', async () => {
  const result = await mirrorRunToSession(
    {
      name: 'gone',
      origin: { kind: 'web', sessionId: 'missing' },
    },
    'x',
    {
      getAgents: () => ({
        get: () => null,
        resume: async () => {
          throw new Error('not found')
        },
      }),
    },
  )
  assert.equal(result.mirrored, false)
  assert.equal(result.reason, 'session_unavailable')
})

test('formatRunResultBody matches IM delivery header', () => {
  const body = formatRunResultBody({ name: '晨报' }, 'ok')
  assert.match(body, /^【定时任务 · 晨报】\n/)
  assert.match(body, /ok$/)
  const en = formatRunResultBody({ name: 'Daily' }, 'ok', 'en')
  assert.match(en, /^\[Scheduled tasks · Daily\]\n/)
})
