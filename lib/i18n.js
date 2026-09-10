/**
 * dsh-ops-cron i18n — API / delivery / tool card strings.
 * UI sidebar+settings strings live in lib/client.js (DSH locale.register shape).
 * Locales: zh (default), en.
 */

export const DEFAULT_LOCALE = 'zh'

/** Canonical session title prefix (stored on run sessions). */
export const TITLE_PREFIX = '定时任务 · '
/** Alternate English prefix — recognized when stripping / matching. */
export const TITLE_PREFIX_EN = 'Scheduled tasks · '

/** @type {Record<string, Record<string, string>>} */
export const MESSAGES = {
  zh: {
    'err.login_required': '登录后才能使用定时任务',
    'err.forbidden': '禁止访问',
    'err.not_found': '未找到',
    'err.run_not_found': '运行记录不存在',
    'err.session_id_required': '需要 sessionId',
    'err.payload_too_large': '请求体过大',
    'err.internal': '内部错误',

    'delivery.empty_summary': '（定时任务「{name}」已完成，无文本摘要）',
    'delivery.header': '【定时任务 · {name}】',
    'delivery.wa_group': 'WhatsApp 群聊',
    'delivery.wa_dm': 'WhatsApp 私聊',

    'tool.create': '创建定时任务',
    'tool.list': '列出定时任务',
    'tool.pause': '暂停定时任务',
    'tool.resume': '恢复定时任务',
    'tool.retrigger': '重新触发一次性任务',
    'tool.delete': '删除定时任务',
  },
  en: {
    'err.login_required': 'Sign in to use scheduled tasks',
    'err.forbidden': 'Forbidden',
    'err.not_found': 'Not found',
    'err.run_not_found': 'Run not found',
    'err.session_id_required': 'sessionId required',
    'err.payload_too_large': 'Payload too large',
    'err.internal': 'Internal error',

    'delivery.empty_summary': '(Scheduled task "{name}" finished with no text summary)',
    'delivery.header': '[Scheduled tasks · {name}]',
    'delivery.wa_group': 'WhatsApp group',
    'delivery.wa_dm': 'WhatsApp DM',

    'tool.create': 'Create scheduled task',
    'tool.list': 'List scheduled tasks',
    'tool.pause': 'Pause scheduled task',
    'tool.resume': 'Resume scheduled task',
    'tool.retrigger': 'Retrigger one-shot task',
    'tool.delete': 'Delete scheduled task',
  },
}

/**
 * @param {unknown} lang
 * @returns {'zh' | 'en'}
 */
export function normalizeLocale(lang) {
  const raw = String(lang || '').trim().toLowerCase()
  if (!raw) return DEFAULT_LOCALE
  if (raw.startsWith('en')) return 'en'
  if (raw.startsWith('zh')) return DEFAULT_LOCALE
  return DEFAULT_LOCALE
}

/**
 * @param {string} key
 * @param {'zh' | 'en' | string} [locale]
 * @param {Record<string, string | number>} [vars]
 */
export function t(key, locale = DEFAULT_LOCALE, vars = {}) {
  const loc = normalizeLocale(locale)
  const table = MESSAGES[loc] || MESSAGES[DEFAULT_LOCALE]
  let text = table[key] || MESSAGES[DEFAULT_LOCALE][key] || key
  for (const [k, v] of Object.entries(vars || {})) {
    text = text.split('{' + k + '}').join(String(v))
  }
  return text
}

function parseCookie(header, name) {
  if (!header) return null
  const prefix = name + '='
  for (const part of String(header).split(';')) {
    const v = part.trim()
    if (v.startsWith(prefix)) {
      try { return decodeURIComponent(v.slice(prefix.length)) } catch { return v.slice(prefix.length) }
    }
  }
  return null
}

/**
 * Resolve locale from HTTP request + optional identity.lang.
 * @param {import('node:http').IncomingMessage | null | undefined} req
 * @param {{ lang?: string } | null | undefined} [identity]
 */
export function resolveLocale(req, identity) {
  const headers = req?.headers || {}
  const cookie = headers.cookie || ''
  const fromIdentity = identity?.lang
  const fromHeader = headers['x-lang-id'] || headers['X-Lang-Id']
  const fromCookie = parseCookie(cookie, 'PORTALSSOLanguage')
    || parseCookie(cookie, 'ZTEDPGSSOLanguage')
  const accept = String(headers['accept-language'] || '').split(',')[0]
  return normalizeLocale(fromIdentity || fromHeader || fromCookie || accept || DEFAULT_LOCALE)
}

/**
 * API error payload: stable `error` code + localized `message`.
 * @param {string} code
 * @param {'zh' | 'en' | string} locale
 * @param {Record<string, string | number>} [vars]
 */
export function apiError(code, locale, vars) {
  const key = code.startsWith('err.') ? code : 'err.' + code
  return {
    ok: false,
    error: code.startsWith('err.') ? code.slice(4) : code,
    message: t(key, locale, vars),
  }
}
