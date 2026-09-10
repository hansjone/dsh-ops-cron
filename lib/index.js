/**
 * dsh-ops-cron, node half.
 *
 * Durable scheduled jobs: create a fresh root Session on fire, hide that
 * session from the workspace list, and keep history under 定时任务.
 * Jobs may deliver summaries to IM via soft-injected ctx.dshIm.
 *
 * Do not list @deepseek-ai/* in package.json — resolve schemastery from the
 * live profile so we share the host's settings identity.
 */

import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { API_PREFIX, createHostService, defaultCwd, makeLiveSessionPort, PLUGIN_NAME } from './host.js'
import { DEFAULT_SETTINGS } from './store.js'
import { makeCronSkill, registerCronTools } from './tools.js'

export const name = PLUGIN_NAME
export const inject = []
export const NS = PLUGIN_NAME

export {
  adoptSessionIntoWorkspace,
  attachLiveSessionToWorkspace,
  bindModelSelection,
  createHostService,
  currentDefaultModel,
  listModelChoices,
  listWorkspaceChoices,
  makeLiveSessionPort,
  ownerAllowsForeignCwd,
  resolveDefaultModel,
  resolveJobModel,
  resolveSessionPlacement,
  waitForAgentTurn,
} from './host.js'
export { callerWorkingDirectory, callerModelSelection, registerCronTools, resolveCreateCwd, resolveCreateModel, resolveToolIdentity, scheduleFromArgs } from './tools.js'
export { decideDispatch, nextFire, parseCron, tickJobs, validateSchedule } from './scheduler.js'
export {
  applyRunIsolation,
  recordHiddenSession,
  shouldHideNativeWorkspaceGroup,
  shouldPromoteCronFork,
  workspaceTitleFromCronFork,
  workspaceVisibleIds,
} from './isolation.js'
export { wrapScheduledPrompt } from './prompt.js'
export { normalizeJobModel } from './store.js'
export {
  assertCanAccessJob,
  canViewAllJobs,
  claimUnassignedForViewer,
  filterJobsForIdentity,
  isElevatedCronRole,
  isMultiUserIdentity,
  jobVisibleToIdentity,
  LOCAL_EMP_NO,
  localIdentity,
  migrateJobOwners,
  preferredNewJobCwd,
  UNASSIGNED_OWNER,
  viewerPayload,
} from './ownership.js'
export { claimOccurrence, executeClaimedRun, extractAssistantText, TITLE_PREFIX } from './fire.js'
export {
  assertDeliveryAllowedForIdentity,
  deliverRunToIm,
  formatRunResultBody,
  jobVisibleToPeer,
  mirrorRunToSession,
  normalizeDelivery,
  normalizeOrigin,
  resolveCallerPeer,
  resolveCreateDelivery,
  resolveCreateOrigin,
  resolveMirrorSession,
} from './delivery.js'
export {
  DEFAULT_LOCALE,
  MESSAGES,
  TITLE_PREFIX_EN,
  apiError,
  normalizeLocale,
  resolveLocale,
  t,
} from './i18n.js'

