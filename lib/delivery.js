/**
 * Job delivery: DSH sidebar session vs proactive IM (botId + targetId).
 * Group jobs may also pin mentionJid so delivery @s the creator.
 */

export function normalizeDelivery(input = {}) {
  const src = input && typeof input === 'object' ? input : {}
  const kind = String(src.kind || 'dsh').trim().toLowerCase()
  if (kind === 'im') {
    const botId = typeof src.botId === 'string' ? src.botId.trim() : ''
    const targetId = typeof src.targetId === 'string' ? src.targetId.trim() : ''
    if (!botId || !targetId) {
      const error = new Error('im delivery requires botId and targetId')
      error.code = 'INVALID_DELIVERY'
      throw error
    }
    const mentionJid = typeof src.mentionJid === 'string' ? src.mentionJid.trim() : ''
    const mentionName = typeof src.mentionName === 'string' ? src.mentionName.trim().slice(0, 80) : ''
    const delivery = { kind: 'im', botId, targetId }
    if (mentionJid && /@(s\.whatsapp\.net|lid)$/i.test(mentionJid)) {
      delivery.mentionJid = mentionJid
      if (mentionName) delivery.mentionName = mentionName
    }
    return delivery
  }
  return { kind: 'dsh' }
}

/**
 * Keep creator @mention when the UI re-saves the same IM target without mention fields.
 * @param {object|null|undefined} previous
 * @param {object} next
 */
export function mergeDeliveryMention(previous, next) {
  const normalized = normalizeDelivery(next)
  if (normalized.kind !== 'im' || normalized.mentionJid) return normalized
  if (previous?.kind !== 'im') return normalized
  if (previous.botId !== normalized.botId || previous.targetId !== normalized.targetId) {
    return normalized
  }
  if (!previous.mentionJid) return normalized
  return normalizeDelivery({
    ...normalized,
    mentionJid: previous.mentionJid,
    mentionName: previous.mentionName,
  })
}

export function deliveryLine(delivery) {
  if (!delivery || delivery.kind !== 'im') return 'delivery=dsh'
  const mention = delivery.mentionJid ? ` mention=@${delivery.mentionName || delivery.mentionJid}` : ''
  return `delivery=im botId=${delivery.botId} targetId=${delivery.targetId}${mention}`
}

function peerIsGroup(peer) {
  if (!peer || typeof peer !== 'object') return false
  if (peer.kind === 'group') return true
  const conversationId = String(peer.conversationId || '').trim()
  if (conversationId.endsWith('@g.us')) return true
  const key = String(peer.conversationKey || '').trim()
  return key.startsWith('group:')
}

/**
 * Group creator identity for WhatsApp @mention on delivery.
 * Prefer phone JID so WhatsApp shows the contact nickname and notifies;
 * LID-only identities are a last resort (often render as opaque digits).
 * @param {object|null} peer
 * @returns {{ mentionJid: string, mentionName?: string } | null}
 */
export function mentionFromPeer(peer) {
  if (!peerIsGroup(peer)) return null
  const phone = typeof peer.phone === 'string' ? peer.phone.trim() : ''
  const senderId = typeof peer.senderId === 'string' ? peer.senderId.trim() : ''
  const phoneJid = phone ? `${phone}@s.whatsapp.net` : ''
  const senderIsPhone = /@s\.whatsapp\.net$/i.test(senderId)
  const senderIsLid = /@lid$/i.test(senderId)
  const mentionJid = phoneJid
    || (senderIsPhone ? senderId : '')
    || (senderIsLid ? senderId : '')
  if (!mentionJid) return null
  const pushName = typeof peer.pushName === 'string' ? peer.pushName.trim() : ''
  const mentionName = (pushName || phone || mentionJid.split('@')[0] || '').slice(0, 80)
  return mentionName
    ? { mentionJid, mentionName }
    : { mentionJid }
}

function withPeerMention(delivery, peer) {
  if (!delivery || delivery.kind !== 'im') return delivery
  const mention = mentionFromPeer(peer)
  if (!mention) return delivery
  return normalizeDelivery({ ...delivery, ...mention })
}

/**
 * JID candidates for matching saved 投递目标.
 * Groups must NEVER include the sender phone — that would bind cron delivery to a DM.
 * @param {object|null} peer
 * @returns {string[]}
 */
