/** Shared run status constants — keep free of fire/monitor imports. */

export const ACTIVE_RUN_STATUSES = new Set(['queued', 'running'])

export const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'skipped'])
