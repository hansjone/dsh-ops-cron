/**
 * Pure schedule math: 5-field cron, one-shot `at`, overlap, misfire.
 * No Cordis imports — tests call these with a fake clock.
 */

const MONTH_NAMES = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

const DOW_NAMES = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
}

const WEEKDAY_FROM_SHORT = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
}

export const DEFAULT_GRACE_MS = 60_000
export const OVERLAP_STATUSES = new Set(['queued', 'running'])

/**
 * @param {string} expr
 * @returns {{ minute: Set<number>, hour: Set<number>, dayOfMonth: Set<number>, month: Set<number>, dayOfWeek: Set<number>, raw: string }}
 */
export function parseCron(expr) {
  if (typeof expr !== 'string') throw invalidCron('cron must be a string')
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) throw invalidCron('cron must have exactly 5 fields (minute hour day-of-month month day-of-week)')
  const minute = parseField(parts[0], 0, 59, null, 'minute')
  const hour = parseField(parts[1], 0, 23, null, 'hour')
  const dayOfMonth = parseField(parts[2], 1, 31, null, 'day-of-month')
  const month = parseField(parts[3], 1, 12, MONTH_NAMES, 'month')
  const dayOfWeek = parseField(parts[4], 0, 7, DOW_NAMES, 'day-of-week')
  if (dayOfWeek.has(7)) {
    dayOfWeek.add(0)
    dayOfWeek.delete(7)
  }
  return { minute, hour, dayOfMonth, month, dayOfWeek, raw: parts.join(' ') }
}

function invalidCron(message) {
  const error = new Error(message)
  error.code = 'INVALID_CRON'
  return error
}

function parseField(field, min, max, names, label) {
  if (field === undefined || field === '') throw invalidCron(`empty ${label} field`)
  const values = new Set()
  for (const item of field.split(',')) {
    const token = item.trim()
    if (!token) throw invalidCron(`empty list item in ${label}`)
    const [rangePart, stepPart] = token.split('/')
    const step = stepPart === undefined ? 1 : Number(stepPart)
    if (!Number.isInteger(step) || step < 1) throw invalidCron(`invalid step in ${label}`)
    let start
    let end
    if (rangePart === '*') {
      start = min
      end = max
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-')
      start = parseAtom(a, min, max, names, label)
      end = parseAtom(b, min, max, names, label)
      if (start > end) throw invalidCron(`inverted range in ${label}`)
    } else {
      start = parseAtom(rangePart, min, max, names, label)
      end = stepPart === undefined ? start : max
    }
    for (let value = start; value <= end; value += step) values.add(value)
  }
  if (values.size === 0) throw invalidCron(`no values in ${label}`)
  return values
}

function parseAtom(raw, min, max, names, label) {
  const token = String(raw || '').trim().toLowerCase()
  let value
  if (names && names[token] !== undefined) value = names[token]
  else {
    if (!/^\d+$/.test(token)) throw invalidCron(`invalid ${label} value "${raw}"`)
    value = Number(token)
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    throw invalidCron(`${label} value ${raw} out of range ${min}-${max}`)
  }
  return value
}

/**
 * @param {unknown} schedule
 * @returns {{ kind: 'cron', expr: string, timezone: string, parsed: ReturnType<typeof parseCron> } | { kind: 'at', at: number, timezone: string }}
 */
export function validateSchedule(schedule, fallbackTimezone = 'UTC') {
  if (!schedule || typeof schedule !== 'object') {
    const error = new Error('schedule is required')
    error.code = 'INVALID_SCHEDULE'
    throw error
  }
  const kind = schedule.kind
  const timezone = assertTimeZone(schedule.timezone || fallbackTimezone)
  if (kind === 'cron') {
    const parsed = parseCron(schedule.expr)
    return { kind: 'cron', expr: parsed.raw, timezone, parsed }
  }
  if (kind === 'at') {
    const at = parseAt(schedule.at, timezone)
    return { kind: 'at', at, timezone }
  }
  const error = new Error('schedule.kind must be "cron" or "at"')
  error.code = 'INVALID_SCHEDULE'
  throw error
}

export function parseAt(value, timeZone) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value <= 0) {
      const error = new Error('at timestamp must be positive')
      error.code = 'INVALID_AT'
      throw error
    }
    return Math.round(value)
  }
  if (typeof value !== 'string' || !value.trim()) {
    const error = new Error('at must be an ISO 8601 timestamp')
    error.code = 'INVALID_AT'
    throw error
  }
  const raw = value.trim()
  const timeOnly = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (timeOnly && timeZone) {
    return resolveTodayAt(Number(timeOnly[1]), Number(timeOnly[2]), timeZone)
  }
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const ms = Date.parse(raw)
    if (!Number.isFinite(ms)) {
      const error = new Error(`invalid at timestamp: ${value}`)
      error.code = 'INVALID_AT'
      throw error
    }
    return ms
  }
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/)
  if (match && timeZone) {
    const utc = zonedToUtc({
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4]),
      minute: Number(match[5]),
      second: Number(match[6] || 0),
    }, timeZone)
    if (utc == null) {
      const error = new Error(`invalid local time ${raw} in ${timeZone}`)
      error.code = 'INVALID_AT'
      throw error
    }
    return utc
  }
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) {
    const error = new Error(`invalid at timestamp: ${value}`)
    error.code = 'INVALID_AT'
    throw error
  }
  return ms
}

