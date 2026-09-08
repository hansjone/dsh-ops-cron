window.__ModuleLoader__.load({
  id: 'dsh-ops-cron',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const { useCallback, useEffect, useId, useRef, useState } = React
    let primitives = {}
    try { primitives = require('@deepseek-ai/dsh-client-ui-primitives') } catch { primitives = {} }
    if (primitives && primitives.default && typeof primitives.default === 'object') {
      primitives = { ...primitives.default, ...primitives }
    }
    function Ico(name, props) {
      const Comp = primitives[name]
      return Comp ? h(Comp, props || { size: 16 }) : null
    }
    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms))
    }
    function nativeScope() {
      const region = document.querySelector('[class*="regionArea"]')
      if (!region) return document.body || document.documentElement
      return [...region.children].find((el) => el.getAttribute('data-plugin') !== name) || region
    }
    function stealClass(suffix, fallback) {
      try {
        const re = new RegExp('(?:^|\\s)([A-Za-z0-9-]+_' + suffix + ')(?:\\s|$)')
        const scope = nativeScope()
        const nodes = scope.querySelectorAll ? [scope, ...scope.querySelectorAll('[class]')] : []
        for (const node of nodes) {
          const m = String(node.className || '').match(re)
          if (m) return m[1]
        }
      } catch { /* ignore */ }
      return fallback
    }
    function stealFrom(parentSuffix, childSuffix, fallback) {
      try {
        const parent = nativeScope()?.querySelector?.(`[class*="${parentSuffix}"]`)
        if (!parent) return stealClass(childSuffix, fallback)
        const re = new RegExp('(?:^|\\s)([A-Za-z0-9-]+_' + childSuffix + ')(?:\\s|$)')
        const nodes = [parent, ...parent.querySelectorAll('[class]')]
        for (const node of nodes) {
          const m = String(node.className || '').match(re)
          if (m) return m[1]
        }
      } catch { /* ignore */ }
      return fallback
    }
    function stealSvg(selector) {
      try {
        const node = nativeScope()?.querySelector?.(selector)
        const svg = node && (node.tagName === 'svg' ? node : node.querySelector('svg'))
        if (!svg) return null
        return h('span', {
          'aria-hidden': true,
          style: { display: 'inline-flex', width: '16px', height: '16px', flex: 'none', color: 'inherit' },
          dangerouslySetInnerHTML: { __html: svg.outerHTML },
        })
      } catch {
        return null
      }
    }
    function joinClass(...parts) {
      return parts.filter(Boolean).join(' ')
    }
    function workspaceSkin() {
      return {
        sectionHeader: joinClass(stealClass('sectionHeader', ''), 'dsh-ct-listHead'),
        sectionLabel: joinClass(stealClass('sectionLabel', ''), 'dsh-ct-listHeadTitle'),
        headerIcon: joinClass(stealFrom('sectionHeader', 'iconButton', ''), 'dsh-ct-iconTiny'),
        headerActions: joinClass(stealClass('headerActions', ''), 'dsh-ct-headerActs'),
        headerActionsHidden: stealClass('headerActionsHidden', 'dsh-ct-headerActsHidden'),
        sectionLabelHidden: stealClass('sectionLabelHidden', 'dsh-ct-listHeadTitleHidden'),
        searchSlot: joinClass(stealClass('searchSlot', ''), 'dsh-ct-searchSlot'),
        searchSlotExpanded: stealClass('searchSlotExpanded', 'dsh-ct-searchSlotOn'),
        search: joinClass(stealClass('search', ''), 'dsh-ct-search'),
        searchExpanded: stealClass('searchExpanded', 'dsh-ct-searchOn'),
        searchButton: joinClass(stealClass('searchButton', ''), 'dsh-ct-searchBtn'),
        searchInput: joinClass(stealClass('searchInput', ''), 'dsh-ct-searchInput'),
        clearButton: joinClass(stealClass('clearButton', ''), 'dsh-ct-searchClear'),
        list: joinClass(stealClass('list', ''), 'dsh-ct-scroll'),
        group: joinClass(stealClass('groupSection', ''), 'dsh-ct-group'),
        project: joinClass(stealClass('projectRow', ''), 'dsh-ct-project'),
        session: joinClass(stealClass('sessionRow', ''), 'dsh-ct-session'),
        sessionOn: stealClass('selected', ''),
        slot: joinClass(stealClass('slot', ''), 'dsh-ct-slot'),
        folder: joinClass(stealFrom('projectRow', 'folder', ''), 'dsh-ct-folder'),
        folderOn: stealClass('folderActive', ''),
        chevron: joinClass(stealFrom('projectRow', 'chevron', ''), 'dsh-ct-chevronSlot'),
        arrow: joinClass(stealClass('arrow', ''), 'dsh-ct-arrow'),
        arrowOpen: joinClass(stealClass('arrowOpen', ''), 'dsh-ct-arrowOpen'),
        projectText: joinClass(stealClass('projectText', ''), 'dsh-ct-projectText'),
        title: joinClass(stealClass('title', ''), 'dsh-ct-title'),
        time: joinClass(stealClass('time', ''), 'dsh-ct-time'),
        rowActs: joinClass(stealClass('rowActions', ''), 'dsh-ct-rowActs'),
        rowIcon: joinClass(stealFrom('projectRow', 'iconButton', ''), 'dsh-ct-rowIcon'),
        empty: joinClass(stealClass('empty', ''), 'dsh-ct-empty'),
      }
    }
    function folderIcon(open) {
      const prim = open ? Ico('IconFolderOpen16') : Ico('IconFolderClose16')
      if (prim) return prim
      const sel = open
        ? '[class*="projectRow"][aria-expanded="true"] [class*="folder"] svg'
        : '[class*="projectRow"][aria-expanded="false"] [class*="folder"] svg'
      return stealSvg(sel) || stealSvg('[class*="projectRow"] [class*="folder"] svg')
    }
    function chevronIcon() {
      return Ico('IconTriangleRightFill14') || stealSvg('[class*="projectRow"] [class*="chevron"] svg')
    }
    function plusIcon() {
      return Ico('IconPlusOutline16', { size: 16 })
        || stealSvg('[class*="projectRow"] [class*="rowActions"] button:last-child svg')
        || stealSvg('[class*="rowActions"] svg')
    }
    function addProjectIcon() {
      return Ico('IconProjectAddOutline16', { size: 16 })
        || stealSvg('[class*="sectionHeader"] [class*="iconButton"] svg')
        || plusIcon()
    }
    function playIcon() {
      return Ico('IconPlayOutline16', { size: 16 }) || plusIcon()
    }
    function pauseIcon() {
      return Ico('IconPauseOutline16', { size: 16 }) || Ico('IconStopFill16', { size: 16 })
    }
    function searchIcon(size) {
      return Ico('IconSearchOutline16', { size: size || 14 })
        || stealSvg('[class*="sectionHeader"] [class*="searchButton"] svg')
    }
    function closeIcon() {
      return Ico('IconCloseFill14') || Ico('IconCloseOutline16', { size: 14 })
    }
    function trashIcon() {
      return Ico('IconTrashOutline16', { size: 16 })
        || stealSvg('[class*="rowActions"] [class*="iconButton"]:last-child svg')
    }
    function sessionIcon() {
      return Ico('IconChatOutline16', { size: 16 })
        || Ico('IconMessageOutline16', { size: 16 })
        || stealSvg('[class*="sessionRow"] [class*="slot"] svg')
        || stealSvg('[class*="sessionRow"] svg')
    }
    function getService(ctx, faces, key) {
      if (faces[key]) return faces[key]
      try {
        const got = ctx.get?.(key)
        if (got) return got
      } catch { /* not provided on this fiber */ }
      try {
        if (ctx[key]) return ctx[key]
      } catch { /* getter throws when not injected */ }
      try {
        const got = ctx.root?.get?.(key)
        if (got) return got
      } catch { /* ignore */ }
      return undefined
    }

    const name = 'dsh-ops-cron'
    const NS = 'dsh-ops-cron'
    const inject = ['slots', 'locale', 'settingsScope']
    const API = '/dsh-ops-cron'

    function readCookie(name) {
      const parts = String(document.cookie || '').split(';')
      for (const part of parts) {
        const idx = part.indexOf('=')
        if (idx < 0) continue
        if (part.slice(0, idx).trim() !== name) continue
        try { return decodeURIComponent(part.slice(idx + 1).trim()) } catch { return part.slice(idx + 1).trim() }
      }
      return null
    }
    function hasUdsLoginCookie() {
      // UDS_FALLBACK_USER is HttpOnly (invisible to document.cookie). Prefer the
      // readable UDS_FALLBACK_UI cookie and uds-auth's /api/me-driven attr so
      // fallback_admin sees the cron panel the same as super_admin.
      return !!(
        readCookie('PORTALSSOUser')
        || readCookie('ZTEDPGSSOUser')
        || readCookie('UDS_FALLBACK_UI')
        || readCookie('UDS_FALLBACK_USER')
        || document.documentElement.getAttribute('data-uds-logged-in') === '1'
      )
    }

    const LOCALE_NS = 'settings.dshCronTasks'
    const TITLE_PREFIX = '定时任务 · '
    const listSnapshot = {
      jobs: [], runs: [], workspaces: [],
      catalog: { groups: [], current: null },
      presets: { items: [], current: null },
      imCatalog: { available: true, options: [], loading: false },
      viewer: null,
    }

    function jobStamp(rows) {
      return (rows || []).map((row) => `${row.id}:${row.updatedAt}:${row.nextRunAt}:${row.enabled}:${row.lastStatus}:${row.model}:${row.provider}:${row.delivery?.kind}:${row.delivery?.targetId}`).join('|')
    }

    function runStamp(rows) {
      return (rows || []).map((row) => `${row.id}:${row.status}:${row.actualAt}:${row.summary || ''}`).join('|')
    }
    const DEFAULTS = {
      enabled: true,
      timezone: 'Asia/Shanghai',
      historyLimit: 200,
      overlapPolicy: 'skip',
      misfirePolicy: 'skip',
    }

    const CSS = `
.dsh-ct-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;min-width:0}
.dsh-ct-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex;min-width:0;box-sizing:border-box}
.dsh-ct-headText{flex-direction:column;flex:1;gap:2px;min-width:0;display:flex}
.dsh-ct-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.dsh-ct-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.4}
.dsh-ct-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}
.dsh-ct-card[data-open=true] .dsh-ct-chevron{transform:rotate(180deg)}
.dsh-ct-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:2px 0 8px}
.dsh-ct-hint{color:var(--dsw-alias-label-tertiary);margin:8px 0 0;font-size:12px;line-height:1.45}
.dsh-ct-footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;gap:8px;padding:10px 0 4px;display:flex}
.dsh-ct-failed{color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px}
.dsh-ct-discard,.dsh-ct-save{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 12px;font-size:13px}
.dsh-ct-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}
.dsh-ct-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.dsh-ct-field{display:flex;align-items:center;gap:10px;padding:8px 0}
.dsh-ct-field+.dsh-ct-field{border-top:1px solid var(--dsw-alias-border-l2)}
.dsh-ct-label{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;white-space:nowrap}
.dsh-ct-control{display:flex;align-items:center;gap:8px;flex:1;min-width:0}
.dsh-ct-select,.dsh-ct-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:32px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;font-size:13px;flex:1;min-width:0}
.dsh-ct-switch{appearance:none;width:40px;height:24px;margin:0 0 0 auto;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-border-l2);cursor:pointer;position:relative}
.dsh-ct-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}
.dsh-ct-switch::after{content:"";display:block;width:20px;height:20px;border-radius:999px;background:var(--dsw-alias-bg-layer-3);transition:transform .16s}
.dsh-ct-switch[aria-checked=true]::after{transform:translateX(16px)}
.dsh-ct-entry{box-sizing:border-box;flex:none;justify-content:center;align-items:center;display:flex;overflow:hidden;font-family:inherit;cursor:pointer;position:relative}
.dsh-ct-entry svg{flex:none;display:block;margin:0}
.dsh-ct-entryLabel{white-space:nowrap;overflow:hidden;min-width:0}
[class*="_collapsed"] .dsh-ct-entry,.dsh-ct-entry[data-collapsed=true]{width:36px!important;height:36px!important;padding:0!important;gap:0!important;margin:0 0 12px!important;justify-content:center!important;align-items:center!important;align-self:flex-start}
[class*="_collapsed"] .dsh-ct-entry .dsh-ct-entryLabel,.dsh-ct-entry[data-collapsed=true] .dsh-ct-entryLabel{display:none!important;max-width:0;min-width:0;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none}
[class*="_collapsed"] .dsh-ct-entry svg,.dsh-ct-entry[data-collapsed=true] svg{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);margin:0}
.dsh-ct-region{display:none !important;flex-direction:column;flex:1;min-height:0;overflow:hidden;padding-right:var(--dsh-sidebar-inline-padding,12px);box-sizing:border-box}
[data-dsh-ct-mode=on] .dsh-ct-region{display:flex !important}
[class*="_collapsed"][data-dsh-ct-mode=on] .dsh-ct-region,[class*="_collapsed"] .dsh-ct-region{display:none !important}
[data-dsh-ct-mode=on] [class*="regionArea"] > :not(.dsh-ct-region){display:none !important}
@keyframes dsh-ct-fade-in{0%{opacity:0;transform:translateY(4px)}100%{opacity:1;transform:none}}
@keyframes dsh-ct-pane-in{0%{opacity:0;transform:translateY(8px)}100%{opacity:1;transform:none}}
.dsh-ct-listHead{box-sizing:border-box;height:36px;color:var(--dsw-alias-label-tertiary);border-radius:12px;flex:none;justify-content:flex-end;align-items:center;gap:4px;margin:2px -4px 4px 0;padding-left:4px;display:flex;overflow:hidden}
.dsh-ct-listHeadTitle{white-space:nowrap;opacity:1;visibility:visible;min-width:0;max-width:45%;margin-right:auto;flex:none;line-height:20px;font-weight:400;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis}
.dsh-ct-listHeadTitleHidden{opacity:0;visibility:hidden;max-width:0;margin-right:-4px}
.dsh-ct-headerActs{flex:none;align-items:center;gap:4px;display:flex;overflow:hidden}
.dsh-ct-headerActsHidden{opacity:0;visibility:hidden;pointer-events:none;max-width:0}
.dsh-ct-searchSlot{box-sizing:border-box;min-width:0;max-width:28px;flex:1;align-items:center;margin-left:auto;display:flex}
.dsh-ct-searchSlotOn{max-width:100%}
.dsh-ct-search{box-sizing:border-box;cursor:text;width:100%;height:28px;color:var(--dsw-alias-label-secondary);background:0 0;border:none;border-radius:50%;flex:none;align-items:center;gap:0;margin:0;padding:0;display:flex;overflow:hidden}
.dsh-ct-searchOn{border:1px solid var(--dsw-alias-border-l2);width:calc(100% + 4px);height:30px;border-radius:10px;margin-inline:-2px;padding:0 4px 0 0}
.dsh-ct-searchBtn{cursor:pointer;width:28px;height:28px;color:inherit;background:0 0;border:none;border-radius:50%;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}
.dsh-ct-searchBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-ct-searchInput{opacity:0;pointer-events:none;width:0;min-width:0;color:var(--dsw-alias-label-primary);background:0 0;border:none;outline:none;flex:1;font-size:13px;line-height:18px}
.dsh-ct-searchOn .dsh-ct-searchInput{opacity:1;pointer-events:auto}
.dsh-ct-searchInput::placeholder{color:var(--dsw-alias-label-tertiary)}
.dsh-ct-searchClear{cursor:pointer;width:24px;height:24px;color:var(--dsw-alias-label-secondary);background:0 0;border:none;border-radius:50%;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}
.dsh-ct-searchClear:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-ct-iconTiny{appearance:none;cursor:pointer;width:28px;height:28px;color:var(--dsw-alias-label-secondary);background:0 0;border:none;border-radius:50%;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}
.dsh-ct-iconTiny:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-ct-rowIcon{cursor:pointer;width:16px;height:16px;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;border-radius:4px;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}
.dsh-ct-rowIcon:hover{color:var(--dsw-alias-label-primary)}
.dsh-ct-scroll{min-height:0;margin-left:-4px;padding:0 0 16px 4px;flex:1;overflow-y:auto}
.dsh-ct-group{position:relative}
.dsh-ct-group>*+*{margin-top:2px}
.dsh-ct-group+.dsh-ct-group{margin-top:4px}
.dsh-ct-slot{width:16px;height:20px;color:var(--dsw-alias-label-tertiary);flex:none;justify-content:center;align-items:center;display:inline-flex}
.dsh-ct-folder[data-on=true]{color:var(--dsw-alias-state-business-primary)}
.dsh-ct-project .dsh-ct-chevronSlot{display:none}
.dsh-ct-project:hover .dsh-ct-chevronSlot{display:inline-flex}
.dsh-ct-project:hover .dsh-ct-folder{display:none}
.dsh-ct-arrow{transition:transform .15s var(--ds-ease-in-out,ease);display:inline-flex}
.dsh-ct-arrowOpen{transform:rotate(90deg)}
.dsh-ct-project,.dsh-ct-session{cursor:pointer;user-select:none;color:var(--dsw-alias-label-primary);border-radius:8px;align-items:center;padding:0 8px;display:flex;box-sizing:border-box;border:none;background:transparent;width:100%;font:inherit;text-align:left}
.dsh-ct-project{height:34px;gap:6px;display:flex!important}
.dsh-ct-session{height:32px;gap:0}
.dsh-ct-project:hover,.dsh-ct-session:hover,.dsh-ct-session[data-on=true]{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-ct-project[data-paused=true] .dsh-ct-title{color:var(--dsw-alias-label-tertiary)}
.dsh-ct-projectText{flex-direction:column;flex:1;gap:2px;min-width:0;display:flex}
.dsh-ct-title{text-overflow:ellipsis;white-space:nowrap;min-width:0;font-size:14px;line-height:20px;overflow:hidden}
.dsh-ct-session .dsh-ct-title{flex:1;margin:0 6px 0 4px}
.dsh-ct-time{color:var(--dsw-alias-label-tertiary);flex:none;font-size:12px;line-height:20px}
.dsh-ct-rowActs{flex:none;align-items:center;gap:12px;display:none;height:20px}
.dsh-ct-project:hover .dsh-ct-rowActs,.dsh-ct-session:hover .dsh-ct-rowActs{display:inline-flex}
.dsh-ct-session:hover .dsh-ct-time{display:none}
.dsh-ct-empty{color:var(--dsw-alias-label-tertiary);padding:16px 12px;font-size:13px}
.dsh-ct-error{color:var(--dsw-alias-state-error-primary);font-size:12px;padding:0 8px 8px}
.dsh-ct-runs{display:grid;grid-template-rows:0fr;transition:grid-template-rows .18s var(--ds-ease-in-out,ease)}
.dsh-ct-runs[data-open=true]{grid-template-rows:1fr}
.dsh-ct-runsInner{overflow:hidden;min-height:0}
.dsh-ct-runsInner>*+*{margin-top:2px}
.dsh-ct-chevronHit{appearance:none;border:none;background:transparent;padding:0;margin:0;color:inherit;cursor:pointer;display:inline-flex}
[data-dsh-ct-host]{position:relative}
.dsh-ct-main{position:absolute;inset:0;z-index:8;background:var(--dsw-alias-bg-layer-1);overflow:auto;pointer-events:none;visibility:hidden}
.dsh-ct-main[data-open=true]{pointer-events:auto;visibility:visible}
.dsh-ct-main[data-open=true] .dsh-ct-editor{animation:dsh-ct-pane-in .2s var(--ds-ease-in-out,ease)}
body>.dsh-ct-main{position:fixed;top:0;right:0;bottom:0;left:var(--dsh-ct-sidebar,260px)}
@media (prefers-reduced-motion:reduce){
.dsh-ct-region,.dsh-ct-main,.dsh-ct-runs,.dsh-ct-arrow,[data-dsh-ct-mode=on] .dsh-ct-region{animation:none;transition:none}
}
.dsh-ct-editor{max-width:720px;margin:0 auto;padding:32px 28px 48px}
.dsh-ct-editor h1{margin:0 0 8px;font-size:20px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-ct-editorLead{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5;margin:0 0 20px}
.dsh-ct-editor label{display:flex;flex-direction:column;gap:6px;margin:0 0 14px;color:var(--dsw-alias-label-secondary);font-size:13px}
.dsh-ct-editor input,.dsh-ct-editor textarea,.dsh-ct-editor select{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;font:inherit;font-size:14px;padding:8px 10px}
.dsh-ct-editor textarea{min-height:160px;resize:vertical;line-height:1.5}
.dsh-ct-editorRow{display:flex;gap:12px}
.dsh-ct-editorRow label{flex:1}
.dsh-ct-cwdHint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.4}
.dsh-ct-editorActs{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
.dsh-ct-primary{appearance:none;font:inherit;border:none;border-radius:8px;padding:8px 14px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);cursor:pointer;font-size:13px}
.dsh-ct-secondary{appearance:none;font:inherit;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 14px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:13px}
.dsh-ct-preview{margin-top:24px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3)}
.dsh-ct-preview h2{margin:0 0 8px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dsh-ct-previewBody{white-space:pre-wrap;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.55;margin:0}
`

    const zh = {
      title: '定时任务',
      description: '调度策略：启用、默认时区、历史保留、重叠与漏跑。',
      expand: '展开设置', collapse: '收起设置', save: '保存', saving: '保存中…', discard: '放弃修改',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
      enabled: '启用调度器', timezone: '默认时区', historyLimit: '历史保留条数',
      overlapPolicy: '重叠策略', misfirePolicy: '漏跑策略', policySkip: '跳过',
      hint: '每次执行会新开会话跑任务；摘要会镜像回创建时的有效会话（WhatsApp/Web），便于继续追问。完整工具轨迹仍可从历史打开。',
      entry: '定时任务', entryLabel: '打开定时任务',
      backToWorkspace: '返回工作区', backLabel: '返回工作区',
      newJob: '新建任务', name: '名称', prompt: '提示词', kind: '日程',
      cron: 'Cron（循环）', at: '一次性时间', expr: 'Cron 表达式', atTime: '时间',
      create: '创建', pause: '暂停', resume: '恢复', runNow: '立即运行', remove: '删除',
      emptyJobs: '还没有定时任务。点右上角 + 新建。', unassignedOwner: '未归属', ownerClaim: '改派归属', next: '下次', last: '上次',
      expandRuns: '展开记录', collapseRuns: '收起记录',
      search: '搜索', searchPlaceholder: '搜索任务', searchClear: '清除搜索', searchEmpty: '没有匹配的任务。',
      paused: '已暂停',
      scheduleTz: '时区', cwd: '工作目录', timeout: '超时（分钟）',
      cwdRecent: '最近使用的工作区', cwdCustom: '自定义路径…',
      cwdPlaceholder: '/absolute/path',
      cwdHint: '运行会在这个目录对应的工作区里开新会话。留空则用最近工作区。',
      model: '模型',
      modelDefault: '每次运行用当时的新会话默认',
      modelHint: '定时任务会消耗这个模型的额度。指定后不会跟着聊天模型变。',
      agentPreset: 'Agent Preset',
      agentPresetDefault: '每次运行用当时的 Host 默认',
      agentPresetHint: '指定后每次触发都挂载该 Preset；留空则跟随 Host 默认（创建时若从 WhatsApp 继承会自动写入）。',
      editorLead: '到点仍会新开会话执行。结束后摘要会镜像回创建时的有效会话；IM 投递还会经 WhatsApp/IM 发出。日常追问请用原会话；完整工具轨迹可从下方运行记录打开。',
      lastOutput: '上次输出', noOutput: '还没有输出。先立即运行一次。',
      delivery: '投递',
      deliveryDsh: 'DSH 侧栏会话',
      deliveryIm: 'WhatsApp / IM',
      imBotId: 'IM Bot ID',
      imTargetId: 'IM Target ID',
      imTarget: '投递目标',
      imTargetNone: '（请先在 IM「投递设置」新建目标）',
      imTargetManual: '手动填写…',
      imCatalogLoading: '正在加载投递目标…',
      imCatalogUnavailable: '无法加载投递目标（需 dsh-im-ops ≥ops.24，且已配置投递目标）',
      deliveryHint: '选 WhatsApp/IM 后从下拉选择已保存的投递目标；也可手动填写。目标在 IM 机器人 → 投递设置里创建。',
    }
    const en = {
      title: 'Scheduled tasks',
      description: 'Scheduler policy: enable, default time zone, history retention, overlap and misfire.',
      expand: 'Show settings', collapse: 'Hide settings', save: 'Save', saving: 'Saving…', discard: 'Discard',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
      enabled: 'Enable scheduler', timezone: 'Default time zone', historyLimit: 'History retention',
      overlapPolicy: 'Overlap policy', misfirePolicy: 'Misfire policy', policySkip: 'Skip',
      hint: 'Each fire runs in a fresh session; the summary is mirrored into the origin WhatsApp/Web session so you can follow up there. Full tool traces stay in run history.',
      entry: 'Scheduled tasks', entryLabel: 'Open scheduled tasks',
      backToWorkspace: 'Back to workspace', backLabel: 'Back to workspace',
      newJob: 'New job', name: 'Name', prompt: 'Prompt', kind: 'Schedule',
      cron: 'Cron (recurring)', at: 'One-shot time', expr: 'Cron expression', atTime: 'Time',
      create: 'Create', pause: 'Pause', resume: 'Resume', runNow: 'Run now', remove: 'Delete',
      emptyJobs: 'No jobs yet. Use + to create one.', unassignedOwner: 'Unassigned', ownerClaim: 'Reassign owner', next: 'Next', last: 'Last',
      expandRuns: 'Show runs', collapseRuns: 'Hide runs',
      search: 'Search', searchPlaceholder: 'Search jobs', searchClear: 'Clear search', searchEmpty: 'No matching jobs.',
      paused: 'Paused',
      scheduleTz: 'Time zone', cwd: 'Working directory', timeout: 'Timeout (minutes)',
      cwdRecent: 'Most recent workspace', cwdCustom: 'Custom path…',
      cwdPlaceholder: '/absolute/path',
      cwdHint: 'Runs start a session in this workspace folder. Leave empty to use the most recent workspace.',
      model: 'Model',
      modelDefault: 'Use the New Session default at fire time',
      modelHint: 'Scheduled runs consume this model\'s quota. A pinned model will not follow the chat selector.',
      agentPreset: 'Agent preset',
      agentPresetDefault: 'Use the Host default at fire time',
      agentPresetHint: 'Pin a preset for every fire. Leave empty to follow the Host default (WhatsApp-created jobs inherit the chat preset automatically).',
      editorLead: 'Fires still run in a new session. Afterward the summary is mirrored into the origin session; IM delivery also sends via WhatsApp/IM. Follow up in the origin chat; open a run below for the full tool trace.',
      lastOutput: 'Last output', noOutput: 'No output yet. Run it once.',
      delivery: 'Delivery',
      deliveryDsh: 'DSH sidebar session',
      deliveryIm: 'WhatsApp / IM',
      imBotId: 'IM Bot ID',
      imTargetId: 'IM Target ID',
      imTarget: 'Delivery target',
      imTargetNone: '(Create a target in IM delivery settings first)',
      imTargetManual: 'Enter manually…',
      imCatalogLoading: 'Loading delivery targets…',
      imCatalogUnavailable: 'Cannot load targets (need dsh-im-ops ≥ops.24 with saved targets)',
      deliveryHint: 'Pick a saved IM delivery target from the list, or enter botId/targetId manually. Create targets under IM bot → Delivery settings.',
    }

    function normalizePrefs(value) {
      const src = value && typeof value === 'object' ? value : {}
      const historyLimit = Number(src.historyLimit)
      return {
        enabled: src.enabled !== false,
        timezone: typeof src.timezone === 'string' && src.timezone.trim() ? src.timezone.trim() : DEFAULTS.timezone,
        historyLimit: Number.isInteger(historyLimit) && historyLimit >= 10 ? Math.min(2000, historyLimit) : DEFAULTS.historyLimit,
        overlapPolicy: src.overlapPolicy === 'skip' ? 'skip' : DEFAULTS.overlapPolicy,
        misfirePolicy: src.misfirePolicy === 'skip' ? 'skip' : DEFAULTS.misfirePolicy,
      }
    }

    function createStore(initial) {
      let snapshot = initial
      const listeners = new Set()
      return {
        getSnapshot: () => snapshot,
        subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
        set(next) { snapshot = next; for (const fn of listeners) fn() },
      }
    }

    function createForm(scope) {
      const staged = new Map()
      let saving = false
      let failed = false
      let store
      function publish() { store.set(projection()) }
      function current() { return normalizePrefs(scope.getSnapshot().value) }
      function draft() {
        const next = { ...current() }
        for (const field of Object.keys(DEFAULTS)) {
          if (!staged.has(field)) continue
          const op = staged.get(field)
          next[field] = op.kind === 'clear' ? DEFAULTS[field] : op.value
        }
        return next
      }
      function projection() {
        const snapshot = scope.getSnapshot()
        return {
          available: snapshot.status !== 'unavailable',
          writable: snapshot.writable === true,
          dirty: staged.size > 0,
          saving, failed, value: draft(),
        }
      }
      store = createStore(projection())
      scope.subscribe(() => publish())
      return {
        store,
        edit(field, value) { staged.set(field, { kind: 'set', value }); failed = false; publish() },
        discard() { staged.clear(); failed = false; publish() },
        async save() {
          const state = projection()
          if (!state.dirty || saving || !state.writable) return
          saving = true; failed = false; publish()
          try {
            for (const [field, op] of staged.entries()) {
              if (op.kind === 'clear') await scope.unset(field)
              else await scope.set(field, op.value)
            }
            staged.clear()
            if (scope.getSnapshot().status !== 'ready') failed = true
          } catch { failed = true } finally { saving = false; publish() }
        },
      }
    }

    function Chevron() {
      return h('svg', {
        className: 'dsh-ct-chevron', width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', 'aria-hidden': true,
      }, h('path', { d: 'M3.2 5.2 7 9l3.8-3.8' }))
    }

    function SettingsCard(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => zh[key] || key
      const state = props.useCard ? props.useCard((s) => s) : {
        writable: false, dirty: false, saving: false, failed: false, value: DEFAULTS,
      }
      const [open, setOpen] = useState(false)
      const id = useId()
      const value = state.value || DEFAULTS
      const blocked = !state.writable || state.saving || !state.dirty
      return h('li', { className: 'dsh-ct-card', 'data-open': open ? 'true' : 'false' },
        h('button', { type: 'button', className: 'dsh-ct-header', 'aria-expanded': open, onClick: () => setOpen((v) => !v) },
          h('div', { className: 'dsh-ct-headText' },
            h('span', { className: 'dsh-ct-name' }, t('title')),
            h('span', { className: 'dsh-ct-description' }, t('description')),
          ),
          h(Chevron),
        ),
        open ? h('div', { className: 'dsh-ct-body' },
          h('div', { className: 'dsh-ct-field' },
            h('span', { className: 'dsh-ct-label' }, t('enabled')),
            h('button', {
              type: 'button', className: 'dsh-ct-switch', role: 'switch',
              'aria-checked': value.enabled ? 'true' : 'false',
              disabled: !state.writable || state.saving,
              onClick: () => props.edit('enabled', !value.enabled),
            }),
          ),
          h('div', { className: 'dsh-ct-field' },
            h('label', { className: 'dsh-ct-label', htmlFor: `${id}-tz` }, t('timezone')),
            h('div', { className: 'dsh-ct-control' },
              h('input', { id: `${id}-tz`, className: 'dsh-ct-input', value: value.timezone, disabled: !state.writable || state.saving, onChange: (e) => props.edit('timezone', e.target.value) }),
            ),
          ),
          h('div', { className: 'dsh-ct-field' },
            h('label', { className: 'dsh-ct-label', htmlFor: `${id}-hist` }, t('historyLimit')),
            h('div', { className: 'dsh-ct-control' },
              h('input', { id: `${id}-hist`, className: 'dsh-ct-input', type: 'number', min: 10, max: 2000, value: value.historyLimit, disabled: !state.writable || state.saving, onChange: (e) => props.edit('historyLimit', Number(e.target.value)) }),
            ),
          ),
          h('div', { className: 'dsh-ct-field' },
            h('label', { className: 'dsh-ct-label' }, t('overlapPolicy')),
            h('div', { className: 'dsh-ct-control' },
              h('select', { className: 'dsh-ct-select', value: value.overlapPolicy, disabled: !state.writable || state.saving, onChange: (e) => props.edit('overlapPolicy', e.target.value) },
                h('option', { value: 'skip' }, t('policySkip'))),
            ),
          ),
          h('div', { className: 'dsh-ct-field' },
            h('label', { className: 'dsh-ct-label' }, t('misfirePolicy')),
            h('div', { className: 'dsh-ct-control' },
              h('select', { className: 'dsh-ct-select', value: value.misfirePolicy, disabled: !state.writable || state.saving, onChange: (e) => props.edit('misfirePolicy', e.target.value) },
                h('option', { value: 'skip' }, t('policySkip'))),
            ),
          ),
          h('p', { className: 'dsh-ct-hint' }, t('hint')),
          h('div', { className: 'dsh-ct-footer' },
            state.failed ? h('p', { className: 'dsh-ct-failed' }, t('saveFailed')) : null,
            h('button', { type: 'button', className: 'dsh-ct-discard', disabled: !state.dirty || state.saving, onClick: props.discard }, t('discard')),
            h('button', { type: 'button', className: 'dsh-ct-save', disabled: blocked, onClick: props.save }, t(state.saving ? 'saving' : 'save')),
          ),
        ) : null,
      )
    }

    async function api(path, options = {}) {
      if (!hasUdsLoginCookie() && path !== '/health') {
        throw new Error('登录后才能使用定时任务')
      }
      const response = await fetch(`${API}${path}`, {
        ...options,
        headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers },
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`)
      return body
    }

    function partsInZone(ms, timeZone) {
      const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: timeZone || 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      })
      const map = {}
      for (const part of dtf.formatToParts(new Date(ms))) {
        if (part.type !== 'literal') map[part.type] = part.value
      }
      return {
        year: Number(map.year),
        month: Number(map.month),
        day: Number(map.day),
        hour: Number(map.hour),
        minute: Number(map.minute),
        second: Number(map.second),
      }
    }

    function zonedToUtc(parts, timeZone) {
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
      ) return null
      return result
    }

    function formatTime(ms, timeZone) {
      if (!ms) return ''
      try {
        const p = partsInZone(ms, timeZone || 'Asia/Shanghai')
        const pad = (n) => String(n).padStart(2, '0')
        return `${p.month}/${p.day} ${pad(p.hour)}:${pad(p.minute)}`
      } catch {
        const d = new Date(ms)
        return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      }
    }

    function atToLocalInput(value, timeZone) {
      if (!value) return ''
      const raw = String(value).trim()
      const zone = timeZone || 'Asia/Shanghai'
      if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) {
        return raw.slice(0, 16)
      }
      const ms = Date.parse(raw)
      if (!Number.isFinite(ms)) return raw.slice(0, 16)
      const p = partsInZone(ms, zone)
      const pad = (n) => String(n).padStart(2, '0')
      return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`
    }

    function localInputToAt(local, timeZone) {
      if (!local) return local
      const raw = String(local).trim()
      if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) return raw
      const zone = timeZone || 'Asia/Shanghai'
      const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
      if (!match) return raw
      const ms = zonedToUtc({
        year: Number(match[1]),
        month: Number(match[2]),
        day: Number(match[3]),
        hour: Number(match[4]),
        minute: Number(match[5]),
        second: 0,
      }, zone)
      return ms == null ? raw : new Date(ms).toISOString()
    }

    function emptyForm(timezone, current) {
      return {
        name: '', prompt: '', kind: 'cron', expr: '0 9 * * 1-5', at: '',
        timezone: timezone || DEFAULTS.timezone, cwd: '', timeoutMinutes: 10, enabled: true,
        provider: current?.provider || '',
        model: current?.model || '',
        agentPreset: '',
        deliveryKind: 'dsh',
        imBotId: '',
        imTargetId: '',
      }
    }

    function jobToForm(job) {
      return {
        name: job.name || '',
        prompt: job.prompt || '',
        kind: job.schedule?.kind || 'cron',
        expr: job.schedule?.expr || '0 9 * * 1-5',
        at: job.schedule?.at ? atToLocalInput(job.schedule.at, job.schedule?.timezone) : '',
        timezone: job.schedule?.timezone || DEFAULTS.timezone,
        cwd: job.cwd || '',
        timeoutMinutes: job.timeoutMinutes || 10,
        enabled: job.enabled !== false,
        provider: job.provider || '',
        model: job.model || '',
        agentPreset: job.agentPreset || '',
        deliveryKind: job.delivery?.kind === 'im' ? 'im' : 'dsh',
        imBotId: job.delivery?.botId || '',
        imTargetId: job.delivery?.targetId || '',
      }
    }

    function jobDeliveryLabel(job, t) {
      if (job?.delivery?.kind === 'im') {
        return `${t('deliveryIm')}:${job.delivery.targetId || '?'}`
      }
      return t('deliveryDsh')
    }

    function modelKey(provider, model) {
      if (!provider || !model) return ''
      return `${provider}::${model}`
    }

    function parseModelKey(value) {
      const raw = String(value || '')
      const at = raw.indexOf('::')
      if (at <= 0) return { provider: '', model: '' }
      return { provider: raw.slice(0, at), model: raw.slice(at + 2) }
    }

    function jobModelLabel(job) {
      if (job?.provider && job?.model) return job.model
      return ''
    }

    function JobList({ t, jobs, runs, selection, expanded, viewer, error, onSelectJob, onSelectRun, onNew, onRun, onToggle, onRemove, onToggleGroup }) {
      const skin = workspaceSkin()
      const [query, setQuery] = useState('')
      const [searchOn, setSearchOn] = useState(false)
      const searchRef = useRef(null)
      const needle = query.trim().toLowerCase()
      const canViewAll = !!viewer?.canViewAll
      const visibleJobs = !needle ? jobs : jobs.filter((job) => {
        const hay = [
          job.name,
          job.prompt,
          job.schedule?.expr,
          job.schedule?.at,
          job.provider,
          job.model,
          job.ownerEmpNo,
          job.ownerDisplayName,
          ...(runs.filter((run) => run.jobId === job.id).map((run) => run.summary || run.status)),
        ].join(' ').toLowerCase()
        return hay.includes(needle)
      })

      function ownerKey(job) {
        return String(job?.ownerEmpNo || '__unassigned__')
      }

      function ownerLabel(job) {
        const key = ownerKey(job)
        if (key === '__unassigned__') return t('unassignedOwner')
        const name = String(job?.ownerDisplayName || '').trim()
        return name && name !== key ? `${key} · ${name}` : key
      }

      function renderJobGroup(job) {
        const open = expanded[job.id] === true || !!needle
        const paused = job.enabled === false
        const jobRuns = runs.filter((run) => run.jobId === job.id)
        const selectedJob = selection?.type === 'job' && selection.jobId === job.id
        const containsCurrent = selectedJob || (selection?.type === 'run' && selection.jobId === job.id)
        return h('div', { className: skin.group, key: job.id },
          h('div', {
            className: skin.project,
            role: 'treeitem',
            'aria-expanded': open,
            'data-on': selectedJob ? 'true' : 'false',
            'data-paused': paused ? 'true' : 'false',
            onClick: () => onSelectJob(job.id),
          },
            h('span', {
              className: joinClass(skin.slot, skin.folder, open && containsCurrent ? skin.folderOn : ''),
              'data-on': open && containsCurrent ? 'true' : 'false',
            }, folderIcon(open)),
            h('button', {
              type: 'button',
              className: joinClass(skin.slot, skin.chevron, 'dsh-ct-chevronHit'),
              title: open ? t('collapseRuns') : t('expandRuns'),
              onClick: (e) => { e.stopPropagation(); onToggleGroup(job.id) },
            },
              h('span', { className: joinClass(skin.arrow, open ? skin.arrowOpen : '') },
                chevronIcon() || '▸')),
            h('span', { className: skin.projectText },
              h('span', { className: skin.title }, paused
                ? `${job.name} · ${t('paused')}`
                : `${job.name} · ${jobDeliveryLabel(job, t)}${jobModelLabel(job) ? ` · ${jobModelLabel(job)}` : ''}`)),
            h('span', { className: skin.rowActs, onClick: (e) => e.stopPropagation() },
              h('button', { type: 'button', className: skin.rowIcon, title: t('runNow'), onClick: () => onRun(job.id) },
                playIcon() || '▶'),
              h('button', {
                type: 'button',
                className: skin.rowIcon,
                title: paused ? t('resume') : t('pause'),
                onClick: () => onToggle(job),
              }, pauseIcon() || (paused ? '▶' : '⏸')),
              h('button', { type: 'button', className: skin.rowIcon, title: t('remove'), onClick: () => onRemove(job.id) },
                trashIcon() || '×'),
            ),
          ),
          h('div', { className: 'dsh-ct-runs', 'data-open': open ? 'true' : 'false' },
            h('div', { className: 'dsh-ct-runsInner' },
              jobRuns.map((run) => {
                const selectedRun = selection?.type === 'run' && selection.runId === run.id
                return h('div', {
                  key: run.id,
                  className: skin.session,
                  role: 'treeitem',
                  'data-on': selectedRun ? 'true' : 'false',
                  onClick: () => onSelectRun(job.id, run),
                },
                  h('span', { className: skin.slot }, sessionIcon() || '·'),
                  h('span', { className: skin.title }, (run.summary || run.status || '').split('\n')[0] || run.status),
                  h('span', { className: skin.time }, formatTime(run.actualAt || run.scheduledAt, job.schedule?.timezone)),
                )
              }),
            ),
          ),
        )
      }

      function renderGrouped() {
        const groups = new Map()
        for (const job of visibleJobs) {
          const key = ownerKey(job)
          if (!groups.has(key)) groups.set(key, { key, label: ownerLabel(job), jobs: [] })
          groups.get(key).jobs.push(job)
        }
        const ordered = [...groups.values()].sort((a, b) => {
          if (a.key === '__unassigned__') return 1
          if (b.key === '__unassigned__') return -1
          return String(a.label).localeCompare(String(b.label), 'zh')
        })
        return ordered.map((group) => {
          const folderId = `owner:${group.key}`
          const open = expanded[folderId] !== false || !!needle
          const containsCurrent = group.jobs.some((job) => (
            (selection?.type === 'job' && selection.jobId === job.id)
            || (selection?.type === 'run' && selection.jobId === job.id)
          ))
          return h('div', { className: skin.group, key: folderId },
            h('div', {
              className: skin.project,
              role: 'treeitem',
              'aria-expanded': open,
              'data-on': containsCurrent ? 'true' : 'false',
              onClick: () => onToggleGroup(folderId),
            },
              h('span', {
                className: joinClass(skin.slot, skin.folder, open && containsCurrent ? skin.folderOn : ''),
                'data-on': open && containsCurrent ? 'true' : 'false',
              }, folderIcon(open)),
              h('button', {
                type: 'button',
                className: joinClass(skin.slot, skin.chevron, 'dsh-ct-chevronHit'),
                title: open ? t('collapseRuns') : t('expandRuns'),
                onClick: (e) => { e.stopPropagation(); onToggleGroup(folderId) },
              },
                h('span', { className: joinClass(skin.arrow, open ? skin.arrowOpen : '') },
                  chevronIcon() || '▸')),
              h('span', { className: skin.projectText },
                h('span', { className: skin.title }, `${group.label} · ${group.jobs.length}`)),
            ),
            h('div', { className: 'dsh-ct-runs', 'data-open': open ? 'true' : 'false' },
              h('div', { className: 'dsh-ct-runsInner' },
                group.jobs.map((job) => renderJobGroup(job)),
              ),
            ),
          )
        })
      }

      return h(React.Fragment, null,
        h('div', { className: skin.sectionHeader },
          h('span', { className: joinClass(skin.sectionLabel, searchOn ? skin.sectionLabelHidden : '') }, t('title')),
          h('div', { className: joinClass(skin.searchSlot, searchOn ? skin.searchSlotExpanded : '') },
            h('div', {
              className: joinClass(skin.search, searchOn ? skin.searchExpanded : ''),
              onClick: () => {
                setSearchOn(true)
                queueMicrotask(() => searchRef.current?.focus())
              },
            },
              h('button', {
                type: 'button',
                className: skin.searchButton,
                title: t('search'),
                'aria-label': t('search'),
                'aria-expanded': searchOn,
                onClick: () => setSearchOn(true),
              }, searchIcon(searchOn ? 11 : 14)),
              h('input', {
                ref: searchRef,
                className: skin.searchInput,
                type: 'text',
                placeholder: t('searchPlaceholder'),
                value: query,
                tabIndex: searchOn ? 0 : -1,
                onChange: (e) => setQuery(e.target.value),
                onKeyDown: (e) => {
                  if (e.key !== 'Escape') return
                  setQuery('')
                  setSearchOn(false)
                },
              }),
              searchOn ? h('button', {
                type: 'button',
                className: skin.clearButton,
                title: t('searchClear'),
                'aria-label': t('searchClear'),
                onClick: (e) => {
                  e.stopPropagation()
                  setQuery('')
                  setSearchOn(false)
                },
              }, closeIcon()) : null,
            ),
          ),
          h('div', { className: joinClass(skin.headerActions, searchOn ? skin.headerActionsHidden : '') },
            h('button', { type: 'button', className: skin.headerIcon, title: t('newJob'), onClick: onNew },
              addProjectIcon() || '+'),
          ),
        ),
        error ? h('p', { className: 'dsh-ct-error' }, error) : null,
        h('div', { className: skin.list },
          jobs.length === 0 ? h('p', { className: skin.empty }, error || t('emptyJobs'))
            : visibleJobs.length === 0 ? h('p', { className: skin.empty }, t('searchEmpty'))
            : (canViewAll ? renderGrouped() : visibleJobs.map((job) => renderJobGroup(job))),
        ),
      )
    }

    function currentWorkspacePath(faces) {
      const snap = faces?.sessions?.list?.getSnapshot?.()
      const current = snap?.current
      const row = current ? snap?.byId?.[current] : null
      return String(row?.cwd || '').trim()
    }

    function cwdSelectValue(cwd, workspaces) {
      const value = String(cwd || '').trim()
      if (!value) return ''
      if ((workspaces || []).some((row) => row.path === value)) return value
      return '__custom__'
    }

    function CwdField({ t, form, setForm, workspaces, viewer }) {
      const rows = Array.isArray(workspaces) ? workspaces : []
      const mode = cwdSelectValue(form.cwd, rows)
      const allowCustom = !!viewer?.canViewAll
      return h('label', null, t('cwd'),
        h('select', {
          value: mode,
          onChange: (e) => {
            const next = e.target.value
            if (next === '__custom__') {
              const keep = form.cwd && !rows.some((row) => row.path === form.cwd) ? form.cwd : ''
              setForm({ ...form, cwd: keep })
              return
            }
            setForm({ ...form, cwd: next })
          },
        },
          h('option', { value: '' }, t('cwdRecent')),
          ...rows.map((row) => h('option', { value: row.path, key: row.id || row.path }, `${row.title} — ${row.path}`)),
          ...(allowCustom ? [h('option', { value: '__custom__' }, t('cwdCustom'))] : []),
        ),
        allowCustom && mode === '__custom__'
          ? h('input', {
            placeholder: t('cwdPlaceholder'),
            value: form.cwd,
            onChange: (e) => setForm({ ...form, cwd: e.target.value }),
          })
          : null,
        h('span', { className: 'dsh-ct-cwdHint' }, t('cwdHint')),
      )
    }

    function ModelField({ t, form, setForm, catalog }) {
      const groups = Array.isArray(catalog?.groups) ? catalog.groups : []
      const current = catalog?.current
      const selected = modelKey(form.provider, form.model)
      const known = groups.some((group) => (group.models || []).some((entry) => modelKey(group.provider, entry.id) === selected))
      const defaultLabel = current?.model
        ? `${t('modelDefault')}（${current.model}）`
        : t('modelDefault')
      return h('label', null, t('model'),
        h('select', {
          value: selected,
          onChange: (e) => setForm({ ...form, ...parseModelKey(e.target.value) }),
        },
          h('option', { value: '' }, defaultLabel),
          !known && selected
            ? h('option', { value: selected }, `${form.model} · ${form.provider}`)
            : null,
          ...groups.flatMap((group) => (group.models || []).map((entry) => h('option', {
            value: modelKey(group.provider, entry.id),
            key: modelKey(group.provider, entry.id),
          }, `${entry.name || entry.id} · ${group.displayName || group.provider}`))),
        ),
        h('span', { className: 'dsh-ct-cwdHint' }, t('modelHint')),
      )
    }

    function PresetField({ t, form, setForm, presets }) {
      const items = Array.isArray(presets?.items) ? presets.items : []
      const current = presets?.current
      const selected = form.agentPreset || ''
      const known = items.some((row) => row.id === selected)
      const defaultLabel = current?.id
        ? `${t('agentPresetDefault')}（${current.name || current.id}）`
        : t('agentPresetDefault')
      return h('label', null, t('agentPreset'),
        h('select', {
          value: selected,
          onChange: (e) => setForm({ ...form, agentPreset: e.target.value }),
        },
          h('option', { value: '' }, defaultLabel),
          !known && selected
            ? h('option', { value: selected }, selected)
            : null,
          ...items.map((row) => h('option', {
            value: row.id,
            key: row.id,
          }, row.name || row.id)),
        ),
        h('span', { className: 'dsh-ct-cwdHint' }, t('agentPresetHint')),
      )
    }

    function imOptionKey(botId, targetId) {
      return `${botId || ''}::${targetId || ''}`
    }

    function parseImOptionKey(value) {
      const raw = String(value || '')
      const at = raw.indexOf('::')
      if (at <= 0) return { botId: '', targetId: '' }
      return { botId: raw.slice(0, at), targetId: raw.slice(at + 2) }
    }

    function ImDeliveryFields({ t, form, setForm, imCatalog }) {
      const options = Array.isArray(imCatalog?.options) ? imCatalog.options : []
      const loading = !!imCatalog?.loading
      const available = imCatalog?.available !== false
      const selectedKey = form.imBotId && form.imTargetId
        ? imOptionKey(form.imBotId, form.imTargetId)
        : ''
      const matched = options.some((row) => imOptionKey(row.botId, row.targetId) === selectedKey)
      const [manual, setManual] = useState(() => !!(selectedKey && !matched))
      useEffect(() => {
        if (selectedKey && !matched && !loading) setManual(true)
        if (selectedKey && matched) setManual(false)
      }, [selectedKey, matched, loading])
      const selectValue = manual
        ? '__manual__'
        : (matched ? selectedKey : '')
      const showManual = manual || (selectedKey && !matched && !loading)

      return h(React.Fragment, null,
        h('label', null, t('imTarget'),
          h('select', {
            value: selectValue,
            disabled: loading,
            onChange: (e) => {
              const value = e.target.value
              if (value === '__manual__') {
                setManual(true)
                return
              }
              setManual(false)
              if (!value) {
                setForm({ ...form, imBotId: '', imTargetId: '' })
                return
              }
              const next = parseImOptionKey(value)
              setForm({ ...form, imBotId: next.botId, imTargetId: next.targetId })
            },
          },
            h('option', { value: '' }, loading ? t('imCatalogLoading') : (
              options.length === 0 ? t('imTargetNone') : `— ${t('imTarget')} —`
            )),
            ...options.map((row) => h('option', {
              key: imOptionKey(row.botId, row.targetId),
              value: imOptionKey(row.botId, row.targetId),
            }, `${row.name || row.targetId} · ${row.channel || 'im'} · ${row.targetId}`)),
            h('option', { value: '__manual__' }, t('imTargetManual')),
          ),
        ),
        !available || (options.length === 0 && !loading)
          ? h('span', { className: 'dsh-ct-cwdHint' }, imCatalog?.hint || t('imCatalogUnavailable'))
          : null,
        showManual
          ? h('div', { className: 'dsh-ct-editorRow' },
            h('label', null, t('imBotId'), h('input', {
              value: form.imBotId || '',
              onChange: (e) => setForm({ ...form, imBotId: e.target.value }),
            })),
            h('label', null, t('imTargetId'), h('input', {
              value: form.imTargetId || '',
              onChange: (e) => setForm({ ...form, imTargetId: e.target.value }),
            })),
          )
          : null,
      )
    }

    function JobEditor({ t, form, setForm, isNew, error, lastOutput, nextRunAt, lastRunAt, workspaces, catalog, presets, imCatalog, viewer, onSave, onRun, onPause, onRemove }) {
      return h('div', { className: 'dsh-ct-editor' },
        h('h1', null, isNew ? t('newJob') : (form.name || t('title'))),
        h('p', { className: 'dsh-ct-editorLead' }, t('editorLead')),
        error ? h('p', { className: 'dsh-ct-error' }, error) : null,
        h('label', null, t('name'), h('input', { value: form.name, onChange: (e) => setForm({ ...form, name: e.target.value }) })),
        h('label', null, t('prompt'), h('textarea', { value: form.prompt, onChange: (e) => setForm({ ...form, prompt: e.target.value }) })),
        h('div', { className: 'dsh-ct-editorRow' },
          h('label', null, t('kind'),
            h('select', { value: form.kind, onChange: (e) => setForm({ ...form, kind: e.target.value }) },
              h('option', { value: 'cron' }, t('cron')),
              h('option', { value: 'at' }, t('at')),
            ),
          ),
          form.kind === 'cron'
            ? h('label', null, t('expr'), h('input', { value: form.expr, onChange: (e) => setForm({ ...form, expr: e.target.value }) }))
            : h('label', null, t('atTime'), h('input', { type: 'datetime-local', value: form.at, onChange: (e) => setForm({ ...form, at: e.target.value }) })),
        ),
        nextRunAt || lastRunAt
          ? h('p', { className: 'dsh-ct-editorLead' },
            [
              nextRunAt ? `${t('next')}: ${formatTime(nextRunAt, form.timezone)} (${form.timezone})` : null,
              lastRunAt ? `${t('last')}: ${formatTime(lastRunAt, form.timezone)} (${form.timezone})` : null,
            ].filter(Boolean).join(' · '),
          )
          : null,
        h('div', { className: 'dsh-ct-editorRow' },
          h('label', null, t('scheduleTz'), h('input', { value: form.timezone, onChange: (e) => setForm({ ...form, timezone: e.target.value }) })),
          h('label', null, t('timeout'), h('input', { type: 'number', min: 1, max: 240, value: form.timeoutMinutes, onChange: (e) => setForm({ ...form, timeoutMinutes: Number(e.target.value) }) })),
        ),
        h(CwdField, { t, form, setForm, workspaces, viewer }),
        h(ModelField, { t, form, setForm, catalog }),
        h(PresetField, { t, form, setForm, presets }),
        h('label', null, t('delivery'),
          h('select', {
            value: form.deliveryKind || 'dsh',
            onChange: (e) => setForm({ ...form, deliveryKind: e.target.value }),
          },
            h('option', { value: 'dsh' }, t('deliveryDsh')),
            h('option', { value: 'im' }, t('deliveryIm')),
          ),
        ),
        form.deliveryKind === 'im'
          ? h(ImDeliveryFields, { t, form, setForm, imCatalog })
          : null,
        h('span', { className: 'dsh-ct-cwdHint' }, t('deliveryHint')),
        h('div', { className: 'dsh-ct-editorActs' },
          h('button', { type: 'button', className: 'dsh-ct-primary', onClick: onSave }, t('save')),
          !isNew ? h('button', { type: 'button', className: 'dsh-ct-secondary', onClick: onRun }, t('runNow')) : null,
          !isNew ? h('button', { type: 'button', className: 'dsh-ct-secondary', onClick: onPause }, t(form.enabled === false ? 'resume' : 'pause')) : null,
          !isNew ? h('button', { type: 'button', className: 'dsh-ct-secondary', onClick: onRemove }, t('remove')) : null,
        ),
        h('div', { className: 'dsh-ct-preview' },
          h('h2', null, t('lastOutput')),
          h('p', { className: 'dsh-ct-previewBody' }, lastOutput || t('noOutput')),
        ),
      )
    }

    function CronApp({ t, faces }) {
      const [jobs, setJobs] = useState(() => listSnapshot.jobs)
      const [viewer, setViewer] = useState(() => listSnapshot.viewer)
      const [runs, setRuns] = useState(() => listSnapshot.runs)
      const [selection, setSelection] = useState({ type: 'new' })
      const [expanded, setExpanded] = useState({})
      const [form, setForm] = useState(emptyForm())
      const [error, setError] = useState('')
      const [cronMode, setCronMode] = useState(false)
      const [workspaces, setWorkspaces] = useState(() => listSnapshot.workspaces)
      const [catalog, setCatalog] = useState(() => listSnapshot.catalog)
      const [presets, setPresets] = useState(() => listSnapshot.presets || { items: [], current: null })
      const [imCatalog, setImCatalog] = useState(() => listSnapshot.imCatalog || { available: true, options: [], loading: false })
      const [paneHost, setPaneHost] = useState(() => (typeof document === 'undefined' ? null : document.body))
      const skipAutoSelect = useRef(false)

      useEffect(() => {
        const bind = () => {
          const col = document.querySelector('[class*="centerCol"]')
          if (!col) {
            setPaneHost(document.body)
            return
          }
          if (col.getAttribute('data-dsh-ct-host') !== '1') col.setAttribute('data-dsh-ct-host', '1')
          setPaneHost((prev) => (prev === col ? prev : col))
        }
        bind()
        const obs = new MutationObserver(bind)
        if (document.body) obs.observe(document.body, { childList: true, subtree: true })
        return () => {
          obs.disconnect()
          document.querySelectorAll('[data-dsh-ct-host="1"]').forEach((el) => el.removeAttribute('data-dsh-ct-host'))
        }
      }, [])

      const loadImCatalog = useCallback(async () => {
        setImCatalog((prev) => ({ ...prev, loading: true }))
        try {
          const body = await api('/im-catalog')
          const next = {
            available: body.available !== false,
            options: Array.isArray(body.options) ? body.options : [],
            hint: body.hint || '',
            loading: false,
          }
          listSnapshot.imCatalog = next
          setImCatalog(next)
        } catch (err) {
          const next = {
            available: false,
            options: [],
            hint: err instanceof Error ? err.message : String(err),
            loading: false,
          }
          listSnapshot.imCatalog = next
          setImCatalog(next)
        }
      }, [])

      const load = useCallback(async () => {
        try {
          const [jobBody, histBody, wsBody, modelBody, presetBody] = await Promise.all([
            api('/jobs'),
            api('/history'),
            api('/workspaces').catch(() => ({ workspaces: [] })),
            api('/models').catch(() => ({ groups: [], current: null })),
            api('/presets').catch(() => ({ items: [], current: null })),
          ])
          const nextJobs = jobBody.jobs || []
          const nextRuns = histBody.runs || []
          const nextWorkspaces = wsBody.workspaces || []
          const nextViewer = jobBody.viewer || wsBody.viewer || histBody.viewer || null
          const nextCatalog = { groups: modelBody.groups || [], current: modelBody.current || null }
          const nextPresets = { items: presetBody.items || [], current: presetBody.current || null }
          listSnapshot.viewer = nextViewer
          setViewer(nextViewer)
          if (jobStamp(listSnapshot.jobs) !== jobStamp(nextJobs)) {
            listSnapshot.jobs = nextJobs
            setJobs(nextJobs)
          }
          if (runStamp(listSnapshot.runs) !== runStamp(nextRuns)) {
            listSnapshot.runs = nextRuns
            setRuns(nextRuns)
          }
          listSnapshot.workspaces = nextWorkspaces
          listSnapshot.catalog = nextCatalog
          listSnapshot.presets = nextPresets
          setWorkspaces(nextWorkspaces)
          setCatalog(nextCatalog)
          setPresets(nextPresets)
          faces.cronSessionIds = new Set(nextRuns.map((run) => run.sessionId).filter(Boolean))
          setError('')
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }, [])

      useEffect(() => {
        const readDomMode = () => {
          const root = document.querySelector('[data-dsh-ct-mode]')
          return root?.getAttribute('data-dsh-ct-mode') === 'on'
        }
        // Catch events missed before mount / after sidebar remount.
        setCronMode(readDomMode())
        load()
        const id = setInterval(load, cronMode ? 1500 : 4000)
        const onMode = (event) => setCronMode(!!event.detail)
        const onVis = () => { if (document.visibilityState === 'visible') load() }
        window.addEventListener('dsh-ct-mode', onMode)
        document.addEventListener('visibilitychange', onVis)
        const modeObs = new MutationObserver(() => {
          const next = readDomMode()
          setCronMode((prev) => (prev === next ? prev : next))
        })
        if (document.body) {
          modeObs.observe(document.body, {
            subtree: true,
            attributes: true,
            attributeFilter: ['data-dsh-ct-mode'],
          })
        }
        return () => {
          clearInterval(id)
          window.removeEventListener('dsh-ct-mode', onMode)
          document.removeEventListener('visibilitychange', onVis)
          modeObs.disconnect()
        }
      }, [load, cronMode])

      useEffect(() => {
        if (!cronMode || form.deliveryKind !== 'im') return
        loadImCatalog()
      }, [cronMode, form.deliveryKind, loadImCatalog])

      useEffect(() => {
        if (!cronMode) {
          skipAutoSelect.current = false
          faces.concealSessions?.()
          return
        }
      }, [cronMode])

      useEffect(() => {
        if (!cronMode || skipAutoSelect.current) return
        if (selection.type === 'run') {
          if (selection.jobId) setExpanded((prev) => ({ ...prev, [selection.jobId]: true }))
          return
        }
        if (jobs.length === 0) return
        if (selection.type === 'job' && selection.jobId && jobs.some((job) => job.id === selection.jobId)) {
          setExpanded((prev) => ({ ...prev, [selection.jobId]: true }))
          return
        }
        const job = jobs[0]
        setSelection({ type: 'job', jobId: job.id })
        setForm(jobToForm(job))
        setExpanded((prev) => ({ ...prev, [job.id]: true }))
      }, [cronMode, jobs])

      useEffect(() => {
        if (!cronMode || selection.type !== 'new') return
        setForm((prev) => {
          let next = prev
          if (!next.cwd) {
            const cwd = currentWorkspacePath(faces)
            if (cwd) next = { ...next, cwd }
          }
          if ((!next.provider || !next.model) && catalog.current?.provider && catalog.current?.model) {
            next = { ...next, provider: catalog.current.provider, model: catalog.current.model }
          }
          if (!next.agentPreset && presets.current?.id) {
            next = { ...next, agentPreset: presets.current.id }
          }
          return next
        })
      }, [cronMode, selection.type, catalog.current, presets.current])

      function selectJob(jobId) {
        const job = jobs.find((row) => row.id === jobId)
        setSelection({ type: 'job', jobId })
        setExpanded((prev) => ({ ...prev, [jobId]: true }))
        if (job) setForm(jobToForm(job))
      }

      function selectNew() {
        skipAutoSelect.current = true
        setSelection({ type: 'new' })
        const next = emptyForm(undefined, catalog.current)
        next.cwd = currentWorkspacePath(faces)
        setForm(next)
      }

      async function selectRun(jobId, run) {
        setSelection({ type: 'run', jobId, runId: run.id })
        setExpanded((prev) => ({ ...prev, [jobId]: true }))
        setError('')
        if (!run.sessionId) {
          setError('这次运行没有可打开的会话')
          return
        }
        try {
          await api(`/runs/${run.id}/open`, { method: 'POST' })
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        }
        const opened = await faces.openSession?.(run.sessionId)
        if (opened === false) setError('打不开这次对话，会话可能已被删除')
      }

      function currentSessionId(faces) {
        try {
          const snap = faces?.sessions?.list?.getSnapshot?.()
          const current = snap?.current
          return typeof current === 'string' && current.trim() ? current.trim() : ''
        } catch {
          return ''
        }
      }

      async function save() {
        try {
          const atValue = form.kind === 'at' ? localInputToAt(form.at, form.timezone) : form.at
          const schedule = form.kind === 'at'
            ? { kind: 'at', at: atValue, timezone: form.timezone }
            : { kind: 'cron', expr: form.expr, timezone: form.timezone }
          const payload = {
            name: form.name, prompt: form.prompt, schedule,
            cwd: form.cwd, timeoutMinutes: form.timeoutMinutes, enabled: form.enabled,
            provider: form.provider, model: form.model,
            agentPreset: form.agentPreset || '',
            delivery: form.deliveryKind === 'im'
              ? { kind: 'im', botId: form.imBotId, targetId: form.imTargetId }
              : { kind: 'dsh' },
          }
          if (selection.type === 'job' && selection.jobId) {
            await api(`/jobs/${selection.jobId}`, { method: 'PATCH', body: JSON.stringify(payload) })
          } else {
            const originSessionId = currentSessionId(faces)
            if (originSessionId) payload.origin = { kind: 'web', sessionId: originSessionId }
            const created = await api('/jobs', { method: 'POST', body: JSON.stringify(payload) })
            setSelection({ type: 'job', jobId: created.job.id })
          }
          await load()
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }

      async function run(jobId) {
        try {
          const result = await api(`/jobs/${jobId}/run`, { method: 'POST' })
          await load()
          if (result.run?.sessionId) {
            setSelection({ type: 'run', jobId, runId: result.run.id })
            try {
              await api(`/runs/${result.run.id}/open`, { method: 'POST' })
            } catch { /* reveal is best-effort */ }
            await faces.openSession?.(result.run.sessionId)
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }

      const lastOutput = (() => {
        const jobId = selection.jobId
        if (!jobId) return ''
        const mine = runs.filter((run) => run.jobId === jobId)
        return mine[0]?.summary || ''
      })()
      const selectedJob = jobs.find((row) => row.id === selection.jobId)

      const showEditor = cronMode && selection.type !== 'run'
      const editor = h('div', { className: 'dsh-ct-main', 'data-open': showEditor ? 'true' : 'false' },
        h(JobEditor, {
          t, form, setForm, isNew: selection.type === 'new', error, lastOutput,
          nextRunAt: selectedJob?.nextRunAt,
          lastRunAt: selectedJob?.lastRunAt,
          workspaces,
          catalog,
          presets,
          imCatalog,
          viewer,
          onSave: save,
          onRun: () => selection.jobId && run(selection.jobId),
          onPause: () => {
            const job = jobs.find((row) => row.id === selection.jobId)
            if (!job) return
            api(`/jobs/${job.id}/${job.enabled !== false ? 'pause' : 'resume'}`, { method: 'POST' })
              .then(() => {
                setForm((prev) => ({ ...prev, enabled: job.enabled === false }))
                return load()
              })
              .catch((err) => setError(err.message))
          },
          onRemove: () => selection.jobId && api(`/jobs/${selection.jobId}`, { method: 'DELETE' }).then(() => { selectNew(); return load() }),
        }),
      )

      return h(React.Fragment, null,
        h(JobList, {
          t, jobs, runs, selection, viewer, expanded, error,
          onSelectJob: selectJob,
          onSelectRun: selectRun,
          onNew: selectNew,
          onRun: (id) => run(id),
          onToggle: (job) => api(`/jobs/${job.id}/${job.enabled ? 'pause' : 'resume'}`, { method: 'POST' }).then(load).catch((err) => setError(err.message)),
          onRemove: (id) => api(`/jobs/${id}`, { method: 'DELETE' }).then(() => { selectNew(); return load() }).catch((err) => setError(err.message)),
          onToggleGroup: (id) => setExpanded((prev) => ({ ...prev, [id]: prev[id] !== true })),
        }),
        paneHost ? ReactDOM.createPortal(editor, paneHost) : null,
      )
    }

    function findNewSessionButton() {
      const buttons = [...document.querySelectorAll('button')]
      for (const button of buttons) {
        if (button.dataset.plugin === name) continue
        const text = (button.textContent || '').replace(/\s+/g, '')
        if (text === '新会话' || text === 'NewSession') return button
      }
      for (const button of buttons) {
        if (button.dataset.plugin === name) continue
        const label = button.getAttribute('aria-label') || ''
        if (label !== '新建会话' && label !== 'New session') continue
        const cls = String(button.className || '')
        if (cls.includes('brand') || button.closest('[class*="logoRow"]')) continue
        return button
      }
      return null
    }

    function findSidebarRoot(button) {
      let node = button
      while (node && node !== document.body) {
        if (node.className && String(node.className).includes('_root')) return node
        node = node.parentElement
      }
      return button.parentElement
    }

    function findRegionArea(root) {
      if (!root) return null
      return root.querySelector('[class*="regionArea"]')
    }

    function isCronTitle(text) {
      const value = String(text || '').trim()
      return value.startsWith('定时任务')
        || value.startsWith('运维定时')
        || value.startsWith(TITLE_PREFIX.trim())
        || value.includes(TITLE_PREFIX)
    }

    function workspaceTitleFromCronFork(title) {
      const value = String(title || '').trim()
      if (value.startsWith(TITLE_PREFIX)) return value.slice(TITLE_PREFIX.length).trim() || value
      if (value.startsWith('运维定时')) {
        const stripped = value.replace(/^运维定时(?:\s*·\s*|\s+)/, '').trim()
        return stripped || value
      }
      if (value.startsWith('定时任务')) {
        const stripped = value.replace(/^定时任务(?:\s*·\s*|\s+)/, '').trim()
        return stripped || value
      }
      return value
    }

    function shouldPromoteCronFork(row, cronSessionIds, previousId) {
      if (!row || typeof row !== 'object') return false
      const id = String(row.id || row.sessionId || '').trim()
      if (!id) return false
      const ids = cronSessionIds instanceof Set ? cronSessionIds : new Set(cronSessionIds || [])
      if (ids.has(id)) return false
      const parent = String(row.parentId || row.parentSessionId || '').trim()
      if (parent && ids.has(parent)) return true
      const title = String(row.title || row.displayTitle || '')
      const looksCron = title.startsWith(TITLE_PREFIX) || title.startsWith('定时任务') || title.startsWith('运维定时')
      if (previousId && ids.has(String(previousId)) && looksCron) return true
      return false
    }

    function isUngroupedLabel(text) {
      const value = String(text || '').trim()
      return value === '未分组' || value === '未分类' || value === 'Ungrouped'
    }

    function hideNativeCronRows(root) {
      if (!root || root.getAttribute('data-dsh-ct-mode') === 'on') return
      const region = findRegionArea(root)
      if (!region) return
      const groups = region.querySelectorAll('[class*="groupSection"]')
      if (groups.length === 0) {
        const rows = region.querySelectorAll('[class*="sessionRow"], [class*="projectRow"]')
        for (const row of rows) {
          row.style.display = ''
          if (isCronTitle(row.textContent)) row.style.display = 'none'
        }
        return
      }
      for (const group of groups) {
        group.style.display = ''
        const project = group.querySelector('[class*="projectRow"]')
        const sessions = [...group.querySelectorAll('[class*="sessionRow"]')]
        for (const row of sessions) {
          row.style.display = ''
          if (isCronTitle(row.textContent)) row.style.display = 'none'
        }
        const visible = sessions.filter((row) => row.style.display !== 'none')
        const label = (project?.textContent || '').trim()
        if (sessions.length > 0 && visible.length === 0 && (isUngroupedLabel(label) || isCronTitle(label))) {
          group.style.display = 'none'
        }
      }
    }

    function setCronMode(root, on, entry, t) {
      if (!root) return
      root.setAttribute('data-dsh-ct-mode', on ? 'on' : 'off')
      const width = root.getBoundingClientRect().width
      document.documentElement.style.setProperty('--dsh-ct-sidebar', `${Math.round(width)}px`)
      if (entry) {
        const label = entry.querySelector('span')
        if (label) label.textContent = on ? t('backToWorkspace') : t('entry')
        entry.setAttribute('aria-label', on ? t('backLabel') : t('entryLabel'))
      }
      window.dispatchEvent(new CustomEvent('dsh-ct-mode', { detail: on }))
    }

    function sidebarCollapsed(found) {
      const root = findSidebarRoot(found)
      return !!(root && /(?:^|\s)[\w-]*_collapsed(?:\s|$)/.test(String(root.className || '')))
    }

    function syncEntryLook(entry, found) {
      if (!entry || !found) return
      const nativeClass = String(found.className || '').trim()
      entry.className = nativeClass ? `${nativeClass} dsh-ct-entry` : 'dsh-ct-entry'
      const nativeLabel = found.querySelector('span')
      const label = entry.querySelector('span')
      if (nativeLabel && label) label.className = `${nativeLabel.className} dsh-ct-entryLabel`.trim()
      const cs = getComputedStyle(found)
      const collapsed = sidebarCollapsed(found) || Number.parseFloat(cs.width) <= 40
      entry.dataset.collapsed = collapsed ? 'true' : 'false'
      entry.style.borderRadius = cs.borderRadius
      entry.style.height = collapsed ? '36px' : cs.height
      entry.style.width = collapsed ? '36px' : ''
      entry.style.padding = collapsed ? '0px' : cs.padding
      entry.style.gap = collapsed ? '0px' : cs.gap
      entry.style.margin = collapsed ? '0 0 12px' : cs.margin
      entry.style.justifyContent = 'center'
      entry.style.alignItems = 'center'
      entry.style.alignSelf = collapsed ? 'flex-start' : ''
      entry.style.fontSize = cs.fontSize
      entry.style.fontWeight = cs.fontWeight
      entry.style.lineHeight = cs.lineHeight
      entry.style.border = cs.border
      entry.style.backgroundColor = cs.backgroundColor
      entry.style.boxShadow = cs.boxShadow
      entry.style.color = cs.color
      if (label) {
        label.style.display = collapsed ? 'none' : ''
        label.style.maxWidth = collapsed ? '0' : ''
        label.style.minWidth = collapsed ? '0' : ''
        label.style.opacity = collapsed ? '0' : ''
        label.style.margin = collapsed ? '0' : ''
        label.setAttribute('aria-hidden', collapsed ? 'true' : 'false')
      }
      const nativeSvg = found.querySelector('svg')
      const icon = entry.querySelector('svg')
      if (icon) {
        const size = collapsed
          ? (nativeSvg ? Math.round(nativeSvg.getBoundingClientRect().width) || 18 : 18)
          : (nativeSvg?.getAttribute('width') || '14')
        icon.setAttribute('width', String(size))
        icon.setAttribute('height', String(size))
        icon.style.position = collapsed ? 'absolute' : ''
        icon.style.left = collapsed ? '50%' : ''
        icon.style.top = collapsed ? '50%' : ''
        icon.style.transform = collapsed ? 'translate(-50%, -50%)' : ''
      }
    }

    function installChrome(t, faces) {
      let entry = null
      let listRoot = null
      let appRoot = null
      let cronOn = false
      let placing = false
      const observer = new MutationObserver(() => {
        if (placing) return
        schedulePlace()
      })
      let placeRaf = 0
      function schedulePlace() {
        if (placeRaf) return
        placeRaf = window.requestAnimationFrame(() => {
          placeRaf = 0
          place()
        })
      }

      const place = () => {
        const found = findNewSessionButton()
        if (!found) return
        if (!hasUdsLoginCookie()) {
          if (entry && entry.isConnected) entry.remove()
          if (listRoot && listRoot.isConnected) listRoot.remove()
          if (cronOn) {
            cronOn = false
            setCronMode(findSidebarRoot(found), false, entry, t)
          }
          return
        }
        const sidebar = findSidebarRoot(found)
        const region = findRegionArea(sidebar)
        let anchor = found
        while (anchor.parentElement && anchor.parentElement !== sidebar) anchor = anchor.parentElement
        placing = true
        observer.disconnect()
        try {
          if (!entry || !entry.isConnected) {
            entry = document.createElement('button')
            entry.type = 'button'
            entry.className = 'dsh-ct-entry'
            entry.setAttribute('aria-label', t('entryLabel'))
            entry.dataset.plugin = name
            entry.addEventListener('click', (event) => {
              event.preventDefault()
              cronOn = !cronOn
              const live = findNewSessionButton() || found
              setCronMode(findSidebarRoot(live), cronOn, entry, t)
            })
            const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
            icon.setAttribute('viewBox', '0 0 16 16')
            icon.setAttribute('width', '14')
            icon.setAttribute('height', '14')
            icon.setAttribute('fill', 'none')
            icon.setAttribute('stroke', 'currentColor')
            icon.setAttribute('stroke-width', '1.5')
            icon.setAttribute('aria-hidden', 'true')
            const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
            c.setAttribute('cx', '8'); c.setAttribute('cy', '8'); c.setAttribute('r', '6')
            const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
            p.setAttribute('d', 'M8 4.5v4l2.5 1.5')
            icon.appendChild(c); icon.appendChild(p)
            const label = document.createElement('span')
            label.className = 'dsh-ct-entryLabel'
            label.textContent = t('entry')
            entry.append(icon, label)
          }
          syncEntryLook(entry, found)
          const label = entry.querySelector('span')
          if (label) label.textContent = cronOn ? t('backToWorkspace') : t('entry')
          entry.setAttribute('aria-label', cronOn ? t('backLabel') : t('entryLabel'))
          if (anchor.parentNode && anchor.nextSibling !== entry) {
            if (anchor.nextSibling) anchor.parentNode.insertBefore(entry, anchor.nextSibling)
            else anchor.parentNode.appendChild(entry)
          }

          if (!found.dataset.dshCtBound) {
            found.dataset.dshCtBound = '1'
            found.addEventListener('click', () => {
              cronOn = false
              setCronMode(findSidebarRoot(found), false, entry, t)
            })
          }

          if (region) {
            if (!listRoot) {
              listRoot = document.createElement('div')
              listRoot.className = 'dsh-ct-region'
              listRoot.setAttribute('data-plugin', name)
              const hostApi = require('react-dom/client')
              appRoot = hostApi.createRoot(listRoot)
              appRoot.render(h(CronApp, { t, faces }))
            }
            if (listRoot.parentElement !== region) region.appendChild(listRoot)
          }

          hideNativeCronRows(sidebar)
          if (sidebar) {
            // Keep DOM mode attribute in sync after remounts so React overlay can follow.
            const want = cronOn ? 'on' : 'off'
            if (sidebar.getAttribute('data-dsh-ct-mode') !== want) {
              sidebar.setAttribute('data-dsh-ct-mode', want)
              window.dispatchEvent(new CustomEvent('dsh-ct-mode', { detail: cronOn }))
            }
            const width = sidebar.getBoundingClientRect().width
            const next = `${Math.round(width)}px`
            if (document.documentElement.style.getPropertyValue('--dsh-ct-sidebar') !== next) {
              document.documentElement.style.setProperty('--dsh-ct-sidebar', next)
            }
          }
        } finally {
          placing = false
          if (document.body) observer.observe(document.body, { childList: true, subtree: true })
        }
      }

      faces.leaveCronMode = () => {
        if (!cronOn) return
        cronOn = false
        const found = findNewSessionButton()
        setCronMode(findSidebarRoot(found), false, entry, t)
      }

      place()
      const onAuth = () => { place() }
      window.addEventListener('focus', onAuth)
      window.addEventListener('uds-auth-changed', onAuth)
      let boots = 0
      const boot = () => {
        boots += 1
        if (!entry || !entry.isConnected) place()
        if (boots < 40) requestAnimationFrame(boot)
      }
      requestAnimationFrame(boot)
      const timer = setInterval(place, 4000)
      return () => {
        window.removeEventListener('focus', onAuth)
        window.removeEventListener('uds-auth-changed', onAuth)
        observer.disconnect()
        clearInterval(timer)
        if (placeRaf) cancelAnimationFrame(placeRaf)
        if (appRoot) appRoot.unmount()
        if (entry) entry.remove()
        if (listRoot) listRoot.remove()
        faces.leaveCronMode = () => {}
        document.querySelectorAll('[data-dsh-ct-mode]').forEach((el) => el.removeAttribute('data-dsh-ct-mode'))
      }
    }

    function apply(ctx) {
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.setAttribute('data-plugin', name)
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => tag.remove()
      }, 'dsh-ops-cron: styles')

      ctx.effect(() => {
        try {
          return ctx.locale.register(LOCALE_NS, { zh, en })
        } catch {
          const offZh = ctx.locale.register(LOCALE_NS, 'zh', zh)
          const offEn = ctx.locale.register(LOCALE_NS, 'en', en)
          return () => { offZh && offZh(); offEn && offEn() }
        }
      }, 'dsh-ops-cron: locale')

      const scope = ctx.settingsScope.bind({ namespace: NS })
      const form = createForm(scope)
      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
        name: 'settings.plugin.item',
        key: NS,
        locale: LOCALE_NS,
        inject: () => ({
          hooks: { card: form.store },
          edit: (field, value) => form.edit(field, value),
          save: () => { form.save() },
          discard: () => form.discard(),
        }),
      }, SettingsCard))

      const faces = {
        sessions: undefined,
        workspaces: undefined,
        cronSessionIds: new Set(),
        leaveCronMode() {},
        async openSession(sessionId) {
          const deadline = Date.now() + 4000
          let lastError = null
          while (Date.now() < deadline) {
            const sessions = getService(ctx, faces, 'sessions')
            const workspaces = getService(ctx, faces, 'workspaces')
            if (!sessions || typeof sessions.open !== 'function') {
              await sleep(50)
              continue
            }
            const archived = workspaces?.list?.getSnapshot?.()?.archivedSessionIds || []
            if (archived.includes(sessionId) && Date.now() < deadline - 2500) {
              try { await workspaces.refresh?.() } catch { /* ignore */ }
              await sleep(80)
              continue
            }
            const snap = sessions.list?.getSnapshot?.()
            const known = !!(
              snap?.byId?.[sessionId]
              || (Array.isArray(snap?.ids) && snap.ids.includes(sessionId))
              || (Array.isArray(snap?.items) && snap.items.some((row) => row.sessionId === sessionId || row.id === sessionId))
            )
            if (!known) {
              try { await sessions.refresh?.() } catch { /* ignore */ }
              await sleep(80)
              continue
            }
            try {
              sessions.open(sessionId)
            } catch (error) {
              lastError = error
              console.warn('[dsh-ops-cron] open session failed', sessionId, error)
              try { await sessions.refresh?.() } catch { /* ignore */ }
              await sleep(80)
              continue
            }
            await sleep(30)
            if (sessions.list?.getSnapshot?.()?.current === sessionId) {
              await sleep(40)
              if (sessions.list?.getSnapshot?.()?.current === sessionId) return true
            }
          }
          if (lastError) console.warn('[dsh-ops-cron] giving up open', sessionId, lastError)
          else console.warn('[dsh-ops-cron] open session timed out', sessionId)
          return false
        },
        clearSession() {
          try {
            getService(ctx, faces, 'sessions')?.clear?.()
          } catch { /* ignore */ }
        },
        concealSessions() {
          api('/conceal', { method: 'POST' }).catch(() => {})
        },
      }
      ctx.effect(() => {
        const offs = []
        try {
          const off = ctx.inject(['sessions'], (sctx) => {
            faces.sessions = sctx.sessions || sctx.get?.('sessions')
          })
          if (typeof off === 'function') offs.push(off)
        } catch { /* optional: static inject of sessions deadlocks boot */ }
        try {
          const off = ctx.inject(['workspaces'], (sctx) => {
            faces.workspaces = sctx.workspaces || sctx.get?.('workspaces')
          })
          if (typeof off === 'function') offs.push(off)
        } catch { /* optional */ }
        try {
          const off = ctx.on?.('internal/service', (serviceName, value) => {
            if (serviceName === 'sessions') faces.sessions = value
            if (serviceName === 'workspaces') faces.workspaces = value
          })
          if (typeof off === 'function') offs.push(off)
        } catch { /* optional */ }
        return () => { for (const off of offs) off() }
      }, 'dsh-ops-cron: session faces')

      ctx.effect(() => {
        const promoted = new Set()
        let previousId
        let unsub
        const consider = async (sessions) => {
          const snap = sessions.list?.getSnapshot?.()
          if (!snap) return
          const current = snap.current
          const raw = current ? snap.byId?.[current] : null
          const row = current ? { id: current, ...raw } : null
          const prev = previousId
          previousId = current
          if (!row?.id || promoted.has(row.id)) return
          if (!shouldPromoteCronFork(row, faces.cronSessionIds, prev)) return
          promoted.add(row.id)
          const nextTitle = workspaceTitleFromCronFork(row.title || row.displayTitle || '')
          try {
            if (nextTitle && nextTitle !== (row.title || row.displayTitle)) {
              const session = sessions.binding?.(row.id)?.session
              if (session && typeof session.rename === 'function') await session.rename(nextTitle)
            }
          } catch (error) {
            console.warn('[dsh-ops-cron] fork rename failed', row.id, error)
          }
          try {
            await api(`/sessions/${encodeURIComponent(row.id)}/adopt`, { method: 'POST' })
          } catch (error) {
            console.warn('[dsh-ops-cron] fork adopt failed', row.id, error)
          }
          try { faces.leaveCronMode?.() } catch { /* ignore */ }
        }
        const attach = () => {
          const sessions = getService(ctx, faces, 'sessions')
          if (!sessions?.list?.subscribe) return false
          unsub = sessions.list.subscribe(() => { void consider(sessions) })
          void consider(sessions)
          return true
        }
        let tries = 0
        const timer = setInterval(() => {
          if (unsub) {
            clearInterval(timer)
            return
          }
          tries += 1
          if (attach() || tries > 80) clearInterval(timer)
        }, 250)
        attach()
        return () => {
          clearInterval(timer)
          if (typeof unsub === 'function') unsub()
        }
      }, 'dsh-ops-cron: fork promote')

      ctx.effect(() => {
        const lang = ctx.locale?.locale || ctx.locale?.current || 'zh'
        const dict = String(lang).toLowerCase().startsWith('zh') ? zh : en
        const t = (key) => dict[key] || zh[key] || key
        return installChrome(t, faces)
      }, 'dsh-ops-cron: chrome')
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
