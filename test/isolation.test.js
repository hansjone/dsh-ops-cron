import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyRunIsolation,
  isHiddenFromWorkspace,
  recordHiddenSession,
  shouldHideNativeWorkspaceGroup,
  shouldPromoteCronFork,
  workspaceTitleFromCronFork,
  workspaceVisibleIds,
} from '../lib/isolation.js'
import { extractAssistantText } from '../lib/fire.js'

test('recording a run marks that session id hidden from the workspace-list projection and present in history', () => {
  const sessionId = 'sess-cron-1'
  const run = {
    id: 'run-1',
    jobId: 'job-1',
    sessionId,
    status: 'succeeded',
    scheduledAt: 1,
    actualAt: 2,
  }
  const state = applyRunIsolation({ hiddenSessionIds: [], runs: [] }, run)
  assert.equal(isHiddenFromWorkspace(sessionId, state.hiddenSessionIds), true)
  assert.ok(state.runs.some((row) => row.id === run.id && row.sessionId === sessionId))
  const visible = workspaceVisibleIds(['sess-cron-1', 'sess-human-2'], state.hiddenSessionIds)
  assert.deepEqual(visible, ['sess-human-2'])
  assert.ok(!visible.includes(sessionId))
})

test('recordHiddenSession is idempotent and does not drop other hidden ids', () => {
  let state = recordHiddenSession({ hiddenSessionIds: ['a'] }, 'b')
  state = recordHiddenSession(state, 'b')
  assert.deepEqual([...state.hiddenSessionIds].sort(), ['a', 'b'])
})

test('shouldHideNativeWorkspaceGroup does not hide a collapsed 未分组 that still has members', () => {
  assert.equal(shouldHideNativeWorkspaceGroup({
    sessionRowCount: 0,
    visibleSessionCount: 0,
    ungrouped: true,
  }), false)
  assert.equal(shouldHideNativeWorkspaceGroup({
    sessionRowCount: 2,
    visibleSessionCount: 0,
    ungrouped: true,
  }), true)
  assert.equal(shouldHideNativeWorkspaceGroup({
    sessionRowCount: 2,
    visibleSessionCount: 1,
    ungrouped: true,
  }), false)
})

test('workspaceTitleFromCronFork drops the scheduler prefix that hideNativeCronRows keys on', () => {
  assert.equal(workspaceTitleFromCronFork('定时任务 · 晨报 (1)'), '晨报 (1)')
  assert.equal(workspaceTitleFromCronFork('定时任务 · 晨报'), '晨报')
  assert.equal(workspaceTitleFromCronFork('普通会话'), '普通会话')
})

test('shouldPromoteCronFork treats a native fork of a run session as a workspace chat', () => {
  const cronIds = new Set(['run-sess'])
  assert.equal(shouldPromoteCronFork({ id: 'run-sess', title: '定时任务 · 晨报' }, cronIds), false)
  assert.equal(shouldPromoteCronFork({
    id: 'child-sess',
    parentId: 'run-sess',
    title: '定时任务 · 晨报 (1)',
  }, cronIds), true)
  assert.equal(shouldPromoteCronFork({
    id: 'child-sess',
    title: '定时任务 · 晨报 (1)',
  }, cronIds, 'run-sess'), true)
  assert.equal(shouldPromoteCronFork({
    id: 'unrelated',
    title: '别的对话',
  }, cronIds, 'run-sess'), false)
})

test('extractAssistantText returns the last assistant text, not a dispatch stub', () => {
  const text = extractAssistantText([
    { role: 'user', content: [{ type: 'text', text: 'say 测试成功' }] },
    { role: 'assistant', content: [{ type: 'text', text: '测试成功' }] },
  ])
  assert.equal(text, '测试成功')
  assert.equal(extractAssistantText([]), '')
  assert.equal(extractAssistantText([{ role: 'assistant', content: [{ type: 'thinking', text: 'hmm' }] }]), '')
})