function loadPkg(id) {
  const homes = [
    fileURLToPath(import.meta.url),
    join(process.cwd(), 'package.json'),
    join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', 'web', 'package.json'),
    join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', 'desktop', 'package.json'),
  ]
  const errors = []
  for (const from of homes) {
    try {
      return createRequire(from)(id)
    } catch (error) {
      errors.push(`${from}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`[dsh-ops-cron] cannot resolve ${id}\n${errors.join('\n')}`)
}

const SchemaMod = loadPkg('@deepseek-ai/schemastery')
const Schema = SchemaMod.default || SchemaMod

export const Config = Schema.object({
  enabled: Schema.boolean().default(DEFAULT_SETTINGS.enabled),
  timezone: Schema.string().default(DEFAULT_SETTINGS.timezone),
  historyLimit: Schema.number().min(10).max(2000).step(1).default(DEFAULT_SETTINGS.historyLimit),
  overlapPolicy: Schema.union(['skip']).default(DEFAULT_SETTINGS.overlapPolicy),
  misfirePolicy: Schema.union(['skip']).default(DEFAULT_SETTINGS.misfirePolicy),
})

function resolveConfig(config = {}) {
  return {
    enabled: config.enabled !== false,
    timezone: typeof config.timezone === 'string' && config.timezone.trim()
      ? config.timezone.trim()
      : DEFAULT_SETTINGS.timezone,
    historyLimit: Number(config.historyLimit) > 0 ? Number(config.historyLimit) : DEFAULT_SETTINGS.historyLimit,
    overlapPolicy: config.overlapPolicy === 'skip' ? 'skip' : DEFAULT_SETTINGS.overlapPolicy,
    misfirePolicy: config.misfirePolicy === 'skip' ? 'skip' : DEFAULT_SETTINGS.misfirePolicy,
  }
}

function tryGet(ctx, name) {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

function registerWebRoute(ctx, handler) {
  const register = (server) => {
    const off = server.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler,
    })
    return () => off()
  }
  const present = tryGet(ctx, 'webServer')
  if (present !== undefined) return register(present)
  const disposers = []
  let registered = false
  const off = ctx.on('internal/service', (serviceName, value) => {
    if (serviceName !== 'webServer' || registered) return
    registered = true
    disposers.push(register(value))
  })
  return () => {
    off()
    for (const dispose of disposers) dispose()
  }
}

export function apply(ctx, config = {}) {
  const entry = resolveConfig(config)
  const getDshIm = () => tryGet(ctx, 'dshIm')
  const getAgents = () => tryGet(ctx, 'agents')
  const getAgentPresets = () => tryGet(ctx, 'agentPresets')
  const getUdsAuth = () => tryGet(ctx, 'udsAuth')
  const service = createHostService({
    sessionPort: makeLiveSessionPort(ctx),
    getDshIm,
    getAgents,
    getUdsAuth,
    logger: ctx.logger,
  })

  ctx.inject(['settings'], (sctx) => {
    sctx.settings.register(NS, Config, { base: entry, applies: 'live' })
    sctx.logger?.info?.(`[dsh-ops-cron] settings namespace "${NS}" registered`)
  })

  ctx.inject(['tools'], (tctx) => {
    registerCronTools(tctx, service, { getDshIm, getAgentPresets })
    tctx.logger?.info?.('[dsh-ops-cron] tools cron_create/list/pause/resume/delete registered')
  })

  ctx.inject(['skills'], (sctx) => {
    if (typeof sctx.skills?.register === 'function') {
      sctx.skills.register(makeCronSkill())
    }
  })

  ctx.effect(() => {
    const off = ctx.on('internal/service', (serviceName, value) => {
      if (serviceName !== 'settings' || !value?.watch) return
      try {
        const unwatch = value.watch(NS, (next) => {
          service.updateSettings(resolveConfig(next)).catch(() => {})
        })
        if (typeof unwatch === 'function') {
          // Replaced when the effect disposes.
        }
      } catch {
        // watch is optional.
      }
    })
    return () => off()
  }, 'dsh-ops-cron: settings watch')

  ctx.effect(() => registerWebRoute(ctx, (req, res) => {
    service.handleRequest(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'internal error' }))
      }
    })
  }), 'dsh-ops-cron: web route')

  ctx.effect(() => {
    let stopped = false
    mkdir(defaultCwd(), { recursive: true }).catch(() => {})
    service.recover()
      .then(() => service.updateSettings(entry))
      .then(() => {
        if (stopped) return
        service.startTimer()
        return service.tick()
      })
      .catch((error) => {
        ctx.logger?.warn?.(`[dsh-ops-cron] recover failed: ${error instanceof Error ? error.message : error}`)
      })
    return () => {
      stopped = true
      service.stopTimer()
    }
  }, 'dsh-ops-cron: scheduler')

  ctx.logger?.info?.('[dsh-ops-cron] host ready')
}