export function formatInZone(ms, timeZone) {
  if (!Number.isFinite(ms)) return ''
  const zone = timeZone || 'UTC'
  const p = partsInZone(ms, zone)
  const pad = (n) => String(n).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} ${zone}`
}

/**
 * One-shot wall clock today in `timeZone`. If that instant is already past,
 * roll to the next calendar day (for "tonight 23:34" said after 23:34).
 */
export function resolveTodayAt(hour, minute, timeZone, nowMs = Date.now()) {
  const tz = assertTimeZone(timeZone || 'Asia/Shanghai')
  const h = Number(hour)
  const min = Number(minute)
  if (!Number.isInteger(h) || h < 0 || h > 23) {
    const error = new Error('hour must be an integer 0-23')
    error.code = 'INVALID_AT'
    throw error
  }
  if (!Number.isInteger(min) || min < 0 || min > 59) {
    const error = new Error('minute must be an integer 0-59')
    error.code = 'INVALID_AT'
    throw error
  }
  const now = partsInZone(nowMs, tz)
  let utc = zonedToUtc({
    year: now.year, month: now.month, day: now.day, hour: h, minute: min, second: 0,
  }, tz)
  if (utc == null) {
    const error = new Error(`invalid local time ${h}:${String(min).padStart(2, '0')} in ${tz}`)
    error.code = 'INVALID_AT'
    throw error
  }
  if (utc <= nowMs) {
    const next = partsInZone(utc + 24 * 3600 * 1000, tz)
    utc = zonedToUtc({
      year: next.year, month: next.month, day: next.day, hour: h, minute: min, second: 0,
    }, tz)
  }
  return utc
}

export function assertTimeZone(timeZone) {
  const name = String(timeZone || '').trim()
  if (!name) {
    const error = new Error('timezone is required')
    error.code = 'INVALID_TIMEZONE'
    throw error
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name }).format(new Date(0))
  } catch {
    const error = new Error(`unknown IANA timezone: ${name}`)
    error.code = 'INVALID_TIMEZONE'
    throw error
  }
  return name
}

/**
 * Wall-clock parts of `ms` in `timeZone`.
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number, weekday: number }}
 */
export function partsInZone(ms, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  })
  const map = {}
  for (const part of dtf.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') map[part.type] = part.value
  }
  const weekday = WEEKDAY_FROM_SHORT[map.weekday]
  if (weekday === undefined) throw new Error(`cannot read weekday in ${timeZone}`)
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
    weekday,
  }
}

/**
 * Convert a local wall time in `timeZone` to UTC epoch ms.
 * DST gaps return null (that local time does not exist).
 */
export function zonedToUtc(parts, timeZone) {
  const utcGuess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0)
  const asZone = partsInZone(utcGuess, timeZone)
  const asZoneUtc = Date.UTC(asZone.year, asZone.month - 1, asZone.day, asZone.hour, asZone.minute, asZone.second)
  const result = utcGuess - (asZoneUtc - utcGuess)
  const check = partsInZone(result, timeZone)
  if (
    check.year !== parts.year
    || check.month !== parts.month
    || check.day !== parts.day
    || check.hour !== parts.hour
    || check.minute !== parts.minute
  ) {
    return null
  }
  return result
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function cronMatches(parsed, parts) {
  if (!parsed.minute.has(parts.minute)) return false
  if (!parsed.hour.has(parts.hour)) return false
  if (!parsed.month.has(parts.month)) return false
  const domStar = parsed.dayOfMonth.size === 31
  const dowStar = parsed.dayOfWeek.size === 7
  const domHit = parsed.dayOfMonth.has(parts.day)
  const dowHit = parsed.dayOfWeek.has(parts.weekday)
  if (!domStar && !dowStar) return domHit || dowHit
  if (!domStar && !domHit) return false
  if (!dowStar && !dowHit) return false
  return true
}

/**
 * Next fire strictly after `afterMs`. Returns epoch ms, or null if none
 * (one-shot `at` already passed, or cron search exhausted).
 */
export function nextFire(schedule, afterMs, fallbackTimezone = 'UTC') {
  const spec = schedule.parsed && schedule.kind === 'cron'
    ? schedule
    : validateSchedule(schedule, fallbackTimezone)
  const after = Number(afterMs)
  if (!Number.isFinite(after)) throw new Error('afterMs must be a number')
  if (spec.kind === 'at') return spec.at > after ? spec.at : null
  return nextCronFire(spec.parsed, spec.timezone, after)
}

function nextCronFire(parsed, timeZone, afterMs) {
  const start = partsInZone(afterMs, timeZone)
  // Next whole local minute strictly after afterMs.
  let year = start.year
  let month = start.month
  let day = start.day
  let hour = start.hour
  let minute = start.minute + 1
  const limitYear = year + 5
  while (year <= limitYear) {
    if (!parsed.month.has(month)) {
      month += 1
      day = 1
      hour = 0
      minute = 0
      if (month > 12) {
        month = 1
        year += 1
      }
      continue
    }
    const dim = daysInMonth(year, month)
    if (day > dim) {
      day = 1
      hour = 0
      minute = 0
      month += 1
      if (month > 12) {
        month = 1
        year += 1
      }
      continue
    }
    if (hour > 23) {
      hour = 0
      minute = 0
      day += 1
      continue
    }
    if (minute > 59) {
      minute = 0
      hour += 1
      continue
    }
    const utc = zonedToUtc({ year, month, day, hour, minute, second: 0 }, timeZone)
    if (utc === null) {
      minute += 1
      continue
    }
    if (utc <= afterMs) {
      minute += 1
      continue
    }
    const weekday = partsInZone(utc, timeZone).weekday
    if (cronMatches(parsed, { minute, hour, day, month, weekday })) return utc
    minute += 1
  }
  return null
}

export function hasOverlap(runs, jobId) {
  if (!Array.isArray(runs)) return false
  return runs.some((run) => (
    run
    && run.jobId === jobId
    && OVERLAP_STATUSES.has(run.status)
  ))
}

/**
 * Decide whether a job should fire at `now`.
 * At most one occurrence is returned — missed ticks are never expanded into a backlog.
 *
 * @param {object} input
 * @param {object} input.job
 * @param {object[]} [input.runs]
 * @param {number} input.now
 * @param {'skip'} [input.overlapPolicy]
 * @param {'skip'} [input.misfirePolicy]
 * @param {number} [input.graceMs]
 */
export function decideDispatch(input) {
  const job = input?.job
  const now = Number(input?.now)
  if (!job || typeof job !== 'object') throw new Error('job is required')
  if (!Number.isFinite(now)) throw new Error('now must be a number')
  const overlapPolicy = input.overlapPolicy || 'skip'
  const misfirePolicy = input.misfirePolicy || 'skip'
  const graceMs = Number.isFinite(input.graceMs) ? input.graceMs : DEFAULT_GRACE_MS
  const timezone = job.schedule?.timezone
  if (job.nextRunAt === null) {
    return { action: 'wait', reason: 'complete', nextRunAt: null }
  }
  const due = Number.isFinite(job.nextRunAt) ? job.nextRunAt : nextFire(job.schedule, job.createdAt || now, timezone)

  if (job.enabled === false) {
    return { action: 'wait', reason: 'disabled', nextRunAt: due ?? null }
  }
  if (due == null) {
    return { action: 'wait', reason: 'complete', nextRunAt: null }
  }
  if (due > now) {
    return { action: 'wait', reason: 'not-due', nextRunAt: due }
  }
  if (overlapPolicy === 'skip' && hasOverlap(input.runs, job.id)) {
    const nextRunAt = advanceAfter(job.schedule, Math.max(due, now), timezone)
    return { action: 'skip', reason: 'overlap', scheduledAt: due, nextRunAt }
  }
  if (misfirePolicy === 'skip' && now - due > graceMs) {
    const nextRunAt = advanceAfter(job.schedule, now, timezone)
    return { action: 'skip', reason: 'misfire', scheduledAt: due, nextRunAt }
  }
  const nextRunAt = advanceAfter(job.schedule, Math.max(due, now), timezone)
  return { action: 'fire', scheduledAt: due, nextRunAt }
}

function advanceAfter(schedule, afterMs, timezone) {
  if (schedule?.kind === 'at') return null
  return nextFire(schedule, afterMs, timezone)
}

/**
 * Scan jobs at `now` and return at most one action per job.
 * Never expands a downtime gap into N queued occurrences.
 */
export function tickJobs(jobs, runsByJobId, now, policies = {}) {
  const out = []
  for (const job of jobs || []) {
    const runs = runsByJobId?.get?.(job.id) || runsByJobId?.[job.id] || []
    const decision = decideDispatch({
      job,
      runs,
      now,
      overlapPolicy: policies.overlapPolicy,
      misfirePolicy: policies.misfirePolicy,
      graceMs: policies.graceMs,
    })
    out.push({ jobId: job.id, ...decision })
  }
  return out
}
