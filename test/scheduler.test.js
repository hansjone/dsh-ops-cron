import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  decideDispatch,
  formatInZone,
  nextFire,
  parseCron,
  resolveTodayAt,
  tickJobs,
  validateSchedule,
  zonedToUtc,
} from '../lib/scheduler.js'

const TZ = 'Asia/Shanghai'

function shanghai(year, month, day, hour, minute) {
  const ms = zonedToUtc({ year, month, day, hour, minute, second: 0 }, TZ)
  assert.ok(ms != null, 'expected a real local time')
  return ms
}

test('valid 5-field cron next-fire in IANA timezone', () => {
  const schedule = { kind: 'cron', expr: '0 9 * * 1-5', timezone: TZ }
  const mondayMorning = shanghai(2026, 8, 24, 8, 15)
  const next = nextFire(schedule, mondayMorning)
  const expected = shanghai(2026, 8, 24, 9, 0)
  assert.equal(next, expected)
})

test('valid at next-fire is the instant when still in the future', () => {
  const at = shanghai(2026, 8, 24, 18, 30)
  const before = shanghai(2026, 8, 24, 10, 0)
  const next = nextFire({ kind: 'at', at: new Date(at).toISOString(), timezone: TZ }, before)
  assert.equal(next, at)
  const after = nextFire({ kind: 'at', at: new Date(at).toISOString(), timezone: TZ }, at)
  assert.equal(after, null)
})

test('invalid cron is rejected', () => {
  assert.throws(() => parseCron('not-a-cron'), (error) => error.code === 'INVALID_CRON')
  assert.throws(() => parseCron('* * *'), (error) => error.code === 'INVALID_CRON')
  assert.throws(() => parseCron('60 9 * * *'), (error) => error.code === 'INVALID_CRON')
  assert.throws(() => parseCron('0 9 * * 8'), (error) => error.code === 'INVALID_CRON')
})

test('overlap while a run is running or queued is skipped', () => {
  const now = shanghai(2026, 8, 24, 9, 0)
  const job = {
    id: 'job-overlap',
    enabled: true,
    schedule: { kind: 'cron', expr: '0 9 * * *', timezone: TZ },
    nextRunAt: now,
    createdAt: now - 86400000,
  }
  for (const status of ['running', 'queued']) {
    const decision = decideDispatch({
      job,
      runs: [{ jobId: 'job-overlap', status }],
      now,
      overlapPolicy: 'skip',
    })
    assert.equal(decision.action, 'skip')
    assert.equal(decision.reason, 'overlap')
  }
})

test('host-down misfire does not enqueue a backlog of old occurrences', () => {
  const now = shanghai(2026, 8, 24, 10, 0)
  const dueHourAgo = now - 60 * 60 * 1000
  const job = {
    id: 'job-misfire',
    enabled: true,
    schedule: { kind: 'cron', expr: '* * * * *', timezone: TZ },
    nextRunAt: dueHourAgo,
    createdAt: dueHourAgo - 1000,
  }
  const decision = decideDispatch({
    job,
    runs: [],
    now,
    misfirePolicy: 'skip',
    graceMs: 60_000,
  })
  assert.equal(decision.action, 'skip')
  assert.equal(decision.reason, 'misfire')
  assert.ok(decision.nextRunAt == null || decision.nextRunAt > now - 60_000)

  const actions = tickJobs([job], new Map([[job.id, []]]), now, {
    misfirePolicy: 'skip',
    graceMs: 60_000,
  })
  const fires = actions.filter((row) => row.action === 'fire')
  assert.equal(fires.length, 0, 'must not backfill each missed minute')
  assert.equal(actions.length, 1)
})

test('resolveTodayAt uses current calendar date and rolls to tomorrow when past', () => {
  const now = shanghai(2026, 8, 23, 23, 40)
  const later = resolveTodayAt(23, 50, TZ, now)
  assert.equal(later, shanghai(2026, 8, 23, 23, 50))
  const rolled = resolveTodayAt(23, 34, TZ, now)
  assert.equal(rolled, shanghai(2026, 8, 24, 23, 34))
})

test('ISO at instants display in Asia/Shanghai not as sliced UTC hours', () => {
  const at = Date.parse('2026-08-23T15:13:00.000Z')
  assert.equal(formatInZone(at, TZ), '2026-08-23 23:13 Asia/Shanghai')
})

test('naive at timestamp is interpreted in the schedule timezone, not UTC', () => {
  const schedule = validateSchedule({
    kind: 'at',
    at: '2026-08-23T22:55:00',
    timezone: TZ,
  }, TZ)
  assert.equal(schedule.at, shanghai(2026, 8, 23, 22, 55))
  assert.equal(formatInZone(schedule.at, TZ), '2026-08-23 22:55 Asia/Shanghai')
})

