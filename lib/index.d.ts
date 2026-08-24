import type { Context } from '@deepseek-ai/cordis'

export const name: 'dsh-cron-tasks'
export const inject: string[]
export const NS: 'dsh-cron-tasks'

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
export function callerWorkingDirectory(exec?: object): string
export function resolveCreateCwd(args?: object, exec?: object): string
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
