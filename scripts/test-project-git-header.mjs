import assert from 'node:assert/strict'

let plugin
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState: (value) => [value, () => {}],
}
const primitives = { Tooltip: 'tooltip', Button: 'button', IconBranchOutlineRegular: 'branch-icon', IconPanelLeftOutlineRegular: 'panel-icon' }
globalThis.window = { __ModuleLoader__: { load: ({ factory }) => { plugin = factory((name) => name === 'react' ? react : primitives) } } }
globalThis.document = {
  createElement: () => ({ dataset: {}, remove() {} }),
  head: { appendChild() {} },
}
await import('../plugins/dsh-client-ui-review/lib/client.js')
const registrations = []
const ctx = {
  effect: (fn) => fn(),
  locale: { register: () => {}, bind: () => (key) => key },
  slots: {
    inject: (_slot, fn) => fn(),
    register: (options, component) => { registrations.push({ options, component }); return () => {} },
  },
  sidebarRightTabs: { register: () => () => {} },
  sidebarRight: {},
}
plugin.apply(ctx)
const header = registrations.find(({ options }) => options.name === 'conversation.session.header.corner')
assert.ok(header)
assert.ok(header.options.priority < 0, 'must replace the default corner control without a slot collision')
const buttons = (sessionId) => header.component({ ...header.options.inject(), sessionId }).props.children.map((node) => node.props.children[0])
const gitButton = (sessionId) => buttons(sessionId).find((node) => node.props['data-project-git-open'] !== undefined)
const calls = []
let expanded = false
ctx.sidebarRight = {
  openTab: (kind, options) => calls.push({ kind, options }),
  isExpanded: () => expanded,
  toggleExpanded: () => { expanded = !expanded },
}
const first = gitButton('project-a')
assert.equal(first.props.children[0].type, 'branch-icon')
assert.equal(first.props.style.WebkitAppRegion, 'no-drag')
first.props.onClick()
assert.deepEqual(calls, [{ kind: 'git', options: { revealIfOpened: true } }])
assert.equal(expanded, true)
first.props.onClick()
assert.equal(expanded, true, 'clicking Git twice must not collapse the panel')
assert.equal(calls.length, 2)
console.log('PASS header Git shortcut opens and reveals only the project Git tab, including repeated clicks')

ctx.sidebarRight = {
  openTab: () => { throw new Error('seat switching') },
  openTabIn: (sessionId, kind) => calls.push({ sessionId, kind }),
}
gitButton('project-b').props.onClick()
assert.deepEqual(calls.at(-1), { sessionId: 'project-b', kind: 'git' })
assert.equal(window.__dshDesktopGitOpen.opened, true)
ctx.sidebarRight = undefined
gitButton('project-b').props.onClick()
assert.equal(window.__dshDesktopGitOpen.opened, false)
assert.match(window.__dshDesktopGitOpen.error, /unavailable/)
console.log('PASS project/session switches use the current service and navigation failures are recoverable')

let toggles = 0
ctx.sidebarRight = { toggleExpanded: () => { toggles++ } }
buttons('project-b').find((node) => node.props['data-project-sidebar-toggle'] !== undefined).props.onClick()
assert.equal(toggles, 1)
console.log('PASS generic sidebar toggle is retained alongside the shortcut')
