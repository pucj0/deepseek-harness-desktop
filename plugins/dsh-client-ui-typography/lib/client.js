// Use the public settings/slot contracts; never patch the installed upstream packages.
window.__ModuleLoader__.load({
  id: 'dsh-client-ui-typography',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const DEFAULT = 14
    const MIN = 12
    const MAX = 20
    // 本地命名空间：语言包与小节槽位用它，与宿主设置无关，因此两个版本都一样。
    const NS = 'desktop-ui-typography'
    // ≥0.1.7 的设置命名空间 = 组合行 id（见 cordis.patch.yml 与本包的 lib/index.js）。
    const ENTRY_NAMESPACE = 'ui-typography'
    // ≤0.1.6 的设置命名空间：插件自报，值落在 <home>/settings.yaml。
    const LEGACY_NAMESPACE = 'desktop-ui-typography'
    const normalize = (value, max = MAX) => Number.isFinite(Number(value))
      ? Math.max(MIN, Math.min(max, Math.round(Number(value)))) : DEFAULT

    /**
     * Codex's desktop typography uses round(originalSize * uiSize / defaultSize).
     * DSH currently ships px declarations instead of shared UI size tokens. Adapt
     * typography declarations once, retaining selectors, cascade and media rules.
     * Changing the preference subsequently only updates root CSS variables.
     * Content-owned variables/em sizes, geometry, icons and browser zoom stay intact.
     */
    function installTypography(doc, initialSize) {
      const root = doc.documentElement
      const tokens = new Map()
      const originals = new Set()
      const byStyle = new WeakMap()
      const sheets = new WeakSet()
      let size = normalize(initialSize)
      const token = (px) => {
        const value = Number(px)
        const name = `--dsh-ui-px-${String(value).replace('.', '_')}`
        if (!tokens.has(name)) {
          tokens.set(name, value)
          root.style.setProperty(name, `${size === DEFAULT ? value : Math.round(value * size / DEFAULT)}px`)
        }
        return `var(${name}, ${px}px)`
      }
      const adapt = (style) => {
        if (!style || style === root.style) return
        // Keep only weak references to inline styles so long conversations can be GC'd.
        const remember = (property, before, after) => {
          const priority = style.getPropertyPriority(property)
          let record = byStyle.get(style)
          if (!record) {
            record = { style: new WeakRef(style), properties: new Map() }
            byStyle.set(style, record)
            originals.add(record)
          }
          record.properties.set(property, { before, after, priority })
          style.setProperty(property, after, priority)
        }
        const content = /--dsh-content-|--dsw-font-markdown/.test(
          style.getPropertyValue('font-size') + style.getPropertyValue('font'))
        for (const property of [...style]) {
          const value = style.getPropertyValue(property)
          if (property.startsWith('--dsw-font-') && !property.startsWith('--dsw-font-markdown') &&
              !property.includes('font-family') && !value.includes('--dsh-ui-px-')) {
            const next = value.replace(/\b(\d+(?:\.\d+)?)px\b/g, (_, px) => token(px))
            if (next !== value) remember(property, value, next)
          }
        }
        if (content) return
        // CSSOM expands numeric font shorthands into these longhands as well.
        for (const property of ['font-size', 'line-height']) {
          const value = style.getPropertyValue(property)
          const match = /^(\d+(?:\.\d+)?)px$/.exec(value)
          if (match && Number(match[1]) > 0) remember(property, value, token(match[1]))
        }
      }
      const rules = (list) => {
        for (const rule of list) {
          if (rule.style) adapt(rule.style)
          if (rule.cssRules) rules(rule.cssRules)
        }
      }
      const sheet = (node, force = false) => {
        const value = node.sheet
        if (!value || (!force && sheets.has(value))) return
        try { rules(value.cssRules); sheets.add(value) } catch { /* Cross-origin sheet. */ }
      }
      const visit = (node) => {
        if (node.nodeType !== 1) return
        if (node.matches('style, link[rel="stylesheet"]')) sheet(node)
        if (node.hasAttribute('style')) adapt(node.style)
        for (const child of node.querySelectorAll('style, link[rel="stylesheet"], [style]')) {
          if (child.hasAttribute('style')) adapt(child.style)
          if (child.matches('style, link[rel="stylesheet"]')) sheet(child)
        }
      }
      visit(root)
      const observer = new MutationObserver((changes) => {
        for (const change of changes) {
          if (change.type === 'attributes') adapt(change.target.style)
          else if (change.target.nodeName === 'STYLE') sheet(change.target, true)
          else if (change.target.parentElement?.nodeName === 'STYLE') sheet(change.target.parentElement, true)
          else for (const node of change.addedNodes) visit(node)
        }
      })
      observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style'] })
      const loaded = (event) => {
        if (event.target?.matches?.('link[rel="stylesheet"]')) sheet(event.target)
      }
      doc.addEventListener('load', loaded, true)
      return {
        setSize(next) {
          size = normalize(next)
          root.dataset.dshUiFontSize = String(size)
          for (const record of originals) if (!record.style.deref()) originals.delete(record)
          for (const [name, px] of tokens) {
            root.style.setProperty(name, `${size === DEFAULT ? px : Math.round(px * size / DEFAULT)}px`)
          }
        },
        dispose() {
          observer.disconnect()
          doc.removeEventListener('load', loaded, true)
          for (const record of originals) {
            const style = record.style.deref()
            if (!style) continue
            for (const [property, { before, after, priority }] of record.properties) {
              if (style.getPropertyValue(property) === after) style.setProperty(property, before, priority)
            }
          }
          for (const name of tokens.keys()) root.style.removeProperty(name)
        },
      }
    }

    const css = `
      .dsh-ui-font-row{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
      .dsh-ui-font-copy{display:flex;flex-direction:column;gap:4px;min-width:0}
      .dsh-ui-font-title{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
      .dsh-ui-font-description{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
      .dsh-ui-font-control{display:flex;align-items:center;flex:none;gap:8px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary)}
      .dsh-ui-font-stepper{display:flex;align-items:center;min-height:36px;border-radius:18px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary)}
      .dsh-ui-font-stepper button,.dsh-ui-font-reset{border:0;background:none;color:inherit;font:inherit;cursor:pointer;border-radius:12px;padding:6px 8px;min-width:28px}
      .dsh-ui-font-stepper button:hover:not(:disabled),.dsh-ui-font-reset:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .dsh-ui-font-stepper button:disabled,.dsh-ui-font-reset:disabled{opacity:.35;cursor:default}
      .dsh-ui-font-stepper input{width:3ch;min-width:0;border:0;background:none;color:inherit;font:inherit;text-align:center;font-variant-numeric:tabular-nums;appearance:textfield;padding:4px 0}
      .dsh-ui-font-stepper input::-webkit-inner-spin-button,.dsh-ui-font-stepper input::-webkit-outer-spin-button{appearance:none;margin:0}
      .dsh-ui-font-control :focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}
      .dsh-ui-font-error{color:var(--dsw-alias-state-error-primary)}
      @media(max-width:600px){.dsh-ui-font-row{align-items:flex-start;flex-wrap:wrap;gap:12px}}
    `
    const zh = {
      title: 'UI 字号', description: '调整侧栏、菜单、设置等界面文字',
      increase: '增大 UI 字号', decrease: '减小 UI 字号', reset: '恢复默认 UI 字号（14 px）',
      error: '字号保存失败，请重试',
      'conversation.title': '会话字号', 'conversation.description': '仅影响会话内容的字号',
      'conversation.increase': '增大会话字号', 'conversation.decrease': '减小会话字号',
      'conversation.reset': '恢复默认会话字号（14 px）',
    }
    const en = {
      title: 'UI font size', description: 'Adjust text in sidebars, menus and settings',
      increase: 'Increase UI font size', decrease: 'Decrease UI font size', reset: 'Reset UI font size (14 px)',
      error: 'Could not save the font size. Please try again.',
      'conversation.title': 'Conversation font size', 'conversation.description': 'Only affects conversation content',
      'conversation.increase': 'Increase conversation font size', 'conversation.decrease': 'Decrease conversation font size',
      'conversation.reset': 'Reset conversation font size (14 px)',
    }

    function FontSizeRow({ t, model, inputId, prefix = '' }) {
      const state = React.useSyncExternalStore(model.subscribe, model.getSnapshot)
      const [draft, setDraft] = React.useState(String(state.size))
      React.useEffect(() => { setDraft(String(state.size)) }, [state.size])
      const commit = () => {
        const next = draft.trim() === '' ? state.size : normalize(draft, model.max)
        setDraft(String(next))
        model.setSize(next)
      }
      const disabled = state.pending || !state.writable
      return h('div', { className: 'dsh-ui-font-row' },
        h('div', { className: 'dsh-ui-font-copy' },
          h('label', { className: 'dsh-ui-font-title', htmlFor: inputId }, t(`${prefix}title`)),
          h('div', { className: 'dsh-ui-font-description', id: `${inputId}-description` }, t(`${prefix}description`)),
          state.error ? h('div', { className: 'dsh-ui-font-description dsh-ui-font-error', role: 'alert' }, t('error')) : null),
        h('div', { className: 'dsh-ui-font-control' },
          h('div', { className: 'dsh-ui-font-stepper' },
            h('button', { type: 'button', 'aria-label': t(`${prefix}decrease`), disabled: disabled || state.size <= MIN, onClick: () => model.setSize(state.size - 1) }, '−'),
            h('input', { id: inputId, type: 'number', min: MIN, max: model.max, step: 1,
              'aria-describedby': `${inputId}-description`, value: draft, disabled,
              onChange: (event) => setDraft(event.target.value), onBlur: commit,
              onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } } }),
            h('button', { type: 'button', 'aria-label': t(`${prefix}increase`), disabled: disabled || state.size >= model.max, onClick: () => model.setSize(state.size + 1) }, '+')),
          h('span', null, 'px'),
          h('button', { type: 'button', className: 'dsh-ui-font-reset', title: t(`${prefix}reset`), 'aria-label': t(`${prefix}reset`), disabled: disabled || state.size === DEFAULT, onClick: () => model.setSize(DEFAULT) }, '↺')))
    }

    function createFontSizeModel(ctx, scope, { max = MAX, initialSize = DEFAULT, onSize = () => {} } = {}) {
      const listeners = new Set()
      let state = { size: normalize(initialSize, max), pending: false, writable: false, error: false }
      const publish = (patch) => { state = { ...state, ...patch }; onSize(state.size); for (const fn of listeners) fn() }
      const adopt = () => {
        if (state.pending) return
        const snapshot = scope.getSnapshot()
        publish({ size: snapshot.value?.fontSize ?? state.size, writable: snapshot.writable })
      }
      const model = {
        max,
        subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
        getSnapshot: () => state,
        async setSize(value) {
          if (state.pending || !state.writable) return
          const next = normalize(value, max)
          if (next === state.size) return
          const previous = state.size
          publish({ size: next, pending: true, error: false })
          try {
            if (await scope.set('fontSize', next) === false) throw new Error('Font size was not saved')
            publish({ pending: false }); adopt()
          }
          catch { publish({ size: scope.getSnapshot().value?.fontSize ?? previous, pending: false, error: true }) }
        },
      }
      ctx.effect(() => scope.subscribe(adopt))
      adopt()
      return model
    }

    function activate(ctx, getScope, settingsNamespace) {
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-client-ui-typography'
      style.textContent = css
      ctx.effect(() => { document.head.appendChild(style); return () => style.remove() })
      const initialSize = document.documentElement.dataset.dshUiFontSize ?? DEFAULT
      const typography = installTypography(document, initialSize)
      ctx.effect(() => () => typography.dispose())
      const model = createFontSizeModel(ctx, getScope(settingsNamespace), {
        initialSize, onSize: (size) => typography.setSize(size),
      })
      // Reuse the upstream namespace so existing conversation preferences and the
      // theme presenter's content-size updates remain authoritative.
      const conversationModel = createFontSizeModel(ctx, getScope('ui-theme'), { max: 17 })
      ctx.effect(() => ctx.locale.register(NS, { zh, en }))
      ctx.effect(() => ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item', id: 'desktop-ui-font-size', order: 10.5, locale: NS,
        inject: () => ({ t: ctx.locale.bind(NS), model, inputId: 'dsh-ui-font-size' }),
      }, FontSizeRow)))
      // List slots support priority-based replacement for the same id. Releasing
      // this registration reveals the upstream row again without editing its bundle.
      ctx.effect(() => ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item', id: 'font-size', priority: -10, order: 11, locale: NS,
        inject: () => ({ t: ctx.locale.bind(NS), model: conversationModel, inputId: 'dsh-conversation-font-size', prefix: 'conversation.' }),
      }, FontSizeRow)))
    }
    function apply(ctx) {
      // 设置命名空间随 dsh 版本换过一次（0.1.7 = 组合行 id），所以这里**按服务存在与否**
      // 选路，而不是按版本号：两个服务在任一时点上最多只有一个存在。
      //
      //   * `configForms`（≥0.1.7）：命名空间是行 id（`ui-typography`），
      //     写回走 profile patch；
      //   * `settingsScope`（≤0.1.6）：插件自报命名空间，
      //     写回走 <home>/settings.yaml。
      //
      // 用错命名空间的后果不是报错而是"行看起来在、保存不了"（宿主按行 id 解析
      // `settings.update`，找不到就拒绝），因此两者必须各取各的。
      ctx.inject(['configForms'], (scoped) => activate(scoped, (namespace) => scoped.configForms.get(namespace), ENTRY_NAMESPACE))
      ctx.inject(['settingsScope'], (scoped) => activate(scoped, (namespace) => scoped.settingsScope.bind({ namespace }), LEGACY_NAMESPACE))
    }
    return { name: 'ui-typography', inject: ['slots', 'locale', 'remote'], apply }
  },
})
