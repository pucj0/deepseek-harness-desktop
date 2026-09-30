/** Two GitHub-backed update tracks: Desktop package and official Harness runtime. */
import { BrowserWindow } from 'electron'
import { escapeHtml, openPanel } from './panel'

export interface UpdateTrackState {
  installed: string
  latest?: string
  state: 'checking' | 'latest' | 'available' | 'unknown'
  reason?: string
  releaseUrl?: string
}

export interface UpdatePanelState {
  desktop: UpdateTrackState
  runtime: UpdateTrackState
  canInstall: boolean
  progress?: number
  /**
   * Runtime 能否**就地直接安装**。
   *
   * 为 true 时 Runtime 轨道显示「安装 Runtime 并重启」，`打开 Runtime Release` 退居备用
   * （直接安装与"去 GitHub 页面"是同一件事的两条路，同时摆出来只会让人犹豫）。
   * 为 false（开发模式、包里没有 npm CLI）时反过来，只留 Release 入口。
   */
  canInstallRuntime: boolean
  /** 是否正在安装 Runtime（按钮变"正在安装…"并禁用）。 */
  runtimeInstalling: boolean
  /** 安装进度文本（npm 的日志行）；undefined 表示没有可显示的进度。 */
  runtimeProgress?: string
}

export interface UpdateWindowStrings {
  title: string
  checking: string
  stateLatest: string
  stateAvailable: string
  stateUnknown: string
  installedLabel: string
  latestLabel: string
  buttonClose: string
  buttonDownload: string
  progress: string
  buttonDownloading: string
  sectionDesktop: string
  sectionRuntime: string
  runtimeBundledNote: string
  runtimeAvailableNote: string
  buttonRuntimeRelease: string
  /** Runtime 直装按钮。 */
  buttonRuntimeInstall: string
  /** 安装中的按钮文案与轨道状态文案（同一份）。 */
  runtimeInstalling: string
  /** 进度文本模板，`{line}` 会被替换成 npm 的日志行。 */
  runtimeProgress: string
}