function peerJidCandidates(peer) {
  if (!peer || typeof peer !== 'object') return []
  const conversationId = String(peer.conversationId || '').trim()
  const key = String(peer.conversationKey || '').trim()
  if (peerIsGroup(peer)) {
    const groupFromKey = key.startsWith('group:')
      ? key.slice('group:'.length).split(':user:')[0].trim()
      : ''
    return [
      peer.jid,
      peer.route?.jid,
      conversationId,
      groupFromKey,
    ]
      .map((value) => String(value || '').trim().toLowerCase())
      .filter((value) => value.endsWith('@g.us'))
  }
  const jidFromKey = key.startsWith('direct:')
    ? key.slice('direct:'.length).trim()
    : (key.includes(':') ? key.slice(key.indexOf(':') + 1).split(':user:')[0] : key)
  const phoneJid = peer.phone ? `${String(peer.phone).trim()}@s.whatsapp.net` : ''
  return [
    peer.jid,
    peer.route?.jid,
    conversationId,
    phoneJid,
    jidFromKey,
  ]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
}

/**
 * Match a delivery target whose route overlaps the channel peer conversation.
 * @param {Array<object>} targets
 * @param {object|null} peer - from dshIm.resolveSessionPeer
 */
export function matchTargetForPeer(targets, peer) {
  if (!peer || !Array.isArray(targets) || targets.length === 0) return null
  const candidates = peerJidCandidates(peer)
  if (candidates.length === 0) return null
  const wantGroup = peerIsGroup(peer)
  for (const target of targets) {
    const targetKind = typeof target?.kind === 'string' ? target.kind.trim() : ''
    if (wantGroup && targetKind === 'user') continue
    if (!wantGroup && targetKind === 'group') continue
    const route = target?.route && typeof target.route === 'object' ? target.route : {}
    const jid = String(route.jid || route.chatId || route.openId || route.userId || '').trim().toLowerCase()
    if (!jid) continue
    if (wantGroup && !jid.endsWith('@g.us')) continue
    if (candidates.some((peerJid) => (
      jid === peerJid || peerJid.endsWith(jid) || jid.endsWith(peerJid)
    ))) {
      return target
    }
  }
  return null
}

function slugId(value, fallback) {
  const raw = String(value || '').trim().toLowerCase()
  const slug = raw.replace(/@.*/, '').replace(/[^a-z0-9_-]+/g, '').slice(0, 40)
  return slug || fallback
}

/**
 * Build a WhatsApp (or JID-shaped) delivery target draft for the current peer.
 * Group chats always target the group JID; DMs prefer phone JID when known.
 * @param {object|null} peer
 * @returns {{ botId: string, target: object } | null}
 */
export function deliveryDraftFromPeer(peer) {
  if (!peer?.botId || !peer.conversationId) return null
  const conversationId = String(peer.conversationId).trim()
  const isGroup = peerIsGroup(peer)
  const routeJid = (!isGroup && peer.phone)
    ? `${String(peer.phone).trim()}@s.whatsapp.net`
    : conversationId
  if (!routeJid) return null
  if (isGroup && !routeJid.endsWith('@g.us')) return null
  if (!isGroup && !/@(s\.whatsapp\.net|lid)$/i.test(routeJid)) {
    // Non-WhatsApp peers are not auto-materialized yet.
    return null
  }
  const name = String(peer.label || (isGroup ? 'WhatsApp 群聊' : 'WhatsApp 私聊')).trim().slice(0, 80)
  const targetId = isGroup
    ? `auto-group-${slugId(routeJid, 'chat')}`
    : `auto-dm-${slugId(peer.phone || routeJid, 'user')}`
  return {
    botId: String(peer.botId).trim(),
    target: {
      targetId,
      name: name || targetId,
      kind: isGroup ? 'group' : 'user',
      route: { jid: routeJid },
    },
  }
}

/**
 * Reuse or create a delivery target for the WhatsApp/IM peer that owns this session.
 * @param {object|null} peer
 * @param {object} dshIm
 * @returns {Promise<{ kind: 'im', botId: string, targetId: string } | null>}
 */
