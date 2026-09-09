import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MESSAGES,
  apiError,
  formatRunResultBody,
  normalizeLocale,
  resolveLocale,
  t,
  workspaceTitleFromCronFork,
} from '../lib/index.js'

describe('dsh-ops-cron i18n', () => {
  it('normalizes locales', () => {
    assert.equal(normalizeLocale('en-US'), 'en')
    assert.equal(normalizeLocale('zh-CN'), 'zh')
    assert.equal(normalizeLocale(''), 'zh')
  })

  it('translates API and delivery keys', () => {
    assert.equal(t('err.login_required', 'zh'), '登录后才能使用定时任务')
    assert.equal(t('err.login_required', 'en'), 'Sign in to use scheduled tasks')
    assert.equal(t('tool.create', 'en'), 'Create scheduled task')
  })

  it('interpolates delivery vars', () => {
    assert.match(t('delivery.header', 'zh', { name: '晨报' }), /晨报/)
    assert.match(t('delivery.header', 'en', { name: 'Daily' }), /Daily/)
  })

  it('returns stable API error codes with localized message', () => {
    const zh = apiError('login_required', 'zh')
    const en = apiError('login_required', 'en')
    assert.equal(zh.error, 'login_required')
    assert.equal(en.error, 'login_required')
    assert.equal(zh.ok, false)
    assert.equal(zh.message, '登录后才能使用定时任务')
    assert.equal(en.message, 'Sign in to use scheduled tasks')
  })

  it('resolves locale from Accept-Language', () => {
    assert.equal(resolveLocale({ headers: { 'accept-language': 'en-US,en;q=0.9' } }), 'en')
    assert.equal(resolveLocale({ headers: { 'accept-language': 'zh-CN' } }), 'zh')
  })

  it('formatRunResultBody respects locale', () => {
    const zh = formatRunResultBody({ name: '晨报' }, 'ok', 'zh')
    const en = formatRunResultBody({ name: 'Daily' }, 'ok', 'en')
    assert.match(zh, /^【定时任务 · 晨报】\n/)
    assert.match(en, /^\[Scheduled tasks · Daily\]\n/)
  })

  it('strips English title prefix on fork promote', () => {
    assert.equal(workspaceTitleFromCronFork('Scheduled tasks · Daily (1)'), 'Daily (1)')
  })

  it('zh and en tables share the same keys', () => {
    const zhKeys = Object.keys(MESSAGES.zh).sort()
    const enKeys = Object.keys(MESSAGES.en).sort()
    assert.deepEqual(zhKeys, enKeys)
  })
})
