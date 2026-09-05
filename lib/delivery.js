/**
 * Job delivery: DSH sidebar session vs proactive IM (botId + targetId).
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
    return { kind: 'im', botId, targetId }
  }
  return { kind: 'dsh' }
}

export function deliveryLine(delivery) {
  if (!delivery || delivery.kind !== 'im') return 'delivery=dsh'
  return `delivery=im botId=${delivery.botId} targetId=${delivery.targetId}`
}

/**
 * Match a delivery target whose route overlaps the channel peer conversation.
 * @param {Array<object>} targets
 * @param {object|null} peer - from dshIm.resolveSessionPeer
 */
export function matchTargetForPeer(targets, peer) {
  if (!peer || !Array.isArray(targets) || targets.length === 0) return null
  const key = String(peer.conversationKey || '').trim()
  const jidFromKey = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key
  const peerJid = String(peer.jid || peer.route?.jid || jidFromKey || '').trim().toLowerCase()
  if (!peerJid) return null
  for (const target of targets) {
    const route = target?.route && typeof target.route === 'object' ? target.route : {}
    const jid = String(route.jid || route.chatId || route.openId || route.userId || '').trim().toLowerCase()
    if (jid && (jid === peerJid || peerJid.endsWith(jid) || jid.endsWith(peerJid))) {
      return target
    }
  }
  return null
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
 * Resolve delivery for cron_create: explicit args win; else IM peer → matching target; else dsh.
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
      if (peer?.botId && typeof dshIm.listTargets === 'function') {
        const targets = await dshIm.listTargets(peer.botId)
        const match = matchTargetForPeer(targets, peer)
        if (match?.targetId) {
          return normalizeDelivery({
            kind: 'im',
            botId: peer.botId,
            targetId: String(match.targetId),
          })
        }
      }
    } catch {
      // fall through to dsh
    }
  }
  return normalizeDelivery({ kind: 'dsh' })
}

const IM_MAX_CHARS = 3500

/**
 * Send run summary to IM when job.delivery.kind === 'im'.
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
  const text = String(summary || '').trim() || `(定时任务「${job.name}」已完成，无文本摘要)`
  const clipped = text.length > IM_MAX_CHARS ? `${text.slice(0, IM_MAX_CHARS)}…` : text
  const header = `【运维定时 · ${job.name}】\n`
  await dshIm.send(delivery.botId, delivery.targetId, `${header}${clipped}`)
  return { sent: true }
}