export async function ensureImDeliveryForPeer(peer, dshIm) {
  if (!peer?.botId || !dshIm || typeof dshIm.listTargets !== 'function') return null
  let targets = []
  try {
    const listed = await dshIm.listTargets(peer.botId)
    targets = Array.isArray(listed) ? listed : []
  } catch {
    return null
  }
  const match = matchTargetForPeer(targets, peer)
  if (match?.targetId) {
    return withPeerMention(
      normalizeDelivery({ kind: 'im', botId: peer.botId, targetId: String(match.targetId) }),
      peer,
    )
  }
  const draft = deliveryDraftFromPeer(peer)
  if (!draft || typeof dshIm.createTarget !== 'function') return null
  try {
    const created = await dshIm.createTarget(draft.botId, draft.target)
    const targetId = created?.targetId || draft.target.targetId
    return withPeerMention(
      normalizeDelivery({ kind: 'im', botId: draft.botId, targetId: String(targetId) }),
      peer,
    )
  } catch (error) {
    if (error?.code !== 'target-conflict') return null
    try {
      const again = await dshIm.listTargets(peer.botId)
      const rows = Array.isArray(again) ? again : []
      const byId = rows.find((row) => row?.targetId === draft.target.targetId)
      if (byId?.targetId) {
        return withPeerMention(
          normalizeDelivery({ kind: 'im', botId: peer.botId, targetId: String(byId.targetId) }),
          peer,
        )
      }
      const rematch = matchTargetForPeer(rows, peer)
      if (rematch?.targetId) {
        return withPeerMention(
          normalizeDelivery({ kind: 'im', botId: peer.botId, targetId: String(rematch.targetId) }),
          peer,
        )
      }
    } catch {
      return null
    }
    return null
  }
}

export function callerSessionId(exec) {
  const session = exec?.agent?.session
  return String(
    session?.id
    || session?.sessionId
    || exec?.agent?.sessionId
    || exec?.sessionId
    || '',
  ).trim()
}

/**
 * Normalize a durable origin binding for result mirroring.
 * @param {object|null|undefined} input
 * @returns {{ kind: 'web' | 'im', sessionId?: string, peer?: object } | null}
 */
export function normalizeOrigin(input) {
  if (!input || typeof input !== 'object') return null
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
  const peerSrc = input.peer && typeof input.peer === 'object' ? input.peer : null
  const peerBotId = typeof peerSrc?.botId === 'string' ? peerSrc.botId.trim() : ''
  const conversationKey = typeof peerSrc?.conversationKey === 'string'
    ? peerSrc.conversationKey.trim()
    : ''
  const kindRaw = String(input.kind || '').trim().toLowerCase()
  const kind = kindRaw === 'im' || peerBotId
    ? 'im'
    : (kindRaw === 'web' || sessionId ? 'web' : '')
  if (!kind) return null
  if (!sessionId && !(kind === 'im' && peerBotId && conversationKey)) return null
  const origin = { kind }
  if (sessionId) origin.sessionId = sessionId
  if (kind === 'im' && peerBotId && conversationKey) {
    origin.peer = {
      botId: peerBotId,
      conversationKey,
      ...typeof peerSrc.conversationId === 'string' && peerSrc.conversationId.trim()
        ? { conversationId: peerSrc.conversationId.trim() }
        : {},
      ...peerSrc.kind === 'group' || peerSrc.kind === 'direct'
        ? { kind: peerSrc.kind }
        : {},
    }
  }
  return origin
}

function slimPeer(peer) {
  if (!peer || typeof peer !== 'object') return null
  const botId = typeof peer.botId === 'string' ? peer.botId.trim() : ''
  const conversationKey = typeof peer.conversationKey === 'string'
    ? peer.conversationKey.trim()
    : ''
  if (!botId || !conversationKey) return null
  return {
    botId,
    conversationKey,
    ...typeof peer.conversationId === 'string' && peer.conversationId.trim()
      ? { conversationId: peer.conversationId.trim() }
      : {},
    ...peer.kind === 'group' || peer.kind === 'direct' ? { kind: peer.kind } : {},
  }
}

/**
 * Resolve origin for cron_create / sidebar create.
 * Prefer an explicit origin; else capture the caller session (+ IM peer when present).
 * @param {object} args
 * @param {object} exec
 * @param {{ dshIm?: object }} deps
 */
