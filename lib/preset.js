/**
 * Resolve which Agent Preset a cron job should mount.
 * Priority: explicit args → IM session peer → creating session meta → Host default.
 */

import { callerSessionId } from './delivery.js'

const PRESET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeAgentPresetId(value) {
  if (typeof value !== 'string') return ''
  const id = value.trim()
  if (!id) return ''
  if (!PRESET_ID.test(id)) {
    const error = new Error('agentPreset must be a short alphanumeric id')
    error.code = 'INVALID_JOB'
    throw error
  }
  return id
}

function sessionMetaPreset(exec) {
  const meta = exec?.agent?.session?.meta
    || exec?.agent?.meta
    || exec?.session?.meta
    || null
  if (!meta || typeof meta !== 'object') return ''
  const raw = meta.agentPreset ?? meta.agent_preset
  return typeof raw === 'string' ? raw.trim() : ''
}

/**
 * @param {object} args
 * @param {object} exec
 * @param {{ dshIm?: object, agentPresets?: object }} deps
 * @returns {Promise<string>} empty string means "Host default at fire time"
 */
export async function resolveCreateAgentPreset(args = {}, exec = {}, deps = {}) {
  const explicit = typeof args.agent_preset === 'string' ? args.agent_preset.trim()
    : (typeof args.agentPreset === 'string' ? args.agentPreset.trim() : '')
  if (explicit) return normalizeAgentPresetId(explicit)

  const dshIm = deps.dshIm
  const sessionId = callerSessionId(exec)
  if (sessionId && dshIm && typeof dshIm.resolveSessionPeer === 'function') {
    try {
      const peer = await dshIm.resolveSessionPeer(sessionId)
      const fromPeer = typeof peer?.agentPreset === 'string' ? peer.agentPreset.trim() : ''
      if (fromPeer) return normalizeAgentPresetId(fromPeer)
    } catch {
      // fall through
    }
  }

  const fromSession = sessionMetaPreset(exec)
  if (fromSession) {
    try {
      return normalizeAgentPresetId(fromSession)
    } catch {
      // ignore invalid session meta
    }
  }

  const presets = deps.agentPresets
  if (presets && typeof presets.resolve === 'function') {
    try {
      const resolved = await presets.resolve()
      const id = typeof resolved?.id === 'string' ? resolved.id.trim() : ''
      return id ? normalizeAgentPresetId(id) : ''
    } catch {
      return ''
    }
  }
  return ''
}
