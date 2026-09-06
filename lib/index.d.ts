import type { Context } from '@deepseek-ai/cordis'

export const name: 'dsh-ops-cron'
export const inject: string[]
export const NS: 'dsh-ops-cron'

export interface Config {
  enabled?: boolean
  timezone?: string
  historyLimit?: number
  overlapPolicy?: 'skip'
  misfirePolicy?: 'skip'
}

export function apply(ctx: Context, config?: Config): void
export function createHostService(options?: object): object
export function makeLiveSessionPort(ctx: object): object
export function resolveSessionPlacement(ctx: object, job?: object): { cwd: string, workspace: object | null }
export function listWorkspaceChoices(ctx: object): Array<{ id: string, title: string, path: string }>
export function listModelChoices(ctx: object): Promise<{ groups: Array<{ provider: string, displayName: string, models: Array<{ id: string, name: string }> }>, current: { provider: string, model: string, reasoningEffort?: string } | null }>
export function resolveJobModel(ctx: object, job?: object): Promise<{ provider: string, model: string, reasoningEffort?: string }>
export function currentDefaultModel(ctx: object): { provider: string, model: string, reasoningEffort?: string } | null
export function normalizeJobModel(input?: object): { provider: string, model: string, reasoningEffort: string }
export function callerWorkingDirectory(exec?: object): string
export function resolveCreateCwd(args?: object, exec?: object): string
export function resolveCreateModel(args?: object, exec?: object): { provider: string, model: string, reasoningEffort: string }
export function callerModelSelection(exec?: object): { provider: string, model: string, reasoningEffort: string }
export function scheduleFromArgs(args?: object, nowMs?: number): { kind: string, at?: string, expr?: string, timezone: string }
export function adoptSessionIntoWorkspace(ctx: object, sessionId: string): Promise<{ ok: boolean, attached: boolean, sessionId?: string, cwd?: string | null, workspaceId?: string | null }>
export function shouldHideNativeWorkspaceGroup(input: { sessionRowCount: number, visibleSessionCount: number, ungrouped?: boolean, cronLabeled?: boolean }): boolean
export function waitForAgentTurn(agent: object, options?: object): Promise<object>
export function parseCron(expr: string): object
export function nextFire(schedule: object, afterMs: number, timezone?: string): number | null
export function decideDispatch(input: object): object
export function workspaceVisibleIds(allSessionIds: string[], hiddenSessionIds: string[] | Set<string>, archivedSessionIds?: string[] | Set<string>): string[]
export function recordHiddenSession(state: object, sessionId: string): object
export function workspaceTitleFromCronFork(title: string): string
export function shouldPromoteCronFork(row: object, cronSessionIds: string[] | Set<string>, previousId?: string): boolean
export function wrapScheduledPrompt(prompt: string, meta?: object): string
export function extractAssistantText(messages: object[], maxChars?: number): string
export const TITLE_PREFIX: string
export function claimOccurrence(state: object, jobId: string, now: number, trigger: string, policies?: object): object
export function executeClaimedRun(state: object, runId: string, deps: object): Promise<object>
export function normalizeDelivery(input?: object): { kind: 'dsh' | 'im', botId?: string, targetId?: string }
export function normalizeOrigin(input?: object): { kind: 'web' | 'im', sessionId?: string, peer?: object } | null
export function resolveCreateDelivery(args?: object, exec?: object, deps?: object): Promise<{ kind: 'dsh' | 'im', botId?: string, targetId?: string }>
export function resolveCreateOrigin(args?: object, exec?: object, deps?: object): Promise<{ kind: 'web' | 'im', sessionId?: string, peer?: object } | null>
export function resolveMirrorSession(job: object, deps?: object): Promise<{ sessionId: string, via: string } | null>
export function formatRunResultBody(job: object, summary?: string): string
export function deliverRunToIm(job: object, summary?: string, deps?: object): Promise<object>
export function mirrorRunToSession(job: object, summary?: string, deps?: object): Promise<object>