export async function resolveCreateOrigin(args = {}, exec = {}, deps = {}) {
  const explicit = normalizeOrigin(args.origin)
  if (explicit) return explicit

  const sessionId = typeof args.origin_session_id === 'string'
    ? args.origin_session_id.trim()
    : (typeof args.originSessionId === 'string' ? args.originSessionId.trim() : '')
  const callerId = sessionId || callerSessionId(exec)
  if (!callerId) return null

  const dshIm = deps.dshIm
  if (dshIm && typeof dshIm.resolveSessionPeer === 'function') {
    try {
      const peer = await dshIm.resolveSessionPeer(callerId)
      const slim = slimPeer(peer)
      if (slim) {
        return normalizeOrigin({ kind: 'im', sessionId: callerId, peer: slim })
      }
    } catch {
      // fall through to web origin
    }
  }
  return normalizeOrigin({ kind: 'web', sessionId: callerId })
}

/**
 * Resolve delivery for cron_create: explicit args win; else IM peer → matching
 * or auto-created 投递目标; else dsh.
 * @param {object} args
 * @param {object} exec
 * @param {{ dshIm?: object }} deps
 */
export async function resolveCreateDelivery(args = {}, exec = {}, deps = {}) {
  const explicit = typeof args.delivery === 'string' ? args.delivery.trim().toLowerCase() : ''
  const botId = typeof args.im_bot_id === 'string' ? args.im_bot_id.trim()
    : (typeof args.imBotId === 'string' ? args.imBotId.trim() : '')
  const targetId = typeof args.im_target_id === 'string' ? args.im_target_id.trim()
    : (typeof args.imTargetId === 'string' ? args.imTargetId.trim() : '')

  if (explicit === 'dsh') return normalizeDelivery({ kind: 'dsh' })
  if (explicit === 'im' || (botId && targetId)) {
    return normalizeDelivery({ kind: 'im', botId, targetId })
  }

  const dshIm = deps.dshIm
  const sessionId = callerSessionId(exec)
  if (sessionId && dshIm && typeof dshIm.resolveSessionPeer === 'function') {
    try {
      const peer = await dshIm.resolveSessionPeer(sessionId)
      const ensured = await ensureImDeliveryForPeer(peer, dshIm)
      if (ensured) return ensured
    } catch {
      // fall through to dsh
    }
  }
  return normalizeDelivery({ kind: 'dsh' })
}

const IM_MAX_CHARS = 3500

/**
 * Shared body for IM delivery and session mirror (without @mention prefix).
 * @param {object} job
 * @param {string} [summary]
 */
export function formatRunResultBody(job, summary) {
  const text = String(summary || '').trim() || `(定时任务「${job?.name || ''}」已完成，无文本摘要)`
  const clipped = text.length > IM_MAX_CHARS ? `${text.slice(0, IM_MAX_CHARS)}…` : text
  return `【定时任务 · ${job?.name || ''}】\n${clipped}`
}

/**
 * Send run summary to IM when job.delivery.kind === 'im'.
 * Group deliveries @mention the creator when mentionJid was captured at create time.
 */
export async function deliverRunToIm(job, summary, deps = {}) {
  const delivery = job?.delivery
  if (!delivery || delivery.kind !== 'im') return { sent: false, skipped: true }
  const dshIm = deps.dshIm
  if (!dshIm || typeof dshIm.send !== 'function') {
    const error = new Error('ctx.dshIm unavailable — install dsh-im-ops for IM delivery')
    error.code = 'IM_UNAVAILABLE'
    throw error
  }
  const headerAndBody = formatRunResultBody(job, summary)
  const mentionJid = typeof delivery.mentionJid === 'string' ? delivery.mentionJid.trim() : ''
  let body = headerAndBody
  const options = {}
  if (mentionJid && /@(s\.whatsapp\.net|lid)$/i.test(mentionJid)) {
    const token = mentionJid.slice(0, mentionJid.indexOf('@'))
    body = `@${token}\n${headerAndBody}`
    options.mentions = [mentionJid]
  }
  await dshIm.send(delivery.botId, delivery.targetId, body, options)
  return { sent: true, mentioned: Boolean(options.mentions) }
}