test('one-shot at fires once then waits as complete even if nextRunAt is null', () => {
  const at = shanghai(2026, 8, 23, 22, 57)
  const job = {
    id: 'at-once',
    enabled: true,
    schedule: { kind: 'at', at: new Date(at).toISOString(), timezone: TZ },
    nextRunAt: at,
    createdAt: at - 60_000,
  }
  const first = decideDispatch({ job, runs: [], now: at + 1000 })
  assert.equal(first.action, 'fire')
  assert.equal(first.nextRunAt, null)

  const after = { ...job, nextRunAt: null, lastRunAt: at + 12_000 }
  const second = decideDispatch({
    job: after,
    runs: [{ jobId: 'at-once', status: 'succeeded', scheduledAt: at }],
    now: at + 15_000,
  })
  assert.equal(second.action, 'wait')
  assert.equal(second.reason, 'complete')
})

test('one-shot misfire beyond grace skips and clears nextRunAt', () => {
  const at = shanghai(2026, 8, 23, 22, 57)
  const job = {
    id: 'at-miss',
    enabled: true,
    schedule: { kind: 'at', at: new Date(at).toISOString(), timezone: TZ },
    nextRunAt: at,
    createdAt: at - 60_000,
  }
  const decision = decideDispatch({
    job,
    runs: [],
    now: at + 5 * 60_000,
    misfirePolicy: 'skip',
    graceMs: 60_000,
  })
  assert.equal(decision.action, 'skip')
  assert.equal(decision.reason, 'misfire')
  assert.equal(decision.nextRunAt, null)
})

test('zonedToUtc resolves wall times right after a DST spring-forward', () => {
  // 2026-03-08 New York: 02:00 EST → 03:00 EDT. 04:00 exists (EDT, UTC-4).
  assert.equal(
    zonedToUtc({ year: 2026, month: 3, day: 8, hour: 4, minute: 0, second: 0 }, 'America/New_York'),
    Date.parse('2026-03-08T08:00:00.000Z'),
  )
  // 02:30 is in the gap and does not exist.
  assert.equal(
    zonedToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 }, 'America/New_York'),
    null,
  )
  const next = nextFire(
    { kind: 'cron', expr: '0 4 * * *', timezone: 'America/New_York' },
    Date.parse('2026-03-07T12:00:00.000Z'),
  )
  assert.equal(next, Date.parse('2026-03-08T08:00:00.000Z'))
})

test('nextFire stays fast for sparse and impossible expressions', () => {
  const after = shanghai(2026, 8, 24, 10, 0)
  const started = Date.now()
  const weekly = nextFire({ kind: 'cron', expr: '0 9 * * 1', timezone: TZ }, after)
  assert.equal(weekly, shanghai(2026, 8, 31, 9, 0))
  assert.equal(nextFire({ kind: 'cron', expr: '0 0 30 2 *', timezone: TZ }, after), null)
  assert.ok(Date.now() - started < 500, `took ${Date.now() - started}ms`)
})

test('nextFire matches a minute-by-minute brute force', () => {
  const exprs = ['*/7 * * * *', '15 3,15 * * *', '0 0 1,15 * 5', '30 2 * * 0', '0 9-17/2 * 1-6 1-5']
  const zones = [TZ, 'America/New_York', 'UTC']
  const after = Date.parse('2026-03-01T00:00:00.000Z')
  for (const timezone of zones) {
    for (const expr of exprs) {
      const parsed = parseCron(expr)
      let brute = null
      for (let ms = Math.floor(after / 60_000) * 60_000 + 60_000; ms < after + 40 * 86_400_000; ms += 60_000) {
        const p = new Intl.DateTimeFormat('en-US', {
          timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric',
          hour: 'numeric', minute: 'numeric', hourCycle: 'h23', weekday: 'short',
        }).formatToParts(new Date(ms)).reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {})
        const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday)
        const domStar = parsed.dayOfMonth.size === 31
        const dowStar = parsed.dayOfWeek.size === 7
        const domHit = parsed.dayOfMonth.has(Number(p.day))
        const dowHit = parsed.dayOfWeek.has(weekday)
        const dayOk = !domStar && !dowStar ? (domHit || dowHit) : ((domStar || domHit) && (dowStar || dowHit))
        if (parsed.minute.has(Number(p.minute)) && parsed.hour.has(Number(p.hour))
          && parsed.month.has(Number(p.month)) && dayOk) {
          brute = ms
          break
        }
      }
      assert.equal(nextFire({ kind: 'cron', expr, timezone }, after), brute, `${expr} @ ${timezone}`)
    }
  }
})