export function openUpdateWindow(
  parent: BrowserWindow,
  userDataDir: string,
  strings: UpdateWindowStrings,
  onAction: (action: string) => void,
): { window: BrowserWindow; update: (state: UpdatePanelState) => void } {
  // 轨道内的动作按钮：Runtime 的直装按钮必须**贴着它的轨道**，否则用户看到的是底部
  // 一个孤立的按钮，无法判断它属于哪条轨道。
  const track = (id: string, title: string, action = ''): string => `
  <section class="track" id="${id}-track">
    <div class="track-head"><span class="track-title">${escapeHtml(title)}</span><span class="status" id="${id}-status">${escapeHtml(strings.checking)}</span></div>
    <div class="row"><div class="label">${escapeHtml(strings.installedLabel)}</div><div class="value" id="${id}-installed">—</div></div>
    <div class="row"><div class="label">${escapeHtml(strings.latestLabel)}</div><div class="value" id="${id}-latest">—</div></div>
    <div class="note" id="${id}-note" hidden></div>
    ${action === '' ? '' : `
    <div class="actions">
      <button class="primary" data-action="${action}" id="btn-${action}" hidden>${escapeHtml(strings.buttonRuntimeInstall)}</button>
      <div class="progress-text" id="${action}-progress" hidden></div>
    </div>`}
  </section>`
  const body = `
  <div id="progress-wrap" hidden>
    <div class="progress"><div class="progress-bar" id="progress-bar"></div></div>
    <div class="progress-text" id="progress-text"></div>
  </div>
  ${track('desktop', strings.sectionDesktop)}
  ${track('runtime', strings.sectionRuntime, 'runtime-install')}`
  const footer = `<footer>
    <button data-action="runtime-release" id="btn-runtime-release" hidden>${escapeHtml(strings.buttonRuntimeRelease)}</button>
    <button data-action="close" id="btn-close">${escapeHtml(strings.buttonClose)}</button>
    <button class="primary" data-action="download" id="btn-download" hidden>${escapeHtml(strings.buttonDownload)}</button>
  </footer>`
  const script = `
    const text = ${JSON.stringify({
      checking: strings.checking,
      latest: strings.stateLatest,
      available: strings.stateAvailable,
      unknown: strings.stateUnknown,
      buttonDownload: strings.buttonDownload,
      buttonDownloading: strings.buttonDownloading,
      progress: strings.progress,
      runtimeBundledNote: strings.runtimeBundledNote,
      runtimeAvailableNote: strings.runtimeAvailableNote,
      buttonRuntimeInstall: strings.buttonRuntimeInstall,
      runtimeInstalling: strings.runtimeInstalling,
      runtimeProgress: strings.runtimeProgress,
    })};
    function renderTrack(id, payload, installing) {
      document.getElementById(id + '-installed').textContent = payload.installed || '—';
      document.getElementById(id + '-latest').textContent = payload.latest || '—';
      const status = document.getElementById(id + '-status');
      const busy = Boolean(installing);
      status.textContent = busy ? text.runtimeInstalling : (text[payload.state] || payload.state);
      status.className = 'status ' + (busy ? 'available' : payload.state);
      const note = document.getElementById(id + '-note');
      let detail = payload.reason || '';
      if (id === 'runtime' && !detail) detail = payload.state === 'available'
        ? text.runtimeAvailableNote.replace('{version}', payload.latest || '')
        : text.runtimeBundledNote;
      note.hidden = !detail;
      note.textContent = detail;
    }
    window.__panelReady(() => {});
    window.dshPanel.onPush(({ channel, payload }) => {
      if (channel !== 'state') return;
      window.__lastState = payload;
      const runtimeInstalling = Boolean(payload.runtimeInstalling);
      renderTrack('desktop', payload.desktop, false);
      renderTrack('runtime', payload.runtime, runtimeInstalling);
      const button = document.getElementById('btn-download');
      // 两条轨道互斥：Runtime 安装期间不能同时下载 Desktop 安装包（反过来同理）。
      const downloading = payload.progress !== undefined;
      button.hidden = !(payload.desktop.state === 'available' && payload.canInstall && !runtimeInstalling);
      button.disabled = downloading;
      button.textContent = downloading ? text.buttonDownloading.replace('{percent}', String(payload.progress)) : text.buttonDownload;
      const wrap = document.getElementById('progress-wrap');
      wrap.hidden = !downloading;
      if (downloading) {
        document.getElementById('progress-bar').style.width = payload.progress + '%';
        document.getElementById('progress-text').textContent = text.progress.replace('{percent}', String(payload.progress));
      }
      const runtimeButton = document.getElementById('btn-runtime-install');
      const canInstallRuntime = Boolean(payload.canInstallRuntime) && payload.runtime.state === 'available';
      runtimeButton.hidden = !(canInstallRuntime || runtimeInstalling);
      runtimeButton.disabled = runtimeInstalling || downloading;
      runtimeButton.textContent = runtimeInstalling ? text.runtimeInstalling : text.buttonRuntimeInstall;
      const runtimeProgress = document.getElementById('runtime-install-progress');
      const detail = payload.runtimeProgress;
      runtimeProgress.hidden = detail === undefined || detail === '';
      if (!runtimeProgress.hidden) runtimeProgress.textContent = text.runtimeProgress.replace('{line}', detail);
      // Release 只是**备用**入口：能直接安装时不再显示它。
      const releaseButton = document.getElementById('btn-runtime-release');
      releaseButton.hidden = !payload.runtime.releaseUrl || canInstallRuntime || runtimeInstalling;
    });`
  const css = `
  .track { margin-top:4px;padding-bottom:14px; }
  .track + .track { border-top:1px solid #323238;padding-top:16px; }
  .track-head { display:flex;align-items:baseline;gap:10px;margin-bottom:8px; }
  .track-title { font-weight:600;font-size:13px; }
  .status { font-size:12px;padding:2px 8px;border-radius:999px;background:#3a3a40;color:#b9b9c0; }
  .status.latest { background:#24402c;color:#a7e0b8; }
  .status.available { background:#2d4a7c;color:#cfe0ff; }
  .status.unknown { background:#4a3030;color:#e6b0b0; }
  .note { margin-top:8px;color:#8a8a93;font-size:12px; }
  /* 按钮区：只放 Runtime 直装按钮，右对齐；文字再长也只占自己那一行，
     两个动作按钮因此永远不会把 520px 的窗口挤到换行。 */
  .actions { display:flex;flex-direction:column;align-items:flex-end;gap:6px;margin-top:12px; }
  .actions button { max-width:100%;white-space:normal; }
  #progress-wrap { margin:10px 0 16px; }
  .progress { height:6px;border-radius:3px;background:#2a2a30;overflow:hidden; }
  .progress-bar { height:100%;width:0;background:#4d8dff;transition:width .2s ease; }
  .progress-text { margin-top:4px;color:#8a8a93;font-size:12px; }
  #runtime-install-progress { max-width:100%;text-align:right;word-break:break-all; }
  /* 页脚最多同时出现两个按钮（关闭 + 其中一条轨道的动作）：允许收缩并换行，
     中文长按钮因此不会溢出 520px 宽的窗口。 */
  footer { flex-wrap:wrap; }
  footer button { max-width:100%;white-space:normal; }`
  const panel = openPanel(parent, userDataDir, {
    id: 'update', title: strings.title, rows: [], close: strings.buttonClose,
    body, footer, script, css, width: 520, height: 460,
  }, onAction)
  let loaded = false
  let latestState: UpdatePanelState | undefined
  panel.window.webContents.on('did-start-loading', () => { loaded = false })
  panel.window.webContents.on('did-finish-load', () => {
    loaded = true
    if (latestState !== undefined) panel.push('state', latestState)
  })
  return {
    window: panel.window,
    update: (state): void => {
      latestState = state
      if (loaded) panel.push('state', state)
    },
  }
}