/**
 * Resolve which live/effective session should receive a mirrored run summary.
 * Prefer the current IM conversation binding over a stale origin.sessionId.
 * @param {object} job
 * @param {{ dshIm?: object }} deps
 * @returns {Promise<{ sessionId: string, via: string } | null>}
 */
export async function resolveMirrorSession(job, deps = {}) {
  const dshIm = deps.dshIm
  const origin = normalizeOrigin(job?.origin)
  const delivery = job?.delivery

  if (origin?.peer?.botId && origin.peer.conversationKey
    && dshIm && typeof dshIm.resolveConversationSession === 'function') {
    try {
      const hit = await dshIm.resolveConversationSession(
        origin.peer.botId,
        origin.peer.conversationKey,
      )
      const sessionId = typeof hit?.sessionId === 'string' ? hit.sessionId.trim() : ''
      if (sessionId) return { sessionId, via: 'conversation' }
    } catch {
      // try target / origin fallbacks
    }
  }

  if (delivery?.kind === 'im' && delivery.botId && delivery.targetId
    && dshIm && typeof dshIm.resolveTargetSession === 'function') {
    try {
      const hit = await dshIm.resolveTargetSession(delivery.botId, delivery.targetId)
      const sessionId = typeof hit?.sessionId === 'string' ? hit.sessionId.trim() : ''
      if (sessionId) return { sessionId, via: 'target' }
    } catch {
      // fall through
    }
  }

  if (origin?.sessionId) return { sessionId: origin.sessionId, via: 'origin' }
  return null
}

/**
 * Append the run summary into the effective origin/IM session without waking a turn.
 * Prefer a live agent; otherwise resume the persisted session (never create — that
 * id already belongs to the origin chat).
 * @param {object} job
 * @param {string} [summary]
 * @param {{
 *   dshIm?: object,
 *   getAgents?: () => object | undefined,
 *   pluginName?: string,
 *   newId?: () => string,
 * }} deps
 */
export async function mirrorRunToSession(job, summary, deps = {}) {
  const target = await resolveMirrorSession(job, deps)
  if (!target?.sessionId) {
    return { mirrored: false, skipped: true, reason: 'no_target' }
  }
  const agents = typeof deps.getAgents === 'function' ? deps.getAgents() : undefined
  if (!agents) {
    return {
      mirrored: false,
      skipped: true,
      reason: 'agents_unavailable',
      sessionId: target.sessionId,
      via: target.via,
    }
  }

  let agent = typeof agents.get === 'function' ? agents.get(target.sessionId) : null
  let resumed = false
  if (!agent && typeof agents.resume === 'function') {
    try {
      const handle = await agents.resume({ resumeSessionId: target.sessionId })
      agent = handle?.agent || null
      resumed = Boolean(agent)
    } catch (error) {
      return {
        mirrored: false,
        skipped: true,
        reason: 'session_unavailable',
        sessionId: target.sessionId,
        via: target.via,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
  if (!agent) {
    return {
      mirrored: false,
      skipped: true,
      reason: 'session_unavailable',
      sessionId: target.sessionId,
      via: target.via,
    }
  }

  const text = formatRunResultBody(job, summary)
  const plugin = typeof deps.pluginName === 'string' && deps.pluginName.trim()
    ? deps.pluginName.trim()
    : 'dsh-ops-cron'
  const id = typeof deps.newId === 'function' ? deps.newId() : `cron-mirror-${Date.now()}`
  const message = {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin },
  }

  try {
    if (typeof agent.session?.append === 'function') {
      agent.session.append('user/message', message, { surfaceOp: 'append' })
      return {
        mirrored: true,
        sessionId: target.sessionId,
        via: target.via,
        method: 'append',
        resumed,
      }
    }
    if (typeof agent.inject === 'function') {
      agent.inject(message)
      return {
        mirrored: true,
        sessionId: target.sessionId,
        via: target.via,
        method: 'inject',
        resumed,
      }
    }
  } catch (error) {
    return {
      mirrored: false,
      skipped: true,
      reason: 'mirror_failed',
      sessionId: target.sessionId,
      via: target.via,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  return {
    mirrored: false,
    skipped: true,
    reason: 'no_append',
    sessionId: target.sessionId,
    via: target.via,
  }
}
