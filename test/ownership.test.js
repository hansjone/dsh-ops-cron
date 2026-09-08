import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertCanAccessJob,
  canViewAllJobs,
  claimUnassignedForViewer,
  filterJobsForIdentity,
  filterRunsForJobs,
  inferOwnerEmpNo,
  jobVisibleToIdentity,
  migrateJobOwners,
  UNASSIGNED_OWNER,
  viewerPayload,
} from '../lib/ownership.js'

test('jobVisibleToIdentity respects canViewAll and owner', () => {
  const user = { empNo: 'u1', permissions: { canViewAllSessions: false } }
  const admin = { empNo: 'a1', permissions: { canViewAllSessions: true } }
  assert.equal(jobVisibleToIdentity({ ownerEmpNo: 'u1' }, user), true)
  assert.equal(jobVisibleToIdentity({ ownerEmpNo: 'u2' }, user), false)
  assert.equal(jobVisibleToIdentity({ ownerEmpNo: UNASSIGNED_OWNER }, user), true)
  assert.equal(jobVisibleToIdentity({ ownerEmpNo: UNASSIGNED_OWNER, cwd: '/data/user-workspaces/u2/x' }, user), false)
  assert.equal(jobVisibleToIdentity({ ownerEmpNo: UNASSIGNED_OWNER }, admin), true)
  assert.equal(canViewAllJobs(admin), true)
})

test('assertCanAccessJob throws NOT_FOUND for foreigners', () => {
  const user = { empNo: 'u1', permissions: { canViewAllSessions: false } }
  assert.throws(
    () => assertCanAccessJob({ id: 'j', ownerEmpNo: 'u2' }, user),
    (err) => err && err.code === 'NOT_FOUND',
  )
  assert.equal(assertCanAccessJob({ id: 'j', ownerEmpNo: 'u1' }, user).id, 'j')
})

test('filterJobsForIdentity and filterRunsForJobs', () => {
  const user = { empNo: 'u1', permissions: { canViewAllSessions: false } }
  const jobs = [
    { id: '1', ownerEmpNo: 'u1' },
    { id: '2', ownerEmpNo: 'u2' },
  ]
  const visible = filterJobsForIdentity(jobs, user)
  assert.deepEqual(visible.map((j) => j.id), ['1'])
  const runs = filterRunsForJobs([
    { id: 'r1', jobId: '1' },
    { id: 'r2', jobId: '2' },
  ], visible)
  assert.deepEqual(runs.map((r) => r.id), ['r1'])
})

test('inferOwnerEmpNo and migrateJobOwners', () => {
  assert.equal(inferOwnerEmpNo({ origin: { kind: 'im' } }), UNASSIGNED_OWNER)
  assert.equal(
    inferOwnerEmpNo({ origin: { kind: 'web', sessionId: 's' } }, { getSessionOwner: () => 'own' }),
    'own',
  )
  const { changed, state } = migrateJobOwners({
    jobs: [{ id: 'x', name: 'n' }],
  })
  assert.equal(changed, true)
  assert.equal(state.jobs[0].ownerEmpNo, UNASSIGNED_OWNER)
})

test('viewerPayload', () => {
  assert.equal(viewerPayload(null), null)
  const v = viewerPayload({
    empNo: 'u1',
    role: 'user',
    displayName: 'U',
    permissions: { canViewAllSessions: false },
    workspacePath: '/w/u1',
  })
  assert.equal(v.empNo, 'u1')
  assert.equal(v.canViewAll, false)
  assert.equal(v.workspacePath, '/w/u1')
})

test('claimUnassignedForViewer claims by session owner or user-workspaces cwd', () => {
  const user = { empNo: 'u1', displayName: 'U1', permissions: { canViewAllSessions: false } }
  const state = {
    jobs: [
      { id: 'a', ownerEmpNo: UNASSIGNED_OWNER, origin: { kind: 'web', sessionId: 's1' }, cwd: '/tmp/other' },
      { id: 'b', ownerEmpNo: UNASSIGNED_OWNER, cwd: '/data/user-workspaces/u1/proj' },
      { id: 'c', ownerEmpNo: UNASSIGNED_OWNER, cwd: '/data/user-workspaces/u2/proj' },
      { id: 'd', ownerEmpNo: 'u2', cwd: '/data/user-workspaces/u1/x' },
      { id: 'e', ownerEmpNo: UNASSIGNED_OWNER, origin: { kind: 'im', peer: { botId: 'b' } } },
      { id: 'f', ownerEmpNo: UNASSIGNED_OWNER, origin: { kind: 'web', sessionId: 'foreign' } },
    ],
  }
  const { changed, state: next } = claimUnassignedForViewer(state, user, {
    getSessionOwner: (id) => {
      if (id === 's1') return 'u1'
      if (id === 'foreign') return 'u2'
      return null
    },
  })
  assert.equal(changed, true)
  assert.equal(next.jobs[0].ownerEmpNo, 'u1')
  assert.equal(next.jobs[1].ownerEmpNo, 'u1')
  // Foreign user-workspaces path must not be stolen.
  assert.equal(next.jobs[2].ownerEmpNo, UNASSIGNED_OWNER)
  assert.equal(next.jobs[3].ownerEmpNo, 'u2')
  assert.equal(next.jobs[4].ownerEmpNo, UNASSIGNED_OWNER)
  assert.equal(next.jobs[5].ownerEmpNo, UNASSIGNED_OWNER)
})
