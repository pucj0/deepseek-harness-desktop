// Offline regression checks in the same Chromium engine as the desktop app.
// Run: node scripts/test-ui-typography.cjs
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

if (!process.argv.includes('--electron')) {
  const { spawnSync } = require('node:child_process')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(require('electron'), [__filename, '--electron'], { env, stdio: 'inherit', windowsHide: true })
  process.exit(result.status ?? 1)
}

const { app, BrowserWindow } = require('electron')
app.commandLine.appendSwitch('disable-gpu')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } })
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><style>
      :root { --dsw-font-test: 400 14px/22px sans-serif; }
      body { font: 14px/22px sans-serif; --dsh-content-font-size:17px; }
      #title {font-size:28px;line-height:36px;width:240px}
      #small {font-size:12px;line-height:18px}
      #token {font:var(--dsw-font-test)}
      #content {font-size:var(--dsh-content-font-size);line-height:calc(22px + 3px)}
    </style><h1 id="title">Title</h1><p id="small">Small</p><p id="token">Token</p>
    <p id="content">Conversation</p><button id="inline" style="font:13px/20px sans-serif">Menu</button>`))
    await win.webContents.executeJavaScript(`
      window.__ModuleLoader__ = {load: ({factory}) => {window.typographyPlugin = factory(() => ({}))}};
      void 0;
    `)
    await win.webContents.executeJavaScript(readFileSync(join(__dirname, '../plugins/dsh-client-ui-typography/lib/client.js'), 'utf8'))
    const results = await win.webContents.executeJavaScript(`(async () => {
      const results = [], disposers = [], listeners = new Set();
      let accepted = 14, fail = false;
      const scope = {
        getSnapshot: () => ({value: {fontSize: accepted}, writable: true}),
        subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) },
        set: async (_field, value) => { if (fail) return false; accepted = value; for (const fn of listeners) fn(); return true },
      };
      let conversationSize = 17;
      const conversationListeners = new Set();
      const conversationScope = {
        getSnapshot: () => ({value: {fontSize: conversationSize, preference: 'dark'}, writable: true}),
        subscribe: fn => { conversationListeners.add(fn); return () => conversationListeners.delete(fn) },
        set: async (field, value) => {
          if (field !== 'fontSize') throw Error('unexpected theme field');
          conversationSize = value;
          document.body.style.setProperty('--dsh-content-font-size', value + 'px');
          for (const fn of conversationListeners) fn();
          return true;
        },
      };
      const ctx = {
        effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
        inject: (services, callback) => { if (services[0] === 'configForms') callback(ctx) },
        configForms: {get: namespace => namespace === 'ui-theme' ? conversationScope : scope},
        locale: {register: () => () => {}, bind: () => key => key},
        slots: {inject: (_name, fn) => fn(), register: row => {
          if (row.id === 'font-size') window.conversationModel = row.inject().model;
          else window.model = row.inject().model;
          return () => {};
        }},
      };
      window.typographyPlugin.apply(ctx);
      const required = window.typographyPlugin.inject;
      if (required.includes('configForms') || required.includes('settingsScope')) throw Error('settings service blocks plugin activation');
      const tick = () => new Promise(resolve => setTimeout(resolve, 0));
      const assert = (condition, message) => { if (!condition) throw Error(message) };
      const font = id => parseFloat(getComputedStyle(document.getElementById(id)).fontSize);
      for (const size of [14, 12, 16, 20, 14]) {
        await window.model.setSize(size); await tick();
        assert(font('title') === Math.round(28*size/14), 'heading '+size);
        assert(font('small') === Math.round(12*size/14), 'small '+size);
        assert(font('token') === size, 'font shorthand token '+size);
        assert(font('inline') === Math.round(13*size/14), 'inline shorthand '+size);
        assert(font('content') === 17, 'conversation font changed');
        assert(getComputedStyle(document.getElementById('title')).width === '240px', 'geometry changed');
        assert(parseFloat(getComputedStyle(document.getElementById('small')).lineHeight) === Math.round(18*size/14), 'line height '+size);
      }
      results.push('12/14/16/20 px preserve size hierarchy, line heights, content size and geometry; reset is exact');
      await window.model.setSize(20);
      const style = document.createElement('style');
      style.textContent = '@media(min-width:1px){.late{font-size:16px!important;line-height:24px}}';
      document.head.appendChild(style);
      const late = document.createElement('div'); late.className='late';late.id='late';late.textContent='Lazy menu';document.body.appendChild(late);
      await tick(); assert(font('late')===23, 'lazy stylesheet');
      style.textContent='.late{font-size:18px}';await tick();assert(font('late')===26, 'hot stylesheet');
      document.getElementById('inline').style.fontSize='15px';await tick();assert(font('inline')===21, 'React inline update');
      document.body.style.setProperty('--dsh-content-font-size','12px');await tick();assert(font('content')===12, 'independent content setting');
      results.push('lazy menus, media rules, stylesheet replacement and inline updates follow the current size');
      fail=true;await window.model.setSize(16);assert(window.model.getSnapshot().error, 'missing save error');assert(font('title')===40, 'failed save did not roll back');
      fail=false;await window.model.setSize(14);assert(!window.model.getSnapshot().error, 'retry error');
      results.push('save failure rolls back and a successful retry clears the error');
      assert(window.conversationModel.getSnapshot().size === 17, 'legacy conversation preference lost');
      for (const [requested, expected] of [[16,16], [20,17], [11,12], [14,14]]) {
        await window.conversationModel.setSize(requested); await tick();
        assert(font('content') === expected && conversationSize === expected, 'conversation setting '+requested);
        assert(font('token') === 14 && accepted === 14, 'conversation changed UI preference');
      }
      assert(conversationScope.getSnapshot().value.preference === 'dark', 'conversation changed theme');
      await window.conversationModel.setSize(12);
      results.push('conversation row retains saved value, clamps to 12..17, resets to 14 and leaves UI/theme independent');
      for(const dispose of disposers.reverse()) dispose();
      assert(font('title')===28 && font('small')===12 && font('inline')===15, 'unload restore');
      assert(font('content')===12, 'unload changed content');
      results.push('unload restores source typography without changing conversation preferences');
      return results;
    })()`)
    for (const result of results) console.log(`PASS ${result}`)
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
