/**
 * dsh-desktop-shell —— client 半（DSH 设置页「桌面端」）。
 *
 * 由 DSH 客户端模块体系加载（`dsh.client`，id 必须等于包名）。
 *
 * 稳健性约定（P0 负向实测）：客户端插件的 apply 一旦抛错或长时间 pending，
 * 整个 DSH 页面会 fail-loud 变成 “Failed to load plugins”。因此：
 *   - apply 全程 try/catch，绝不外抛；
 *   - 只 inject 标准 web 组合里必然存在的服务（slots / locale）；
 *   - 所有网络失败都降级为面板内的一行错误，不影响 DSH 其余部分。
 *
 * 数据全部来自 host 半的 `/dsh-desktop-shell/v1/*`（真相源是桌面壳的
 * shell-settings.json），本模块不自己存状态。
 */
window.__ModuleLoader__.load({
  id: 'dsh-desktop-shell',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const NS = 'desktopShell';
    const API = '/dsh-desktop-shell/v1';

    const zh = {
      title: '桌面端',
      intro: '这里配置 DSH Desktop（桌面壳）本身；设置保存在桌面壳的配置目录，由桌面壳执行。',
      statusTitle: '运行状态',
      desktopVersion: '桌面端版本',
      settingsPath: '设置文件',
      dshVersion: 'DSH 版本',
      dshAddress: 'DSH 地址',
      panelInjected: '面板注入',
      browserAuth: '浏览器认证',
      injected: '已生效',
      notInjected: '未生效',
      authOn: '已启用',
      authOff: '未启用',
      pendingRestart: '有改动需要重启 DSH 后生效',
      noPendingRestart: '已生效',
      behaviorTitle: '行为',
      closeBehavior: '关闭主窗口时',
      minimizeToTray: '最小化到托盘',
      exit: '退出应用',
      proxyTitle: '代理',
      proxyEnabled: '为 DSH 启用代理',
      proxyHint: '只对桌面壳启动的 DSH 生效；修改后需要重启 DSH。',
      httpsProxy: 'HTTPS 代理',
      httpProxy: 'HTTP 代理（可选）',
      noProxy: '例外列表（可选）',
      updatesTitle: '更新检查',
      checkDesktopOnStart: '启动时检查桌面端更新',
      checkDshOnStart: '启动时检查 DSH 更新',
      browserTitle: '侧边栏浏览器',
      browserEnabled: '启用桌面壳自带的侧边栏浏览器（含 agent 网页读取工具）',
      browserAgentTools: '浏览器工具呈现方式',
      browserAgentToolsAuto: '自动（优先原生，注册失败时回退 MCP）',
      browserAgentToolsNative: '原生工具（插件注册，带 DSH 呈现与策略）',
      browserAgentToolsMcp: 'MCP 工具（兼容性最好）',
      browserAgentToolsHint: '改动需要重启 DSH 生效；「运行状态」里会显示本次实际使用的方式与原因。',
      browserAgentDriving: '助手正在操作页面…',
      browserUserDriving: '你已接管浏览器',
      browserReleaseNow: '立即交还',
      browserAutoReleaseIn: '{n} 秒无操作后自动交还',
      browserAutoRelease: '接管后自动交还（秒）',
      browserAutoReleaseHint: '你接管浏览器后，助手会一直等待；停止操作这么久没有动作就把控制权自动交还给它（5–600 秒）。',
      browserToolSurface: '浏览器工具呈现方式',
      browserToolSurfaceNative: '原生工具',
      browserToolSurfaceMcp: 'MCP 工具',
      browserHint: '关闭后不再向 DSH 注入浏览器工具，侧边栏也不再出现「浏览器」；重新打开需要重载 DSH 界面（保存并重启最直接）。',
      browserStatus: '浏览器工具',
      browserOff: '已关闭',
      browserPanel: '浏览器面板',
      browserPanelOn: '已注册',
      browserPanelDisabled: '设置里已关闭',
      browserPanelNoBridge: '桌面壳未提供能力（旧版壳？）',
      browserPanelNoServices: 'DSH 侧缺少 sidebarRight（版本不匹配）',
      browserPanelFailed: '注册失败（见日志）',
      browserPanelPending: '等待注册',
      browserPanelUnknown: '未知',
      serviceTitle: '服务',
      port: '下次启动端口',
      portHint: '端口被占用时不会启动；改完重启生效。',
      save: '保存',
      saveRestart: '保存并重启 DSH',
      checkDesktopUpdate: '检查桌面端更新',
      reload: '重新读取',
      saving: '正在保存…',
      saved: '已保存。',
      savedRestart: '已保存，正在重启 DSH…',
      conflict: '设置已在别处被修改，已为你重新读取，请确认后再保存。',
      actionUnavailable: '当前页面无法调用桌面壳（Tauri 桥不可用），请从桌面端窗口操作。',
      bridgeUnavailable: '（当前不在桌面端窗口内：已保存到磁盘，但桌面壳未收到变更通知。）',
      loadFailed: '读取设置失败',
      runningProxy: '当前生效代理',
      none: '（无）',
      browserTab: '浏览器',
      browserGuide: '由桌面壳托管的浏览器',
      browserHint: '这个浏览器由 DSH Desktop 自己实现并托管，不依赖 DSH 的浏览器功能。',
      browserUnavailable: '桌面壳没有提供浏览器能力（旧版壳或未启用）。',
      browserBack: '后退',
      browserForward: '前进',
      browserReload: '刷新',
      browserOpen: '打开',
      browserPlaceholder: '输入网址，例如 example.com',
      browserEmpty: '在上方输入网址开始浏览。',
      browserPick: '拾取元素',
      browserPickOn: '拾取中：在网页上移动鼠标高亮、点击选中（Esc 退出）',
      browserDevice: '设备',
      deviceDesktop: '桌面',
      deviceIphone: 'iPhone',
      deviceAndroid: '安卓',
      browserHome: '主页',
      browserHistory: '历史记录',
      browserHistoryEmpty: '还没有访问记录',
      browserClearHistory: '清空历史',
      browserRemoveEntry: '从历史里移除',
      browserBookmark: '收藏此页',
      browserUnbookmark: '取消收藏',
      browserBookmarks: '收藏',
      browserBookmarkBar: '显示收藏栏',
      browserMore: '更多',
      browserClearCache: '清空缓存',
      browserClearCookies: '清空 Cookie 与站点数据',
      browserClearCookiesConfirm: '清空后所有网站的登录状态都会丢失，继续？',
      browserPickDisabled: '页面还没加载，先打开一个网址',
      browserFrozenNoFrame: '菜单打开期间页面被暂停（没能截到预览图）；关掉菜单即恢复。',
      browserHomepage: '主页',
      browserHomepageUnset: '未设置',
      browserSetHomepage: '把当前页设为主页',
      browserClearHomepage: '清除主页',
      browserDeviceRow: '设备模拟',
      browserDeviceWidth: '宽',
      browserDeviceHeight: '高',
      browserDeviceRotate: '旋转',
      browserDeviceReset: '跟随窗口',
      browserDownloads: '下载',
      browserDownloadOpen: '打开',
      browserDownloadReveal: '在文件夹中显示',
      browserDownloadClear: '清除已完成',
      downloadProgressing: '下载中',
      downloadCompleted: '已完成',
      downloadCancelled: '已取消',
      downloadInterrupted: '已中断',
      browserBookmarkRename: '双击改名',
      pickedCopied: '已复制到剪贴板',
      pickedNoInput: '没能写进输入框（输入框正忙或接口不可用），已复制到剪贴板，粘贴到对话里即可。',
    };
    const en = {
      title: 'Desktop',
      intro: 'Configure DSH Desktop itself. Settings live in the desktop shell config directory and are applied by the shell.',
      statusTitle: 'Status',
      desktopVersion: 'Desktop version',
      settingsPath: 'Settings file',
      dshVersion: 'DSH version',
      dshAddress: 'DSH address',
      panelInjected: 'Panel injection',
      browserAuth: 'Browser auth',
      injected: 'active',
      notInjected: 'inactive',
      authOn: 'enabled',
      authOff: 'disabled',
      pendingRestart: 'Changes pending a DSH restart',
      noPendingRestart: 'In effect',
      behaviorTitle: 'Behavior',
      closeBehavior: 'Closing the main window',
      minimizeToTray: 'Minimize to tray',
      exit: 'Quit the app',
      proxyTitle: 'Proxy',
      proxyEnabled: 'Use a proxy for DSH',
      proxyHint: 'Applies to the DSH started by this desktop app. Restart DSH to apply.',
      httpsProxy: 'HTTPS proxy',
      httpProxy: 'HTTP proxy (optional)',
      noProxy: 'No-proxy list (optional)',
      updatesTitle: 'Update checks',
      checkDesktopOnStart: 'Check for desktop updates on start',
      checkDshOnStart: 'Check for DSH updates on start',
      browserTitle: 'Sidebar browser',
      browserEnabled: 'Use the desktop shell\'s own sidebar browser (and its agent web tools)',
      browserAgentTools: 'How the browser tools are presented',
      browserAgentToolsAuto: 'Automatic (native first, MCP if registration fails)',
      browserAgentToolsNative: 'Native tools (registered by the plugin; DSH presentation and policies)',
      browserAgentToolsMcp: 'MCP tools (most compatible)',
      browserAgentToolsHint: 'Changing this needs a DSH restart; the run-state section shows the surface actually in use and why.',
      browserAgentDriving: 'The assistant is driving this page…',
      browserUserDriving: 'You have taken over',
      browserReleaseNow: 'Hand back now',
      browserAutoReleaseIn: 'auto hand-back in {n}s of inactivity',
      browserAutoRelease: 'Auto hand-back after (seconds)',
      browserAutoReleaseHint: 'While you hold the browser the assistant waits; after this much inactivity control is handed back to it automatically (5–600s).',
      browserToolSurface: 'Tool surface',
      browserToolSurfaceNative: 'native tools',
      browserToolSurfaceMcp: 'MCP tools',
      browserHint: 'Turning this off stops the browser tools being injected and removes the Browser tab; reload the DSH page (or save & restart) to apply.',
      browserStatus: 'Browser tools',
      browserOff: 'off',
      browserPanel: 'Browser panel',
      browserPanelOn: 'registered',
      browserPanelDisabled: 'off in settings',
      browserPanelNoBridge: 'no capability from the shell (older shell?)',
      browserPanelNoServices: 'DSH has no sidebarRight (version mismatch)',
      browserPanelFailed: 'registration failed (see logs)',
      browserPanelPending: 'waiting to register',
      browserPanelUnknown: 'unknown',
      serviceTitle: 'Service',
      port: 'Port for next start',
      portHint: 'If the port is taken DSH will not start. Restart to apply.',
      save: 'Save',
      saveRestart: 'Save and restart DSH',
      checkDesktopUpdate: 'Check desktop update',
      reload: 'Reload',
      saving: 'Saving…',
      saved: 'Saved.',
      savedRestart: 'Saved. Restarting DSH…',
      conflict: 'Settings changed elsewhere; reloaded for you. Review before saving again.',
      actionUnavailable: 'This page cannot reach the desktop shell (Tauri bridge unavailable).',
      bridgeUnavailable: '(saved to disk, but the desktop shell was not notified because this page is not inside the desktop window.)',
      loadFailed: 'Failed to load settings',
      runningProxy: 'Effective proxy',
      none: '(none)',
      browserTab: 'Browser',
      browserGuide: 'Browser hosted by the desktop shell',
      browserHint: 'This browser is implemented and hosted by DSH Desktop itself, independent of DSH\'s own browser feature.',
      browserUnavailable: 'The desktop shell provides no browser capability (older shell, or not enabled).',
      browserBack: 'Back',
      browserForward: 'Forward',
      browserReload: 'Reload',
      browserOpen: 'Go',
      browserPlaceholder: 'Enter a URL, for example example.com',
      browserEmpty: 'Type a URL above to start browsing.',
      browserPick: 'Pick element',
      browserPickOn: 'Picking: hover to highlight, click to select (Esc exits)',
      browserDevice: 'Device',
      deviceDesktop: 'Desktop',
      deviceIphone: 'iPhone',
      deviceAndroid: 'Android',
      browserHome: 'Home',
      browserHistory: 'History',
      browserHistoryEmpty: 'No history yet',
      browserClearHistory: 'Clear history',
      browserRemoveEntry: 'Remove from history',
      browserBookmark: 'Bookmark this page',
      browserUnbookmark: 'Remove bookmark',
      browserBookmarks: 'Bookmarks',
      browserBookmarkBar: 'Show bookmark bar',
      browserMore: 'More',
      browserClearCache: 'Clear cache',
      browserClearCookies: 'Clear cookies and site data',
      browserClearCookiesConfirm: 'Every site will be signed out. Continue?',
      browserPickDisabled: 'Load a page first',
      browserFrozenNoFrame: 'The page is paused while a menu is open (no preview frame was captured); it comes back when the menu closes.',
      browserHomepage: 'Homepage',
      browserHomepageUnset: 'not set',
      browserSetHomepage: 'Use the current page as homepage',
      browserClearHomepage: 'Clear homepage',
      browserDeviceRow: 'Device emulation',
      browserDeviceWidth: 'W',
      browserDeviceHeight: 'H',
      browserDeviceRotate: 'Rotate',
      browserDeviceReset: 'Follow the window',
      browserDownloads: 'Downloads',
      browserDownloadOpen: 'Open',
      browserDownloadReveal: 'Show in folder',
      browserDownloadClear: 'Clear finished',
      downloadProgressing: 'Downloading',
      downloadCompleted: 'Done',
      downloadCancelled: 'Cancelled',
      downloadInterrupted: 'Interrupted',
      browserBookmarkRename: 'Double-click to rename',
      pickedCopied: 'Copied to clipboard',
      pickedNoInput: 'Could not write into the composer (busy, or the API is unavailable), so it was copied to the clipboard.',
    };

    const CSS_ID = 'dsh-desktop-shell/settings.css';
    const CSS = `
      .dsp{display:flex;flex-direction:column;gap:10px;width:100%;max-width:680px;box-sizing:border-box;color:var(--dsw-alias-label-primary)}
      .dsp h2,.dsp h3,.dsp p{margin:0}
      .dsp-intro,.dsp-muted{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.55}
      .dsp-group{display:flex;flex-direction:column;gap:8px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-3)}
      .dsp-groupTitle{font-size:13px;font-weight:600}
      /* 行布局：文案占剩余宽度，控件固定在右侧一列，避免超宽控件把文案挤到折行 */
      .dsp-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,220px);align-items:center;gap:12px}
      .dsp-rowText{display:flex;flex-direction:column;gap:2px;min-width:0}
      .dsp-rowText strong{font-size:13px;font-weight:500;overflow-wrap:anywhere}
      .dsp-rowText small{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.45}
      .dsp-row > *:last-child{width:100%;min-width:0}
      .dsp-row > input[type=checkbox]{justify-self:end;width:16px;height:16px;min-width:16px}
      .dsp-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,260px);gap:8px 12px;align-items:center}
      .dsp-grid label{font-size:12px;color:var(--dsw-alias-label-secondary)}
      .dsp input[type=text],.dsp input[type=number],.dsp select{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:6px 8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
      .dsp-dl{display:grid;grid-template-columns:126px minmax(0,1fr);gap:4px 10px;margin:0;font-size:12px}
      .dsp-dl dt{color:var(--dsw-alias-label-secondary);line-height:1.5}
      .dsp-dl dd{margin:0;color:var(--dsw-alias-label-primary);line-height:1.5;overflow-wrap:anywhere}
      /* 操作栏：内容再长也常驻可见 */
      .dsp-actions{position:sticky;bottom:0;z-index:1;display:flex;flex-wrap:wrap;gap:8px;padding:10px 12px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 4px 16px rgba(0,0,0,.08)}
      .dsp button{font:inherit;font-size:12px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:5px 10px;color:var(--dsw-alias-label-primary);background:transparent}
      .dsp button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
      .dsp button:disabled{cursor:default;opacity:.5}
      .dsp-primary{color:#fff!important;background:var(--dsw-alias-brand-primary)!important;border-color:var(--dsw-alias-brand-primary)!important}
      .dsp-badge{display:inline-block;align-self:flex-start;border-radius:999px;padding:2px 8px;font-size:11px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);white-space:nowrap}
      .dsp-badge[data-tone=warn]{color:var(--dsw-alias-state-warn-primary)}
      .dsp-badge[data-tone=ok]{color:var(--dsw-alias-state-success-primary)}
      .dsp-checks{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px 12px}
      .dsp-check{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:500;cursor:pointer;min-width:0}
      .dsp-check input[type=checkbox]{flex:none;width:16px;height:16px}
      .dsp-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.5}
      .dsp-ok{color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:1.5}
      /* 侧边栏浏览器：正文只画工具栏，网页本身是主进程里的原生视图，盖在 .dsb-stage 上 */
      .dsb{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;background:var(--dsw-alias-bg-base)}
      .dsb-bar{position:relative;display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none}
      .dsb-bar button{flex:none;width:26px;height:26px;display:flex;align-items:center;justify-content:center;font:inherit;font-size:14px;line-height:1;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-primary);background:transparent}
      .dsb-bar button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
      .dsb-bar button:disabled{cursor:default;opacity:.4}
      .dsb-bar form{display:flex;flex:1;min-width:0;gap:6px}
      .dsb-bar input{flex:1;min-width:0;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:5px 8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
      .dsb-bar form button{width:auto;padding:0 10px;font-size:12px}
      .dsb-agentBar{flex:none;display:flex;align-items:center;gap:8px;padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);font-size:11px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}
      .dsb-agentBar[data-tone=agent]{color:var(--dsw-alias-brand-primary)}
      .dsb-agentBar[data-tone=user]{color:var(--dsw-alias-state-warning-primary)}
      .dsb-agentHint{font-size:10px;opacity:.75}
      .dsb-agentDot{width:7px;height:7px;border-radius:50%;background:currentColor;animation:dsbPulse 1.4s infinite}
      @keyframes dsbPulse{70%{opacity:.25}100%{opacity:1}}
      .dsb-stage{position:relative;flex:1;min-height:120px;margin:0;display:flex;align-items:center;justify-content:center;padding:12px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6}
      .dsb-notice{flex:none;padding:4px 8px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.5;overflow-wrap:anywhere}
      .dsb-bar select{flex:none;max-width:88px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:4px 6px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
      .dsb-bar button[data-on=true]{color:#fff;background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
      .dsb-bar button:disabled{opacity:.4;cursor:not-allowed}
      .dsb-hint{flex:none;padding:4px 8px;color:var(--dsw-alias-state-warn-primary);font-size:11px;line-height:1.5}
      .dsb-wrap{position:relative;display:flex;min-width:0;flex:1}
      .dsb-menuWrap{position:relative;display:inline-flex;flex:none}
      .dsb-wrap>form{flex:1;min-width:0}
      .dsb-menu{position:absolute;top:100%;left:0;right:0;z-index:30;margin-top:4px;max-height:280px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);box-shadow:0 10px 28px rgba(0,0,0,.22)}
      .dsb-menuRight{left:auto;right:4px;width:200px}
      .dsb-menuTitle{padding:6px 8px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
      .dsb-row{display:flex;align-items:center;gap:6px;padding:5px 8px;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-primary)}
      .dsb-row:hover,.dsb-row[data-active=true]{background:var(--dsw-alias-interactive-bg-hover)}
      .dsb-rowText{display:flex;min-width:0;flex:1;flex-direction:column}
      .dsb-rowTitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsb-rowSub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-tertiary)}
      .dsb-rowOp{flex:none;border:0;border-radius:4px;padding:1px 4px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;cursor:pointer}
      .dsb-rowOp:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-error-primary)}
      .dsb-menuFoot{border-top:1px solid var(--dsw-alias-border-l2);padding:5px 8px;font-size:11px;color:var(--dsw-alias-label-secondary);cursor:pointer}
      .dsb-menuFoot:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .dsb-bookmarks{flex:none;display:flex;align-items:center;gap:4px;overflow-x:auto;padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3)}
      .dsb-bm{flex:none;display:inline-flex;max-width:160px;align-items:center;gap:4px;border:0;border-radius:6px;padding:2px 6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer}
      .dsb-bm:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .dsb-bm span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsb-bmWrap{position:relative;display:inline-flex;flex:none;align-items:center}
      .dsb-bmRemove{display:none;border:0;border-radius:4px;padding:0 4px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;cursor:pointer}
      .dsb-bmWrap:hover .dsb-bmRemove{display:inline-block}
      .dsb-bmRemove:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-error-primary)}
      .dsb-bmInput{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:2px 6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;width:120px}
      .dsb-deviceRow{flex:none;display:flex;align-items:center;gap:6px;padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3)}
      .dsb-deviceRow select{max-width:88px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:3px 5px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
      .dsb-deviceRow input{width:56px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:3px 5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
      .dsb-deviceRow button{font:inherit;font-size:12px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:3px 7px;color:var(--dsw-alias-label-primary);background:transparent}
      .dsb-deviceRow button[data-on=true]{color:#fff;background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
      .dsb-deviceField{display:inline-flex;align-items:center;gap:3px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
      .dsb-downloads{flex:none;display:flex;flex-direction:column;gap:2px;padding:6px 8px;border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3)}
      .dsb-downloadsHead{display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--dsw-alias-label-tertiary)}
      .dsb-download{display:flex;align-items:center;gap:6px;font-size:12px}
      .dsb-downloadText{display:flex;min-width:0;flex:1;flex-direction:column}
      .dsb-progress{margin-top:2px;height:3px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
      .dsb-progressBar{height:100%;background:var(--dsw-alias-brand-primary);transition:width .2s linear}
      .dsb-frozen{display:block;width:100%;height:100%;object-fit:fill}
      .dsb-frozenHint{display:flex;height:100%;align-items:center;justify-content:center;padding:12px;text-align:center;font-size:11px;color:var(--dsw-alias-label-tertiary)}
      .dsb-row[data-disabled=true]{opacity:.45;cursor:not-allowed}
      .dsb-rowStatic{cursor:default;font-size:11px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
`;
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) === null) {
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-desktop-shell';
      tag.dataset.pluginCss = CSS_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /** Tauri 事件桥（DSH 页面是远程 origin，能力由 dsh-page.json 授予 core:event:default）。 */
    function tauriEvents() {
      const tauri = globalThis.__TAURI__;
      return tauri && tauri.event ? tauri.event : undefined;
    }

    function emitAction(action) {
      const events = tauriEvents();
      if (events === undefined || typeof events.emit !== 'function') return false;
      try {
        void events.emit('dsh-desktop-shell', { action });
        return true;
      } catch {
        return false;
      }
    }

    let cachedToken;

    async function bootstrapToken() {
      if (cachedToken !== undefined) return cachedToken;
      const response = await fetch(`${API}/bootstrap`, { credentials: 'same-origin', cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok !== true) {
        throw new Error(payload.error ?? `HTTP ${response.status}`);
      }
      cachedToken = payload.token;
      return cachedToken;
    }

    async function loadState() {
      const response = await fetch(`${API}/state`, { credentials: 'same-origin', cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok !== true) {
        throw new Error(payload.error ?? `HTTP ${response.status}`);
      }
      return payload;
    }

    async function saveSettings(revision, patch) {
      const token = await bootstrapToken();
      const response = await fetch(`${API}/settings`, {
        method: 'PUT',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          'content-type': 'application/json',
          'x-dsh-desktop-shell-token': token,
        },
        body: JSON.stringify({ revision, patch }),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 403 && payload.error === 'invalid-token') cachedToken = undefined;
      return { status: response.status, payload };
    }

    function draftOf(settings) {
      return {
        closeBehavior: settings.closeBehavior,
        proxy: {
          enabled: settings.proxy.enabled === true,
          httpsProxy: settings.proxy.httpsProxy ?? '',
          httpProxy: settings.proxy.httpProxy ?? '',
          noProxy: settings.proxy.noProxy ?? '',
        },
        service: { port: settings.service?.port ?? 41729 },
        updates: {
          checkDesktopOnStart: settings.updates?.checkDesktopOnStart !== false,
          checkDshOnStart: settings.updates?.checkDshOnStart !== false,
        },
        browser: {
          enabled: settings.browser?.enabled !== false,
          agentTools: ['auto', 'native', 'mcp'].includes(settings.browser?.agentTools) ? settings.browser.agentTools : 'auto',
          autoReleaseSeconds: Number.isFinite(settings.browser?.autoReleaseSeconds) ? settings.browser.autoReleaseSeconds : 30,
        },
      };
    }

    function Row(props) {
      return h(
        'div',
        { className: 'dsp-row' },
        h('div', { className: 'dsp-rowText' }, h('strong', null, props.label), props.hint ? h('small', null, props.hint) : null),
        props.children,
      );
    }

    function DesktopSection(props) {
      const [snapshot, setSnapshot] = React.useState({ phase: 'loading' });
      const [draft, setDraft] = React.useState(null);
      const [notice, setNotice] = React.useState('');
      const [failure, setFailure] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const t = (key) => (props && typeof props.t === 'function' ? props.t(key) : (zh[key] ?? key));

      const applySnapshot = React.useCallback((payload) => {
        setSnapshot({ phase: 'ready', data: payload });
        setDraft(draftOf(payload.settings));
      }, []);

      const reload = React.useCallback(async () => {
        try {
          setFailure('');
          const payload = await loadState();
          applySnapshot(payload);
        } catch (error) {
          setSnapshot({ phase: 'error' });
          setFailure(`${t('loadFailed')}：${error instanceof Error ? error.message : String(error)}`);
        }
      }, []);

      React.useEffect(() => {
        void reload();
      }, [reload]);

      React.useEffect(() => {
        const events = tauriEvents();
        if (events === undefined || typeof events.listen !== 'function') return undefined;
        let dispose;
        let cancelled = false;
        Promise.resolve(events.listen('dsh-desktop-state', () => { void reload(); }))
          .then((unlisten) => {
            if (cancelled) {
              try {
                unlisten?.();
              } catch {
                // 忽略：卸载阶段失败无需处理。
              }
              return;
            }
            dispose = unlisten;
          })
          .catch(() => {});
        return () => {
          cancelled = true;
          try {
            dispose?.();
          } catch {
            // 忽略。
          }
        };
      }, [reload]);

      const save = async (restart) => {
        if (draft === null || snapshot.phase !== 'ready') return;
        setBusy(true);
        setFailure('');
        setNotice('');
        try {
          const result = await saveSettings(snapshot.data.revision, {
            closeBehavior: draft.closeBehavior,
            proxy: draft.proxy,
            service: draft.service,
            updates: draft.updates,
            browser: draft.browser,
          });
          if (result.status === 200 && result.payload.ok === true) {
            setSnapshot({
              phase: 'ready',
              data: { ...snapshot.data, settings: result.payload.settings, revision: result.payload.revision, pendingRestart: result.payload.pendingRestart },
            });
            setDraft(draftOf(result.payload.settings));
            // 保存成功后再通知桌面壳（关闭行为即时生效 / 代理需重启）。
            // 桥不可用（例如在普通浏览器里打开了该页面）不算保存失败。
            const emitted = emitAction(restart ? 'restart-dsh' : 'settings-changed');
            setNotice(restart ? t('savedRestart') : t('saved'));
            if (!emitted) setNotice(`${t(restart ? 'savedRestart' : 'saved')} ${t('bridgeUnavailable')}`);
          } else if (result.status === 409) {
            setNotice(t('conflict'));
            const payload = await loadState();
            applySnapshot(payload);
          } else {
            setFailure(result.payload.error ?? `HTTP ${result.status}`);
          }
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error));
        } finally {
          setBusy(false);
        }
      };

      if (snapshot.phase === 'loading') {
        return h('div', { className: 'dsp' }, h('h2', null, t('title')), h('p', { className: 'dsp-muted' }, '…'));
      }
      if (snapshot.phase === 'error') {
        return h(
          'div',
          { className: 'dsp' },
          h('h2', null, t('title')),
          h('p', { className: 'dsp-error' }, failure),
          h('div', { className: 'dsp-actions' }, h('button', { type: 'button', onClick: () => void reload() }, t('reload'))),
        );
      }

      const { facts, pendingRestart, runningProxy: effectiveProxy } = snapshot.data;
      const patchDraft = (patch) => setDraft((current) => ({ ...current, ...patch }));
      const patchProxy = (patch) => setDraft((current) => ({ ...current, proxy: { ...current.proxy, ...patch } }));
      const patchUpdates = (patch) => setDraft((current) => ({ ...current, updates: { ...current.updates, ...patch } }));
      const patchBrowser = (patch) => setDraft((current) => ({ ...current, browser: { ...current.browser, ...patch } }));

      return h(
        'div',
        { className: 'dsp' },
        h('h2', null, t('title')),
        h('p', { className: 'dsp-intro' }, t('intro')),

        h(
          'section',
          { className: 'dsp-group' },
          h('p', { className: 'dsp-groupTitle' }, t('statusTitle')),
          h(
            'dl',
            { className: 'dsp-dl' },
            h('dt', null, t('desktopVersion')),
            h('dd', null, facts?.desktopVersion ?? '—'),
            h('dt', null, t('dshVersion')),
            h('dd', null, facts?.dshVersion ?? '—'),
            h('dt', null, t('dshAddress')),
            h('dd', null, facts?.dshUrl ?? '—'),
            h('dt', null, t('panelInjected')),
            h('dd', null, h('span', { className: 'dsp-badge', 'data-tone': facts?.panelInjected ? 'ok' : 'warn' }, facts?.panelInjected ? t('injected') : t('notInjected'))),
            h('dt', null, t('browserAuth')),
            h('dd', null, h('span', { className: 'dsp-badge', 'data-tone': facts?.dshBrowserAuth ? 'ok' : 'warn' }, facts?.dshBrowserAuth ? t('authOn') : t('authOff'))),
            h('dt', null, t('settingsPath')),
            h('dd', null, facts?.settingsPath ?? '—'),
            h('dt', null, t('runningProxy')),
            h('dd', null, effectiveProxy && effectiveProxy.enabled ? `${effectiveProxy.httpsProxy || effectiveProxy.httpProxy}` : t('none')),
            h('dt', null, t('browserStatus')),
            h(
              'dd',
              null,
              facts?.browser === undefined
                ? '—'
                : h(
                    'span',
                    { className: 'dsp-badge', 'data-tone': facts.browser.enabled && facts.browser.bridge ? 'ok' : 'warn' },
                    facts.browser.enabled
                      ? `${facts.browser.tools} 个工具${facts.browser.bridge ? '' : '（工具桥未启动）'}`
                      : t('browserOff'),
                  ),
            ),
            // 工具面：本次实际用的是原生工具还是 MCP，以及为什么（自动回退的原因直接暴露给用户）。
            h('dt', null, t('browserToolSurface')),
            h(
              'dd',
              null,
              facts?.browser === undefined
                ? '—'
                : h(
                    'span',
                    {
                      className: 'dsp-badge',
                      'data-tone': facts.browser.toolSurface === 'native' ? 'ok' : 'warn',
                    },
                    `${facts.browser.toolSurface === 'native'
                      ? t('browserToolSurfaceNative')
                      : t('browserToolSurfaceMcp')}${facts.browser.toolSurfaceReason === undefined || facts.browser.toolSurfaceReason === '' ? '' : ` · ${facts.browser.toolSurfaceReason}`}`,
                  ),
            ),
            h('dt', null, t('browserPanel')),
            h('dd', null, browserPanelSelfCheck(t, snapshot.data.settings) ?? t('browserPanelUnknown')),
          ),
          pendingRestart
            ? h('span', { className: 'dsp-badge', 'data-tone': 'warn' }, t('pendingRestart'))
            : h('span', { className: 'dsp-badge', 'data-tone': 'ok' }, t('noPendingRestart')),
        ),

        draft === null
          ? null
          : h(
              React.Fragment,
              null,
              h(
                'section',
                { className: 'dsp-group' },
                h('p', { className: 'dsp-groupTitle' }, t('behaviorTitle')),
                h(
                  Row,
                  { label: t('closeBehavior') },
                  h(
                    'select',
                    {
                      value: draft.closeBehavior,
                      onChange: (event) => patchDraft({ closeBehavior: event.target.value }),
                    },
                    h('option', { value: 'minimizeToTray' }, t('minimizeToTray')),
                    h('option', { value: 'exit' }, t('exit')),
                  ),
                ),
              ),

              h(
                'section',
                { className: 'dsp-group' },
                h('p', { className: 'dsp-groupTitle' }, t('proxyTitle')),
                h(
                  Row,
                  { label: t('proxyEnabled'), hint: t('proxyHint') },
                  h('input', {
                    type: 'checkbox',
                    checked: draft.proxy.enabled,
                    onChange: (event) => patchProxy({ enabled: event.target.checked }),
                  }),
                ),
                h(
                  'div',
                  { className: 'dsp-grid' },
                  h('label', null, t('httpsProxy')),
                  h('input', {
                    type: 'text',
                    value: draft.proxy.httpsProxy,
                    spellCheck: false,
                    placeholder: 'http://127.0.0.1:7890',
                    onChange: (event) => patchProxy({ httpsProxy: event.target.value }),
                  }),
                  h('label', null, t('httpProxy')),
                  h('input', {
                    type: 'text',
                    value: draft.proxy.httpProxy,
                    spellCheck: false,
                    onChange: (event) => patchProxy({ httpProxy: event.target.value }),
                  }),
                  h('label', null, t('noProxy')),
                  h('input', {
                    type: 'text',
                    value: draft.proxy.noProxy,
                    spellCheck: false,
                    placeholder: '10.1.20.160, *.internal',
                    onChange: (event) => patchProxy({ noProxy: event.target.value }),
                  }),
                ),
              ),

              h(
                'section',
                { className: 'dsp-group' },
                h('p', { className: 'dsp-groupTitle' }, t('updatesTitle')),
                h(
                  'div',
                  { className: 'dsp-checks' },
                  h(
                    'label',
                    { className: 'dsp-check' },
                    h('input', {
                      type: 'checkbox',
                      checked: draft.updates.checkDesktopOnStart,
                      onChange: (event) => patchUpdates({ checkDesktopOnStart: event.target.checked }),
                    }),
                    h('span', null, t('checkDesktopOnStart')),
                  ),
                  h(
                    'label',
                    { className: 'dsp-check' },
                    h('input', {
                      type: 'checkbox',
                      checked: draft.updates.checkDshOnStart,
                      onChange: (event) => patchUpdates({ checkDshOnStart: event.target.checked }),
                    }),
                    h('span', null, t('checkDshOnStart')),
                  ),
                ),
              ),

              h(
                'section',
                { className: 'dsp-group' },
                h('p', { className: 'dsp-groupTitle' }, t('browserTitle')),
                h(
                  'div',
                  { className: 'dsp-checks' },
                  h(
                    'label',
                    { className: 'dsp-check' },
                    h('input', {
                      type: 'checkbox',
                      checked: draft.browser.enabled,
                      onChange: (event) => patchBrowser({ enabled: event.target.checked }),
                    }),
                    h('span', null, t('browserEnabled')),
                  ),
                ),
                h('p', { className: 'dsp-muted' }, t('browserHint')),
                // 工具面：原生 / MCP / 自动。改了要重启 DSH（overlay 在启动时写）。
                h(
                  'label',
                  { className: 'dsp-field' },
                  h('span', null, t('browserAgentTools')),
                  h(
                    'select',
                    {
                      value: typeof draft.browser.agentTools === 'string' ? draft.browser.agentTools : 'auto',
                      disabled: !draft.browser.enabled,
                      onChange: (event) => patchBrowser({ agentTools: event.target.value }),
                    },
                    h('option', { value: 'auto' }, t('browserAgentToolsAuto')),
                    h('option', { value: 'native' }, t('browserAgentToolsNative')),
                    h('option', { value: 'mcp' }, t('browserAgentToolsMcp')),
                  ),
                ),
                h('p', { className: 'dsp-muted' }, t('browserAgentToolsHint')),
                // 用户接管后多久没操作就自动把浏览器还给助手（对应主进程的等待窗口）。
                h(
                  'label',
                  { className: 'dsp-field' },
                  h('span', null, t('browserAutoRelease')),
                  h('input', {
                    type: 'number',
                    min: 5,
                    max: 600,
                    disabled: !draft.browser.enabled,
                    value: Number.isFinite(draft.browser.autoReleaseSeconds) ? draft.browser.autoReleaseSeconds : 30,
                    onChange: (event) => patchBrowser({ autoReleaseSeconds: Number(event.target.value) }),
                  }),
                ),
                h('p', { className: 'dsp-muted' }, t('browserAutoReleaseHint')),
              ),

              h(
                'section',
                { className: 'dsp-group' },
                h('p', { className: 'dsp-groupTitle' }, t('serviceTitle')),
                h(
                  Row,
                  { label: t('port'), hint: t('portHint') },
                  h('input', {
                    type: 'number',
                    min: 1024,
                    max: 65535,
                    value: draft.service.port,
                    onChange: (event) => patchDraft({ service: { port: Number(event.target.value) } }),
                  }),
                ),
              ),
            ),

        failure ? h('p', { className: 'dsp-error' }, failure) : null,
        notice ? h('p', { className: 'dsp-ok' }, notice) : null,

        h(
          'div',
          { className: 'dsp-actions' },
          h('button', { type: 'button', className: 'dsp-primary', disabled: busy, onClick: () => void save(false) }, busy ? t('saving') : t('save')),
          h('button', { type: 'button', disabled: busy, onClick: () => void save(true) }, t('saveRestart')),
          h(
            'button',
            {
              type: 'button',
              disabled: busy,
              onClick: () => {
                if (!emitAction('check-desktop-update')) setFailure(t('actionUnavailable'));
              },
            },
            t('checkDesktopUpdate'),
          ),
          h('button', { type: 'button', disabled: busy, onClick: () => void reload() }, t('reload')),
        ),
      );
    }

    // ── 侧边栏浏览器（M1）──────────────────────────────────────────────────────
    //
    // 与 DSH 自带的浏览器 tab 无关：这里注册的 tab 由桌面壳自己实现——正文只测量 stage
    // 的矩形并驱动主进程里的原生 WebContentsView（导航、会话、策略、以及后续的 agent
    // 工具都在壳里）。因此 DSH 升级也不会把这个功能带走。
    //
    // 能力探测：只有桌面壳的 preload 暴露了 __DSH_DESKTOP_BROWSER__ 时才注册；Tauri 旧壳
    // 没有这个对象，注册整段跳过，只保留设置页（旧壳行为不变）。

    /** 手动「新开浏览器标签」的命令 id（快捷键 + 引导页卡片共用）。 */
    const BROWSER_NEW_COMMAND = 'dsh-desktop.browser.new';
    const BROWSER_TAB_ID = 'dsh-desktop-shell/browser';
    const BROWSER_TAB_KIND = 'desktop-browser';
    const EMPTY_BROWSER_STATE = {
      url: '',
      title: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      error: null,
    };

    /** 桌面壳的原生浏览器桥；不存在时返回 undefined（旧壳 / 未启用）。 */
    function browserBridge() {
      const bridge = globalThis.__DSH_DESKTOP_BROWSER__;
      if (bridge === undefined || bridge === null) return undefined;
      if (typeof bridge.command !== 'function' || typeof bridge.subscribe !== 'function') return undefined;
      return bridge;
    }

    /**
     * 面板自检结果（注册成功 / 跳过原因），显示在设置页的「运行状态」里。
     * 桌面壳侧的工具数由 desktop-facts.json 提供，这里只报「面板 tab 有没有注册上」——
     * 这是最容易静默失败、也最难靠肉眼判断的一步。
     */
    let browserPanelCheck = null;

    function browserBadge(t, text, tone) {
      return h('span', { className: 'dsp-badge', 'data-tone': tone }, text);
    }

    function browserPanelSelfCheck(t, settings) {
      if (browserBridge() === undefined) return browserBadge(t, t('browserPanelNoBridge'), 'warn');
      if (settings !== null && typeof settings === 'object' && settings.browser !== null && typeof settings.browser === 'object' && settings.browser.enabled === false) {
        return browserBadge(t, t('browserPanelDisabled'), 'warn');
      }
      switch (browserPanelCheck) {
        case 'registered': return browserBadge(t, t('browserPanelOn'), 'ok');
        case 'no-services': return browserBadge(t, t('browserPanelNoServices'), 'warn');
        case 'failed': return browserBadge(t, t('browserPanelFailed'), 'warn');
        default: return browserBadge(t, t('browserPanelPending'), 'warn');
      }
    }

    /**
     * tab 标题的轻量 store：正文写入页面标题，tab chip 的标题组件订阅同一份。
     * 每个 occurrence 用 tabId 作 key（同一个 key 也被正文用来路由命令）。
     */
    const browserTitles = new Map();
    const browserTitleListeners = new Set();

    function publishBrowserTitle(tabId, title) {
      if (typeof title !== 'string' || browserTitles.get(tabId) === title) return;
      browserTitles.set(tabId, title);
      for (const listener of browserTitleListeners) listener();
    }

    /** @returns 当前 occurrence 的页面标题（没有则 undefined）。 */
    function useBrowserTitle(tabId) {
      const [, force] = React.useReducer((value) => value + 1, 0);
      React.useEffect(() => {
        browserTitleListeners.add(force);
        return () => {
          browserTitleListeners.delete(force);
        };
      }, []);
      return browserTitles.get(tabId);
    }

    /** 从框架注入的 `useTabInfo` 里取出本 occurrence 的 id 与可见性（缺失时降级）。 */
    function readTabInfo(props) {
      const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : undefined;
      const tab = info !== null && typeof info === 'object' ? info.tab : undefined;
      const record = tab !== null && typeof tab === 'object' ? tab : undefined;
      const id = record !== undefined && typeof record.id === 'string' && record.id !== '' ? record.id : 'default';
      const visible = !(record !== undefined && record.visible === false);
      // `sidebar` 是宿主公布的呈现状态（`expanded` / `fullscreen`），`panel` 是所在 pane。
      // 诊断和「展开与否」都该看它，而不是猜 DOM。
      const sidebar = info !== null && typeof info === 'object' ? info.sidebar : undefined;
      const panel = info !== null && typeof info === 'object' ? info.panel : undefined;
      return { id, visible, sidebar, panel };
    }

    /**
     * 一个拾取元素写进对话的正文，格式对齐 one-code 的 `makeElementTag`：
     * 带分隔符的块，选择器 + 来源 URL + outerHTML 放在一起，模型一眼能看出这是页面元素。
     */
    function elementBlock(element) {
      const html = typeof element.outerHTML === 'string' ? element.outerHTML : '';
      return `--- 页面元素 (${element.selector}) ---\n来源: ${element.url}\n${html}\n--- end ---`;
    }

    /** 保留最近拾取的元素数量上限（超出丢最早的）。 */
    const PICKED_KEEP = 20;

    /**
     * 接管倒计时文案。剩余秒数由主进程给的**绝对时间戳**算出，避免面板侧时钟漂移。
     * @returns 例如「· 12 秒无操作后自动交还」
     */
    function autoReleaseHint(t, autoReleaseAt, now) {
      const remaining = Math.max(0, Math.ceil((autoReleaseAt - now) / 1000));
      return `· ${t('browserAutoReleaseIn').replace('{n}', String(remaining))}`;
    }

    /** 冻结图的「没截到图」哨兵值：舞台据此显示说明文字而不是留白。 */
    const FROZEN_NO_FRAME = 'no-frame';

    /** 字节数的人读形式（与主进程 browser-downloads.ts 的 formatBytes 同规则）。 */
    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let value = bytes;
      let unit = 0;
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
      }
      return `${value >= 10 || unit === 0 ? String(Math.round(value)) : value.toFixed(1)} ${units[unit]}`;
    }

    /**
     * 页面元素引用：chip 的 source 名。
     *
     * DSH 的编辑器原生支持「引用 chip」——提交时按 chip 的 `source` 找到注册的 source，
     * 调它的 `codec.serialize(ref)` 展开成模型看到的文本（`ui-conversation` 的
     * `sinkSerialized`）。所以只要我们自己注册一个 source，拾取结果就能变成和 one-code
     * 一样的内联 chip，而不是一大段平文本。
     */
    const ELEMENT_REFERENCE_SOURCE = 'desktop-element';

    /** 浏览器偏好的空值（首次读取前用它渲染）。 */
    const EMPTY_BROWSER_PREFS = { homepage: '', bookmarks: [], bookmarkBarVisible: false };

    /**
     * 引用通道所需的服务（`apply` 里注入，未就绪就保持 null → 退化为纯文本插入）。
     * 拿它做两件事：`sessions.scope(sessionId)` 取会话作用域 ctx（事件按作用域派发，
     * 在会话作用域上 bail 才能被 ui-conversation 的监听器收到），以及注册 source。
     */
    let referenceServices = null;

    /** 本次运行里拾取过的元素（ref → 元素），供 `@` 菜单候选使用。 */
    const recentPicks = new Map();

    /** 元素 → chip 的 ref：**自包含**，这样 DSH 重载后草稿里残留的 chip 仍能序列化。 */
    function encodeElementRef(element) {
      return JSON.stringify({
        v: 1,
        url: typeof element.url === 'string' ? element.url : '',
        selector: typeof element.selector === 'string' ? element.selector : '',
        html: typeof element.outerHTML === 'string' ? element.outerHTML : '',
        preview: typeof element.preview === 'string' ? element.preview : '',
      });
    }

    /** ref → 元素；任何解析失败都返回 undefined（调用方必须容忍坏 ref，绝不能因此拒绝发送）。 */
    function decodeElementRef(ref) {
      if (typeof ref !== 'string' || ref === '') return undefined;
      try {
        const parsed = JSON.parse(ref);
        if (parsed === null || typeof parsed !== 'object') return undefined;
        if (typeof parsed.selector !== 'string' || parsed.selector === '') return undefined;
        return {
          url: typeof parsed.url === 'string' ? parsed.url : '',
          selector: parsed.selector,
          outerHTML: typeof parsed.html === 'string' ? parsed.html : '',
          preview: typeof parsed.preview === 'string' && parsed.preview !== '' ? parsed.preview : parsed.selector,
        };
      } catch {
        return undefined;
      }
    }

    /** 元素 → chip 的插入对象（`ReferenceChipNode` 的字段：source/ref/label/appearance/clipboardText）。 */
    function elementInsertion(element) {
      return {
        source: ELEMENT_REFERENCE_SOURCE,
        ref: encodeElementRef(element),
        label: element.preview === '' ? element.selector : element.preview,
        // appearance 留空：chip 用中性的 @ 标记，不依赖 DSH 的图标注册表。
        clipboardText: element.selector,
      };
    }

    /** 拾取即写入时，优先走引用 chip；这条路径需要会话作用域 ctx 与输入框 actions。 */
    function insertElementChip(scope, element, inputActions) {
      try {
        if (typeof scope.bail !== 'function') return false;
        if (inputActions === null || inputActions === undefined) return false;
        if (typeof inputActions.captureInsertion !== 'function') return false;
        // 与会话作用域上的监听器同一个 span 形状（{start,end,draftRev}），CAS 才有意义。
        const span = inputActions.captureInsertion();
        if (span === null || span === undefined) return false;
        return scope.bail('slash/input-insert-reference', {
          reference: elementInsertion(element),
          span,
        });
      } catch (error) {
        console.warn('[dsh-desktop-shell][client] 引用 chip 插入失败', error);
        return false;
      }
    }

    /**
     * 尝试用引用 chip 落点。
     * @returns `'inserted'` 成功；`'unavailable'` 表示该退化为纯文本/剪贴板。
     * cordis 的 `bail` 在不同版本里可能是同步布尔，也可能是 promise，两种都认。
     */
    async function resolveChipInsert(sessionId, element, inputActions) {
      const services = referenceServices;
      if (services === null) return 'unavailable';
      if (typeof sessionId !== 'string' || sessionId === '') return 'unavailable';
      let scope;
      try {
        scope = services.sessions.scope(sessionId);
      } catch (error) {
        console.warn('[dsh-desktop-shell][client] 取会话作用域失败', error);
        return 'unavailable';
      }
      if (scope === null || scope === undefined) return 'unavailable';
      const outcome = insertElementChip(scope, element, inputActions);
      if (outcome === true) return 'inserted';
      if (outcome !== null && typeof outcome === 'object' && typeof outcome.then === 'function') {
        try {
          return (await outcome) === true ? 'inserted' : 'unavailable';
        } catch (error) {
          console.warn('[dsh-desktop-shell][client] 引用 chip 插入被拒绝', error);
          return 'unavailable';
        }
      }
      return 'unavailable';
    }

    /**
     * 注册页面元素引用 source。
     *
     * 两个作用：
     * ① 提交时把 chip 展开成模型看到的页面元素块（`codec.serialize`）；
     * ② 用户也可以在输入框打 `@` 直接从「页面元素」里挑一个（走 DSH 自己的插入路径，
     *    是最不依赖内部事件的一条路）。
     * source 的 `candidates` 不参与 `@` 的其它分组，候选来自本会话拾取过的元素。
     *
     * **`candidates` 必须是 async（或返回 Promise）**：DSH 的 `ui-input-trigger` 控制器写的是
     * `source.candidates(...).then(...)`，同步返回数组会抛 TypeError，而这个异常发生在
     * `for (const source of roster)` 的循环体里 —— 于是**同一轮里排在后面的 source 也不会被
     * 拉取**，DSH 自己的文件/会话候选同样停摆，`@` 菜单只剩骨架屏（真实用户报障）。
     */
    function registerElementReference(scope) {
      const inputTriggers = scope.inputTriggers;
      if (inputTriggers === null || inputTriggers === undefined || typeof inputTriggers.registerSource !== 'function') return;
      const source = {
        trigger: '@',
        name: ELEMENT_REFERENCE_SOURCE,
        showGroupTitle: false,
        candidates: async () =>
          [...recentPicks.entries()].map(([ref, element]) => ({
            name: element.preview === '' ? element.selector : element.preview,
            description: element.selector,
            section: '页面元素',
            value: ref,
          })),
        onPick: ({ candidate }) => ({
          insert: elementInsertion(decodeElementRef(candidate.value) ?? { url: '', selector: String(candidate.value), outerHTML: '', preview: '' }),
        }),
        codec: {
          clipboardText: (ref) => {
            const element = decodeElementRef(ref);
            return element === undefined ? String(ref) : element.selector;
          },
          // 永不在坏 ref 上 reject：否则一次发送会被整段拒绝（DSH 会保留草稿并报错）。
          serialize: (ref) => {
            const element = decodeElementRef(ref);
            return Promise.resolve(element === undefined ? String(ref) : elementBlock(element));
          },
        },
      };
      scope.effect(() => inputTriggers.registerSource(source), 'dsh-desktop-shell: 页面元素引用 source');
      console.log('[dsh-desktop-shell][client] 页面元素引用 source 已注册（引用 chip）');
    }

    /**
     * 构造 tab 正文组件：把 locale 绑定（`t`）注入闭包。
     *
     * 不能写成工厂作用域的裸组件：`t` 只在 `apply` 里绑定，组件直接引用会 ReferenceError。
     * DSH 的 slot props 不保证带 `t`，所以用闭包而不是 props。
     */
    function createPanelComponent(t) {
    /**
     * tab 正文：工具栏 + stage。
     *
     * 每个 occurrence 对应主进程里的一个原生 WebContentsView：所有命令都带 `tabId`，由主进程
     * 路由到该标签自己的视图。stage 是原生视图的“占位框”——网页本身不是 DOM，而是盖在它上面的
     * 原生表面，所以每次布局变化都要把矩形报上去；隐藏只 park 视图，不销毁页面。
     */
    function BrowserPanel(props) {
      const bridge = browserBridge();
      const { id: tabId, visible, sidebar } = readTabInfo(props);
      /** 面板所属的 DSH 会话（框架注入；直连工具桥时为空）。 */
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : '';
      /**
       * 本面板在壳里的**视图 id**：<会话 id>::<侧边栏 tab id>。
       *
       * 一个侧边栏 tab 就是**一个浏览器组件实例**：DSH 的 tab 条决定开几个，每个都有自己的
       * 地址、历史、遮罩与控制权。所以身份必须是"这个 tab occurrence"，不能只是会话——
       * 只按会话会把同一会话的多个 tab 压成同一个视图（多标签能力就没了）。
       * 也不能只用 tab id：DSH 的 tab id 是**按会话**铸造的（dockkit 的计数器在每个会话的
       * store 里），两个会话的 `tab5` 会撞车（用户实报过"新会话显示上一个会话的页面"）。
       * 没有会话 id 时退回原始 id（直连工具桥的情形）。
       */
      const viewId = sessionId === '' ? tabId : `${sessionId}::${tabId}`;
      const stageRef = React.useRef(null);
      const editingRef = React.useRef(false);
      /** 还没有任何页面时不显示原生视图，让空态提示可读。 */
      const hasPageRef = React.useRef(false);
      /** 放置诊断的节流：上一次的签名与时间戳（只在变化或超时时写一行）。 */
      const placementDiagAt = React.useRef(0);
      const placementDiagSignature = React.useRef('');
      /** 宿主公布的侧栏展开态（`sidebar.expanded`），诊断用；undefined = 宿主没给。 */
      const sidebarExpandedFlag = React.useRef(undefined);
      sidebarExpandedFlag.current = sidebar === undefined || sidebar === null ? undefined : sidebar.expanded === true;
      /**
       * 这个面板 occurrence 的身份。
       *
       * 多会话时同一时刻可能有多个面板挂载（keepMounted），主进程只认「当前实例」：
       * 旧实例迟到的放置请求不会再挪动原生视图。这也是「A 会话页面闪现在 B 会话」那个
       * bug 的防线之一（根因见 `syncBounds` 的注释）。
       */
      const instanceId = React.useMemo(() => `p-${Math.random().toString(36).slice(2, 10)}`, []);
      const [view, setView] = React.useState(EMPTY_BROWSER_STATE);
      /** 接管倒计时用的一秒一跳的时钟（只在用户接管期间走）。 */
      const [now, setNow] = React.useState(() => Date.now());
      const [draft, setDraft] = React.useState('');
      const [notice, setNotice] = React.useState('');
      /** 拾取失败（chip 与纯文本都没写进去）时的一行说明；成功时不显示任何东西。 */
      const [pickNotice, setPickNotice] = React.useState('');
      /** 本标签的访问历史（地址栏下拉）与浏览器偏好（主页/收藏）。 */
      const [history, setHistory] = React.useState([]);
      const [prefs, setPrefs] = React.useState(EMPTY_BROWSER_PREFS);
      /** 当前打开的菜单（''/'history'/'more'）与历史里的高亮行。 */
      const [menu, setMenu] = React.useState('');
      const [highlight, setHighlight] = React.useState(0);
      /** 菜单打开期间的冻结快照（原生视图被 park，用这张图当页面底）。 */
      const [frozen, setFrozen] = React.useState(null);
      /** 下载列表（会话级，由主进程推来）与设备模拟行 / 书签改名的小状态。 */
      const [downloads, setDownloads] = React.useState([]);
      const [deviceRowOpen, setDeviceRowOpen] = React.useState(false);
      const [renamingBookmark, setRenamingBookmark] = React.useState('');
      const [bookmarkDraft, setBookmarkDraft] = React.useState('');

      /**
       * 把文本插入 DSH 的输入框：走 ui-conversation 暴露的 `InputActions`
       * （`captureInsertion()` 取选区与版本，`insertText()` 插入一次可撤销的编辑）。
       *
       * `insertText` 会返回 false：草稿版本变了（用户在插入前又打了字）或输入框正在提交。
       * 那不算成功，必须如实回报——否则我们会告诉用户“已插入”而输入框里什么都没有。
       * 拿不到 `InputActions`（不在会话 slot 上下文里）同样返回 false，由调用方退化为复制。
       */
      const insertIntoComposer = React.useCallback(
        (value) => {
          const actions = props.inputActions;
          try {
            if (
              actions !== undefined && actions !== null &&
              typeof actions.captureInsertion === 'function' &&
              typeof actions.insertText === 'function'
            ) {
              const span = actions.captureInsertion();
              if (span !== undefined && span !== null) return actions.insertText(value, span) === true;
            }
          } catch (error) {
            console.warn('[dsh-desktop-shell][client] 写入 DSH 输入框失败', error);
          }
          return false;
        },
        [props.inputActions],
      );

      /**
       * 一次拾取的落点：**优先引用 chip**（和 one-code 的内容标签同形态，提交时由我们的
       * `codec.serialize` 展开成页面元素块）；chip 通道不可用就退回纯文本插入。
       *
       * 成功时面板不显示任何东西——输入框里的 chip（或那段文本）就是反馈，和 one-code 一致。
       * 两条都失败才留一行说明并把内容放进剪贴板。
       */
      const handlePick = React.useCallback(async (raw) => {
        const element = {
          selector: typeof raw.selector === 'string' ? raw.selector : '',
          preview: typeof raw.preview === 'string' && raw.preview !== '' ? raw.preview : String(raw.selector ?? ''),
          url: typeof raw.url === 'string' ? raw.url : '',
          outerHTML: typeof raw.outerHTML === 'string' ? raw.outerHTML : '',
        };
        if (element.selector === '') return;
        // 保留最近拾取的元素：`@` 菜单的「页面元素」分组从这里取候选（chip 的手动兜底入口）。
        recentPicks.set(encodeElementRef(element), element);
        while (recentPicks.size > PICKED_KEEP) recentPicks.delete(recentPicks.keys().next().value);

        const chip = await resolveChipInsert(props.sessionId, element, props.inputActions);
        if (chip === 'inserted') {
          setPickNotice('');
          return;
        }
        if (insertIntoComposer(elementBlock(element))) {
          setPickNotice('');
          return;
        }
        const copied = await copyToClipboard(elementBlock(element));
        setPickNotice(copied ? t('pickedNoInput') : t('browserUnavailable'));
      }, [t, insertIntoComposer, props.inputActions, props.sessionId]);

      /** 拾取结果：主进程已按 nonce 校验过，这里只按视图 id 过滤。 */
      React.useEffect(() => {
        if (bridge === undefined || typeof bridge.onPick !== 'function') return undefined;
        const unsubscribe = bridge.onPick((raw) => {
          if (raw === null || typeof raw !== 'object') return;
          if (typeof raw.tabId === 'string' && raw.tabId !== viewId) return;
          void handlePick(raw);
        });
        return () => {
          if (typeof unsubscribe === 'function') unsubscribe();
        };
      }, [tabId, handlePick]);

      const copyToClipboard = async (value) => {
        try {
          await navigator.clipboard.writeText(value);
          return true;
        } catch (error) {
          console.warn('[dsh-desktop-shell][client] 复制失败', error);
          return false;
        }
      };

      /**
       * 所有命令都带本 occurrence 的 tabId；主进程按它选中对应视图。
       *
       * sessionId 也一并上报：主进程靠它把「用户接管/交还」写进**当前这个会话**，
       * 这样 agent 是被主动告知的，而不是靠一次调用失败去发现。
       */
      const send = React.useCallback(
        (command) => {
          if (bridge === undefined) return Promise.resolve(undefined);
          return bridge.command(Object.assign({ tabId: viewId, sessionId }, command));
        },
        [viewId, sessionId],
      );

      /**
       * 唯一的「这个面板该不该显示、显示在哪」通道：一次测量 → 一条消息。
       *
       * 可见性 = 这个 occurrence 在屏幕上（`visible`）**且**已经加载过页面（没有页面时显示原生视图
       * 会盖住空态提示）。不可见就让主进程 park 掉视图，页面继续在后台跑。
       *
       * 为什么必须合成一条消息（真 bug）：以前 `bounds` + `show`/`hide` 分三条发，而且状态订阅里
       * 还会单独补一条 `show`。切到别的会话后，后台会话的面板照样收到状态推送，那条 `show` 就让
       * 主进程按旧矩形把 A 会话的页面画到了 B 会话界面上（用户实报的「闪现」）。现在所有放置决定
       * 都从这里出去，并带 `instanceId`；主进程只认当前实例，旧实例的迟到消息不会再挪动原生视图。
       *
       * 定义位置是有意的：它在下面的状态订阅 effect 里被调用，而依赖数组在**渲染期**求值，
       * 引用后面才声明的 const 会抛 TDZ（曾经的「面板白屏」），所以它必须在这里。
       */
      const syncBounds = React.useCallback(() => {
        const node = stageRef.current;
        const rect = node === null || typeof node.getBoundingClientRect !== 'function' ? null : node.getBoundingClientRect();
        const onScreen = visible === true && rect !== null && rect.width >= 24 && rect.height >= 24;
        // 诊断：只在**状态变化**或超过 10 秒时写一行，避免刷屏；一眼能看出「为什么没摆放」。
        const signature = `${String(visible === true)}|${String(sidebarExpandedFlag.current)}|${rect === null ? 'none' : `${String(Math.round(rect.width))}x${String(Math.round(rect.height))}`}|${String(onScreen)}`;
        const now = Date.now();
        if (signature !== placementDiagSignature.current || now - placementDiagAt.current > 10000) {
          placementDiagSignature.current = signature;
          placementDiagAt.current = now;
          void send({
            name: 'diag',
            text: `放置：宿主可见=${String(visible === true)} 侧栏展开=${String(sidebarExpandedFlag.current)} 测量=${
              rect === null ? '无' : `${String(Math.round(rect.width))}×${String(Math.round(rect.height))}`
            } onScreen=${String(onScreen)}`,
          });
        }
        // 两个信号必须分开（曾经合在一起造成死锁）：
        //   `onScreen` —— 面板确实在屏幕上。壳据此把 agent 后台标签里的页面**交给**这个空面板；
        //   `visible`  —— 还要求「已经有页面」，壳据此摆放原生视图（没页面时摆上去会盖住空态提示）。
        // 合并成一个时：面板的 tab 是空的 → 永远报不可见 → 壳永远不把页面交给它 → 侧边栏里永远是空的。
        void send({
          name: 'panel',
          instanceId,
          onScreen,
          visible: onScreen && hasPageRef.current === true,
          ...(onScreen ? { rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } } : {}),
        });
      }, [visible, send, instanceId]);

      // ── 浏览器外观（地址栏历史、收藏、菜单冻结）────────────────────────────────
      //
      // 顺序要求：这些都必须在下面用到它们的 useEffect 之前声明。依赖数组在**渲染期**求值，
      // 引用后面才声明的 const 会直接抛 TDZ（曾经的「面板白屏」就是这么来的），
      // 所以这一整块固定放在 send 之后、任何 effect 之前。

      /**
       * 打开菜单前把页面「冻结」：主进程截一张图并 park 掉原生视图，返回图片。
       * 关菜单时反过来恢复。菜单期间 `show` 在主进程侧是空操作，所以不会被抢回焦点。
       */
      /** 把面板侧的关键节点写进 shell.log（客户端 console 在壳里看不到）。 */
      const diag = React.useCallback((text) => {
        void send({ name: 'diag', text: String(text).slice(0, 300) });
      }, [send]);

      const freeze = async () => {
        const result = await send({ name: 'freeze' });
        if (result === null || typeof result !== 'object') {
          diag('冻结：主进程没有响应');
          return;
        }
        // 没有可见的原生表面（空标签、或标签已被 park）：菜单直接画在空舞台上就行，
        // 不要显示「页面已暂停」这种会让人以为坏了的提示。
        if (result.frozen === false) {
          setFrozen(null);
          diag('冻结：当前没有可见页面，无需冻结');
          return;
        }
        if (typeof result.frame === 'string') {
          setFrozen(result.frame);
          diag(`冻结：有帧 ${String(result.frame.length)}`);
          return;
        }
        // 没拿到图（视图还没绘制或截图失败）：舞台给一段说明而不是留白，并把原因记进 shell.log。
        diag(`冻结：无帧${result.ok === false && typeof result.reason === 'string' ? `（${result.reason}）` : ''}`);
        setFrozen(FROZEN_NO_FRAME);
      };
      const closeMenu = (reason = '未标注') => {
        const wasOpen = menu !== '';
        setMenu('');
        setFrozen(null);
        void send({ name: 'unfreeze' });
        if (wasOpen) diag(`菜单关闭（${String(reason)}）`);
      };

      /** 历史记录：有输入时按输入过滤（地址栏下拉的常见行为），否则全部。 */
      const filterHistory = (entries, query, active) => {
        if (!active) return [];
        const needle = query.trim().toLowerCase();
        const matched = needle === ''
          ? entries
          : entries.filter((entry) => entry.url.toLowerCase().includes(needle)
            || (typeof entry.title === 'string' && entry.title.toLowerCase().includes(needle)));
        return matched.slice(0, 10);
      };

      const applyPrefsPayload = (payload) => {
        if (payload === null || typeof payload !== 'object') return;
        setPrefs({
          homepage: typeof payload.homepage === 'string' ? payload.homepage : '',
          bookmarks: Array.isArray(payload.bookmarks) ? payload.bookmarks : [],
          bookmarkBarVisible: payload.bookmarkBarVisible === true,
        });
      };

      const refreshHistory = React.useCallback(async () => {
        const result = await send({ name: 'history' });
        if (result !== null && typeof result === 'object' && Array.isArray(result.entries)) setHistory(result.entries);
      }, [send]);

      const refreshPrefs = React.useCallback(async () => {
        const result = await send({ name: 'prefs' });
        if (result !== null && typeof result === 'object') applyPrefsPayload(result.prefs);
      }, [send]);

      const removeHistory = async (url) => {
        const result = await send({ name: 'clearHistory', url });
        if (result !== null && typeof result === 'object' && Array.isArray(result.entries)) setHistory(result.entries);
      };

      const clearHistory = async () => {
        const result = await send({ name: 'clearHistory' });
        if (result !== null && typeof result === 'object' && Array.isArray(result.entries)) setHistory(result.entries);
      };

      const setPrefsPatch = async (patch) => {
        const result = await send({ name: 'setPrefs', patch });
        if (result !== null && typeof result === 'object' && result.prefs !== undefined) {
          applyPrefsPayload(result.prefs);
          return;
        }
        if (result !== null && typeof result === 'object' && typeof result.reason === 'string') setNotice(result.reason);
      };

      const toggleBookmark = async () => {
        if (view.url === '') return;
        const existing = prefs.bookmarks.filter((entry) => entry.url === view.url);
        const next = existing.length > 0
          ? prefs.bookmarks.filter((entry) => entry.url !== view.url)
          : [...prefs.bookmarks, { url: view.url, title: view.title, at: Date.now() }];
        await setPrefsPatch({ bookmarks: next });
      };

      /** 下载列表：会话级，主进程推、面板只读展示。 */
      const applyDownloads = (payload) => {
        if (payload === null || typeof payload !== 'object' || !Array.isArray(payload.downloads)) return;
        setDownloads(payload.downloads.slice(-3));
      };
      const refreshDownloads = React.useCallback(async () => {
        const result = await send({ name: 'downloads' });
        if (result !== null && typeof result === 'object') applyDownloads(result);
      }, [send]);

      const downloadCommand = async (name, id) => {
        const result = await send(id === undefined ? { name } : { name, id });
        if (result !== null && typeof result === 'object') {
          applyDownloads(result);
          if (result.ok === false && typeof result.reason === 'string') setNotice(result.reason);
        }
      };

      /** 设备模拟：预设 / 自定义宽高 / 旋转，都走同一个命令。 */
      const setDeviceSpec = (patch) => {
        void run({ name: 'deviceSpec', ...patch });
      };

      /** 书签改名：把改好的标题写回整表（主进程按整表替换）。 */
      const commitBookmarkRename = async (url) => {
        const title = bookmarkDraft.trim();
        setRenamingBookmark('');
        if (title === '') return;
        const next = prefs.bookmarks.map((entry) => (entry.url === url ? { ...entry, title } : entry));
        await setPrefsPatch({ bookmarks: next });
      };

      const removeBookmark = async (url) => {
        await setPrefsPatch({ bookmarks: prefs.bookmarks.filter((entry) => entry.url !== url) });
      };

      // 主进程推来的导航状态（按**视图 id** 过滤，只认自己那一份）。
      //
      // 必须比 `viewId`（`<会话>::<侧边栏 tab>`）而不是 DSH 的裸 `tabId`：主进程的推送是按视图 id
      // 打标的，比错字段就把**所有**页面状态推送都丢掉。后果正是用户实报的那个 bug——新会话第一次
      // 打开浏览器时侧边栏一直空白（面板永远不知道"页面已经有了"，于是从不上报可见），切走再切回来
      // 才显示（那次切换会重新走一遍声明，正好在页面已加载之后触发接管）。
      React.useEffect(() => {
        if (bridge === undefined) return undefined;
        const unsubscribe = bridge.subscribe((next) => {
          if (next === null || typeof next !== 'object') return;
          if (typeof next.tabId === 'string' && next.tabId !== viewId) return;
          setView(next);
          // 标题是给侧边栏 tab 条用的，那一层按 DSH 自己的 tab id 认人，所以这里仍用 `tabId`。
          publishBrowserTitle(tabId, next.title);
          const hasPage = typeof next.url === 'string' && next.url !== '';
          hasPageRef.current = hasPage;
          // 页面（刚）加载出来时重算一次：可见就显示、不可见（后台会话）就保持 park。
          // 以前这里无条件发 show，正是「A 会话页面闪现在 B 会话」的根因。
          syncBounds();
          if (editingRef.current === false && hasPage) setDraft(next.url);
          // 每次导航后刷新历史（下拉要立刻能看到刚访问的页面）。
          if (hasPage) void refreshHistory();
        });
        return () => {
          if (typeof unsubscribe === 'function') unsubscribe();
        };
      }, [tabId, viewId, send, refreshHistory, syncBounds]);

      // 首次挂载：读一次浏览器偏好、历史与下载。
      React.useEffect(() => {
        void refreshPrefs();
        void refreshHistory();
        void refreshDownloads();
      }, [refreshPrefs, refreshHistory, refreshDownloads]);

      // 下载列表由主进程推（进度会变），所以订阅一次。
      React.useEffect(() => {
        if (bridge === undefined || typeof bridge.onDownloads !== 'function') return undefined;
        const unsubscribe = bridge.onDownloads((payload) => applyDownloads(payload));
        return () => {
          if (typeof unsubscribe === 'function') unsubscribe();
        };
      }, []);

      /**
       * 把「这个会话的 agent 是否在跑」上报给壳：遮罩按**回合**显示与撤下。
       *
       * 只在**知道**的时候上报：拿不到条目、或 `running` 不是布尔时什么都不发，让壳走它的兜底
       * （调用结束后短暂保留），绝不伪造 `false` —— 那会把正在干活的遮罩误撤。
       */
      React.useEffect(() => {
        const source = sessionStatusSource;
        if (source === null || typeof source !== 'object' || typeof source.getSnapshot !== 'function') return undefined;
        if (sessionId === '') return undefined;
        let last;
        const publish = () => {
          let running;
          try {
            const snapshot = source.getSnapshot();
            const entry = snapshot !== null && typeof snapshot === 'object' && typeof snapshot.get === 'function'
              ? snapshot.get(sessionId)
              : undefined;
            running = entry !== null && typeof entry === 'object' ? entry.running : undefined;
          } catch (error) {
            running = undefined;
          }
          if (typeof running !== 'boolean' || running === last) return;
          last = running;
          void send({ name: 'agentRunning', running });
        };
        publish();
        const unsubscribe = typeof source.subscribe === 'function' ? source.subscribe(publish) : undefined;
        return () => {
          if (typeof unsubscribe === 'function') unsubscribe();
          // 面板卸载（关掉这个 tab、页面重载）＝ 没人再盯着这个会话的回合了：上报一次 false，
          // 免得上一次的 true 把遮罩永久留在屏幕上。代价（罕见）：同一会话里关掉另一个浏览器 tab
          // 时可能顺带撤下这一回合的遮罩，而下一次工具调用会立刻把它带回来。
          void send({ name: 'agentRunning', running: false });
        };
      }, [send, sessionId]);

      // 接管期间每秒走一格，让「N 秒无操作后自动交还」的倒计时可见。
      React.useEffect(() => {
        if (view.userDriving !== true || !(view.autoReleaseAt > 0)) return undefined;
        setNow(Date.now());
        const timer = setInterval(() => { setNow(Date.now()); }, 1000);
        return () => { clearInterval(timer); };
      }, [view.userDriving, view.autoReleaseAt]);

      /**
       * 菜单开着时的收尾：Esc、点菜单外面都关掉，并**一定要解冻**。
       *
       * 菜单打开期间原生视图是 park 的（页面由一张冻结图代替），所以任何一条「忘了关」的路径
       * 都会让用户看到一张静止的图。切 tab / 面板卸载同样要解冻。
       */
      React.useEffect(() => {
        if (menu === '') return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') closeMenu('Esc');
        };
        const onPointerDown = (event) => {
          const target = event.target;
          if (target === null || typeof target.closest !== 'function') return;
          if (target.closest('.dsb-menu') !== null || target.closest('.dsb-wrap') !== null || target.closest('.dsb-menuWrap') !== null) return;
          closeMenu('点菜单外面');
        };
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('pointerdown', onPointerDown, true);
        return () => {
          document.removeEventListener('keydown', onKey, true);
          document.removeEventListener('pointerdown', onPointerDown, true);
        };
      }, [menu]);

      // 切走标签 / 面板卸载：视图本来就会被 park，但要顺手把冻结标记收掉。
      React.useEffect(() => {
        if (visible === true) return undefined;
        if (menu === '') return undefined;
        closeMenu('标签切走');
        return undefined;
      }, [visible, menu]);

      // 视图按需创建（第一次打开这个标签时才建页面进程）。页面可能在上次关闭面板时仍然
      // 活着，所以创建后立刻取一次状态，把地址栏恢复成当前 URL。
      React.useEffect(() => {
        if (bridge === undefined) return undefined;
        let cancelled = false;
        void (async () => {
          try {
            const result = await send({ name: 'create' });
            if (cancelled || result === null || typeof result !== 'object') return;
            const next = result.state;
            if (next === undefined || next === null) return;
            setView(next);
            publishBrowserTitle(tabId, next.title);
            const hasPage = typeof next.url === 'string' && next.url !== '';
            hasPageRef.current = hasPage;
            if (hasPage) setDraft(next.url);
          } catch (error) {
            console.warn('[dsh-desktop-shell][client] 浏览器视图创建失败', error);
          }
        })();
        return () => {
          cancelled = true;
        };
      }, [tabId, send]);

      // ResizeObserver 覆盖侧栏拖宽/分栏变化，window resize 覆盖窗口缩放，
      // visible 变化覆盖切 tab、收起侧栏与停靠形态切换（keepMounted 下 body 不卸载）。
      React.useEffect(() => {
        if (bridge === undefined) return undefined;
        let frame = 0;
        const schedule = () => {
          if (frame !== 0) return;
          frame = window.requestAnimationFrame(() => {
            frame = 0;
            syncBounds();
          });
        };
        schedule();
        // 入场动画/首次布局后补一次，避免第一帧量到 0 尺寸。
        const settle = window.setTimeout(schedule, 160);
        const node = stageRef.current;
        let observer;
        if (node !== null && typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(schedule);
          observer.observe(node);
        }
        window.addEventListener('resize', schedule);
        window.addEventListener('scroll', schedule, true);
        return () => {
          if (frame !== 0) window.cancelAnimationFrame(frame);
          window.clearTimeout(settle);
          if (observer !== undefined) observer.disconnect();
          window.removeEventListener('resize', schedule);
          window.removeEventListener('scroll', schedule, true);
          // 卸载 = 明确地说「我不在屏幕上了」，同样走这一条消息。
          void send({ name: 'panel', instanceId, visible: false });
        };
      }, [syncBounds, send]);

      /**
       * 面板（重新）变得可见时，问一次主进程当前状态。
       *
       * `hasPageRef` 是本地状态：面板重新挂载（切会话）或**主进程在面板出现之前就已经加载过页面**
       * （agent 先在后台标签打开页面、再请求显示）时它会是 false，于是面板报 `visible: false`，
       * 原生视图永远不摆放 —— 用户实报的「侧边栏打开了，但 agent 请求的页面没显示」正是这个。
       * 问完再 `syncBounds()`，让这一轮的可见性判断建立在事实上。
       */
      React.useEffect(() => {
        if (bridge === undefined || visible !== true) return undefined;
        let cancelled = false;
        void (async () => {
          try {
            const answer = await send({ name: 'state' });
            if (cancelled) return;
            const state = answer !== null && typeof answer === 'object' ? answer.state : undefined;
            if (state !== null && typeof state === 'object') {
              setView(state);
              if (typeof state.url === 'string' && state.url !== '') {
                hasPageRef.current = true;
                if (editingRef.current === false) setDraft(state.url);
              }
            }
          } catch {
            /* 拿不到状态就按原样上报，不阻塞显示 */
          }
          if (!cancelled) syncBounds();
        })();
        return () => { cancelled = true; };
      }, [visible, send, syncBounds]);

      const run = React.useCallback(
        async (command) => {
          if (bridge === undefined) return;
          try {
            const result = await send(command);
            if (result !== null && typeof result === 'object') {
              if (result.state !== undefined && result.state !== null) {
                setView(result.state);
                if (typeof result.state.url === 'string' && result.state.url !== '') hasPageRef.current = true;
              }
              if (result.ok === false) {
                setNotice(typeof result.reason === 'string' ? result.reason : t('browserUnavailable'));
                return;
              }
            }
            setNotice('');
          } catch (error) {
            setNotice(String(error && error.message ? error.message : error));
          }
        },
        [send],
      );

      if (bridge === undefined) {
        return h('div', { className: 'dsb' }, h('div', { className: 'dsb-stage' }, t('browserUnavailable')));
      }

      const submit = (event) => {
        event.preventDefault();
        editingRef.current = false;
        void run({ name: 'navigate', url: draft });
      };

      const failure = view.error;
      const picking = view.picking === true;
      const bookmarked = prefs.bookmarks.some((entry) => entry.url === view.url);
      const shownHistory = filterHistory(history, draft, menu === 'history');
      const menuOpen = (kind) => {
        if (menu === kind) { closeMenu('再次点击按钮'); return; }
        diag(`菜单打开（${kind}）`);
        setMenu(kind);
        // 原生视图永远盖在 DOM 上：打开菜单前先让主进程把页面冻成一张图并 park 掉视图，
        // 菜单才点得到（one-code 用的也是这个办法）。
        void freeze();
      };
      return h(
        'div',
        { className: 'dsb' },
        h(
          'div',
          { className: 'dsb-bar' },
          h('button', { type: 'button', title: t('browserBack'), 'aria-label': t('browserBack'), disabled: view.canGoBack !== true, onClick: () => void run({ name: 'back' }) }, '←'),
          h('button', { type: 'button', title: t('browserForward'), 'aria-label': t('browserForward'), disabled: view.canGoForward !== true, onClick: () => void run({ name: 'forward' }) }, '→'),
          h('button', { type: 'button', title: t('browserReload'), 'aria-label': t('browserReload'), onClick: () => void run({ name: 'reload' }) }, '⟳'),
          h('button', { type: 'button', title: t('browserHome'), 'aria-label': t('browserHome'), onClick: () => void run({ name: 'navigate', url: prefs.homepage === '' ? 'about:blank' : prefs.homepage }) }, '⌂'),
          h(
            'div',
            { className: 'dsb-wrap' },
            h(
              'form',
              { onSubmit: submit },
              h('input', {
                type: 'text',
                value: draft,
                placeholder: t('browserPlaceholder'),
                spellCheck: false,
                onFocus: () => {
                  editingRef.current = true;
                  if (history.length > 0) menuOpen('history');
                },
                onBlur: () => {
                  editingRef.current = false;
                },
                onChange: (event) => {
                  setDraft(event.target.value);
                  if (menu !== 'history' && history.length > 0) menuOpen('history');
                },
                onKeyDown: (event) => {
                  if (menu !== 'history' || shownHistory.length === 0) return;
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    setHighlight((current) => Math.min(current + 1, shownHistory.length - 1));
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    setHighlight((current) => Math.max(current - 1, 0));
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    closeMenu();
                  }
                },
              }),
              h('button', { type: 'submit' }, t('browserOpen')),
            ),
            menu === 'history'
              ? h(
                  'div',
                  { className: 'dsb-menu', onMouseDown: (event) => event.preventDefault() },
                  h('div', { className: 'dsb-menuTitle' }, t('browserHistory')),
                  shownHistory.length === 0
                    ? h('div', { className: 'dsb-row' }, t('browserHistoryEmpty'))
                    : shownHistory.map((entry, index) =>
                        h(
                          'div',
                          {
                            key: `${entry.url}-${String(entry.at)}`,
                            className: 'dsb-row',
                            'data-active': index === highlight ? 'true' : 'false',
                            onMouseEnter: () => setHighlight(index),
                            onClick: () => {
                              closeMenu();
                              void run({ name: 'navigate', url: entry.url });
                            },
                          },
                          h(
                            'div',
                            { className: 'dsb-rowText' },
                            h('span', { className: 'dsb-rowTitle' }, entry.title === '' ? entry.url : entry.title),
                            entry.title === '' ? null : h('span', { className: 'dsb-rowSub' }, entry.url),
                          ),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'dsb-rowOp',
                              title: t('browserRemoveEntry'),
                              onClick: (event) => {
                                event.stopPropagation();
                                void removeHistory(entry.url);
                              },
                            },
                            '×',
                          ),
                        ),
                      ),
                  history.length === 0
                    ? null
                    : h(
                        'div',
                        {
                          className: 'dsb-menuFoot',
                          onClick: () => {
                            closeMenu();
                            void clearHistory();
                          },
                        },
                        t('browserClearHistory'),
                      ),
                )
              : null,
          ),
          h(
            'button',
            {
              type: 'button',
              title: bookmarked ? t('browserUnbookmark') : t('browserBookmark'),
              'aria-label': bookmarked ? t('browserUnbookmark') : t('browserBookmark'),
              'data-on': bookmarked ? 'true' : 'false',
              disabled: view.url === '',
              onClick: () => void toggleBookmark(),
            },
            bookmarked ? '★' : '☆',
          ),
          h(
            'button',
            {
              type: 'button',
              title: t('browserDeviceRow'),
              'aria-label': t('browserDeviceRow'),
              'data-on': deviceRowOpen ? 'true' : 'false',
              onClick: () => setDeviceRowOpen((open) => !open),
            },
            '📱',
          ),
          h(
            'button',
            {
              type: 'button',
              title: view.url === '' ? t('browserPickDisabled') : picking ? t('browserPickOn') : t('browserPick'),
              'aria-label': t('browserPick'),
              'data-on': picking ? 'true' : 'false',
              // Nothing to pick on an empty tab: arming the picker would only confuse.
              disabled: view.url === '',
              onClick: () => void run({ name: 'pick', enabled: !picking }),
            },
            '⌖',
          ),
          h(
            'div',
            // 自己的定位上下文且**不参与 flex 拉伸**：菜单要贴着按钮对齐，
            // 用地址栏那种 flex:1 的包裹层会把菜单撑到工具栏最右边（曾经的错位）。
            { className: 'dsb-menuWrap' },
            h(
              'button',
              {
                type: 'button',
                title: t('browserMore'),
                'aria-label': t('browserMore'),
                'data-on': menu === 'more' ? 'true' : 'false',
                onClick: () => menuOpen('more'),
              },
              '⋯',
            ),
          ),
          menu === 'more'
            ? h(
                'div',
                { className: 'dsb-menu dsb-menuRight', onMouseDown: (event) => event.preventDefault() },
                // 主页：以前只能读不能设，等于「主页按钮没什么用」。
                h('div', { className: 'dsb-row dsb-rowStatic' }, `${t('browserHomepage')}：${prefs.homepage === '' ? t('browserHomepageUnset') : prefs.homepage}`),
                h(
                  'div',
                  {
                    className: 'dsb-row',
                    'data-disabled': view.url === '' ? 'true' : 'false',
                    onClick: () => {
                      if (view.url === '') return;
                      closeMenu('设为主页');
                      void setPrefsPatch({ homepage: view.url });
                    },
                  },
                  t('browserSetHomepage'),
                ),
                prefs.homepage === ''
                  ? null
                  : h(
                      'div',
                      {
                        className: 'dsb-row',
                        onClick: () => {
                          closeMenu('清除主页');
                          void setPrefsPatch({ homepage: '' });
                        },
                      },
                      t('browserClearHomepage'),
                    ),
                h(
                  'div',
                  {
                    className: 'dsb-row',
                    onClick: () => {
                      closeMenu();
                      void toggleBookmark();
                    },
                  },
                  bookmarked ? t('browserUnbookmark') : t('browserBookmark'),
                ),
                h(
                  'div',
                  {
                    className: 'dsb-row',
                    onClick: () => {
                      closeMenu();
                      void setPrefsPatch({ bookmarkBarVisible: prefs.bookmarkBarVisible !== true });
                    },
                  },
                  `${prefs.bookmarkBarVisible === true ? '✓ ' : ''}${t('browserBookmarkBar')}`,
                ),
                h(
                  'div',
                  {
                    className: 'dsb-row',
                    onClick: () => {
                      closeMenu();
                      void clearHistory();
                    },
                  },
                  t('browserClearHistory'),
                ),
                h(
                  'div',
                  {
                    className: 'dsb-row',
                    onClick: () => {
                      closeMenu();
                      void run({ name: 'clearCache' });
                    },
                  },
                  t('browserClearCache'),
                ),
                h(
                  'div',
                  {
                    className: 'dsb-row',
                    onClick: () => {
                      if (typeof window.confirm === 'function' && !window.confirm(t('browserClearCookiesConfirm'))) return;
                      closeMenu();
                      void run({ name: 'clearCookies' });
                    },
                  },
                  t('browserClearCookies'),
                ),
              )
            : null,
        ),
        notice === '' ? null : h('div', { className: 'dsb-notice' }, notice),
        picking ? h('div', { className: 'dsb-hint' }, t('browserPickOn')) : null,
        failure === null
          ? null
          : h('div', { className: 'dsb-notice' }, failure.message ?? String(failure.description ?? '')),
        // 拾取成功时什么都不显示（输入框里的 chip 就是反馈）；只有 chip 与纯文本都失败才留一行。
        pickNotice === '' ? null : h('div', { className: 'dsb-hint' }, pickNotice),
        // 设备模拟行（📱 切换）：预设 + 自定义宽高 + 旋转，都是 per-tab 的。
        deviceRowOpen
          ? h(
              'div',
              { className: 'dsb-deviceRow' },
              h(
                'select',
                {
                  title: t('browserDevice'),
                  'aria-label': t('browserDevice'),
                  value: typeof view.device === 'string' ? view.device : 'desktop',
                  onChange: (event) => setDeviceSpec({ preset: event.target.value }),
                },
                h('option', { value: 'desktop' }, t('deviceDesktop')),
                h('option', { value: 'iphone' }, t('deviceIphone')),
                h('option', { value: 'android' }, t('deviceAndroid')),
              ),
              h(
                'label',
                { className: 'dsb-deviceField' },
                t('browserDeviceWidth'),
                h('input', {
                  type: 'number',
                  min: 240,
                  max: 2560,
                  value: view.deviceWidth === 0 ? '' : view.deviceWidth,
                  placeholder: '1280',
                  onChange: (event) => setDeviceSpec({ width: Number(event.target.value), height: view.deviceHeight === 0 ? 800 : view.deviceHeight }),
                }),
              ),
              h(
                'label',
                { className: 'dsb-deviceField' },
                t('browserDeviceHeight'),
                h('input', {
                  type: 'number',
                  min: 320,
                  max: 2560,
                  value: view.deviceHeight === 0 ? '' : view.deviceHeight,
                  placeholder: '800',
                  onChange: (event) => setDeviceSpec({ width: view.deviceWidth === 0 ? 1280 : view.deviceWidth, height: Number(event.target.value) }),
                }),
              ),
              h(
                'button',
                {
                  type: 'button',
                  title: t('browserDeviceRotate'),
                  'data-on': view.deviceRotated === true ? 'true' : 'false',
                  onClick: () => setDeviceSpec({ rotate: view.deviceRotated !== true }),
                },
                '⟲',
              ),
              h(
                'button',
                { type: 'button', title: t('browserDeviceReset'), onClick: () => setDeviceSpec({ preset: 'desktop' }) },
                t('browserDeviceReset'),
              ),
            )
          : null,
        // 下载：会话级列表，最多显示最近 3 条（one-code 的 DownloadBar 同形）。
        downloads.length === 0
          ? null
          : h(
              'div',
              { className: 'dsb-downloads' },
              h(
                'div',
                { className: 'dsb-downloadsHead' },
                h('span', null, t('browserDownloads')),
                h(
                  'button',
                  { type: 'button', className: 'dsb-rowOp', title: t('browserDownloadClear'), onClick: () => void downloadCommand('clearDownloads') },
                  t('browserDownloadClear'),
                ),
              ),
              downloads.map((entry) =>
                h(
                  'div',
                  { className: 'dsb-download', key: entry.id },
                  h(
                    'div',
                    { className: 'dsb-downloadText' },
                    h('span', { className: 'dsb-rowTitle' }, entry.filename),
                    h(
                      'span',
                      { className: 'dsb-rowSub' },
                      `${t(`download${entry.state === 'progressing' ? 'Progressing' : entry.state === 'completed' ? 'Completed' : entry.state === 'cancelled' ? 'Cancelled' : 'Interrupted'}`)} · ${formatBytes(entry.receivedBytes)}${entry.totalBytes > 0 ? ` / ${formatBytes(entry.totalBytes)}` : ''}`,
                    ),
                    entry.state === 'progressing'
                      ? h(
                          'div',
                          { className: 'dsb-progress' },
                          h('div', {
                            className: 'dsb-progressBar',
                            style: { width: `${String(entry.totalBytes > 0 ? Math.min(100, Math.round((entry.receivedBytes / entry.totalBytes) * 100)) : 5)}%` },
                          }),
                        )
                      : null,
                  ),
                  entry.state === 'completed'
                    ? h(
                        'button',
                        { type: 'button', className: 'dsb-rowOp', title: t('browserDownloadOpen'), onClick: () => void downloadCommand('openDownload', entry.id) },
                        t('browserDownloadOpen'),
                      )
                    : null,
                  entry.state === 'completed'
                    ? h(
                        'button',
                        { type: 'button', className: 'dsb-rowOp', title: t('browserDownloadReveal'), onClick: () => void downloadCommand('revealDownload', entry.id) },
                        '📂',
                      )
                    : null,
                ),
              ),
            ),
        prefs.bookmarkBarVisible !== true || prefs.bookmarks.length === 0
          ? null
          : h(
              'div',
              { className: 'dsb-bookmarks' },
              prefs.bookmarks.map((entry) =>
                renamingBookmark === entry.url
                  ? h('input', {
                      key: entry.url,
                      className: 'dsb-bmInput',
                      value: bookmarkDraft,
                      autoFocus: true,
                      onChange: (event) => setBookmarkDraft(event.target.value),
                      onBlur: () => void commitBookmarkRename(entry.url),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter') void commitBookmarkRename(entry.url);
                        if (event.key === 'Escape') setRenamingBookmark('');
                      },
                    })
                  : h(
                      'span',
                      { key: entry.url, className: 'dsb-bmWrap' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsb-bm',
                          title: `${entry.url}\n${t('browserBookmarkRename')}`,
                          onClick: () => void run({ name: 'navigate', url: entry.url }),
                          onDoubleClick: () => {
                            setRenamingBookmark(entry.url);
                            setBookmarkDraft(entry.title === '' ? entry.url : entry.title);
                          },
                        },
                        h('span', null, entry.title === '' ? entry.url : entry.title),
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsb-bmRemove',
                          title: t('browserUnbookmark'),
                          onClick: () => void removeBookmark(entry.url),
                        },
                        '×',
                      ),
                    ),
              ),
            ),
        // 助手正在操作 / 用户已接管。遮罩盖在网页上时面板提示可能被忽略，这一条是明确说明；
        // 「立即交还」是用户主动把浏览器还给助手的地方（不点也没关系：空闲会自动交还）。
        view.userDriving === true
          ? h(
              'div',
              { className: 'dsb-agentBar', 'data-tone': 'user' },
              h('span', null, t('browserUserDriving')),
              view.autoReleaseAt > 0
                ? h('span', { className: 'dsb-agentHint' }, autoReleaseHint(t, view.autoReleaseAt, now))
                : null,
              h(
                'button',
                { type: 'button', className: 'dsb-rowOp', onClick: () => void run({ name: 'releaseBrowser' }) },
                t('browserReleaseNow'),
              ),
            )
          : view.agentActive === true
            ? h(
                'div',
                { className: 'dsb-agentBar', 'data-tone': 'agent' },
                h('span', { className: 'dsb-agentDot' }),
                h('span', null, t('browserAgentDriving')),
              )
            : null,
        h(
          'div',
          { className: 'dsb-stage', ref: stageRef },
          // 冻结快照：菜单打开期间原生视图被 park，这张图就是用户看到的“页面”。
          // 没截到图时给一段说明而不是留白，否则看起来像浏览器坏了。
          frozen === null
            ? null
            : frozen === FROZEN_NO_FRAME
              ? h('div', { className: 'dsb-frozenHint' }, t('browserFrozenNoFrame'))
              : h('img', { className: 'dsb-frozen', src: frozen, alt: '' }),
          view.url === '' && failure === null ? t('browserEmpty') : null,
        ),
      );
    }
      return BrowserPanel;
    }

    /** tab chip 标题：显示页面标题，没拿到就退回类型名。 */
    function createTitleComponent(t) {
      function BrowserTitle(props) {
        const { id: tabId } = readTabInfo(props);
        const title = useBrowserTitle(tabId);
        return h('span', null, typeof title === 'string' && title !== '' ? title : t('browserTab'));
      }
      return BrowserTitle;
    }

    /**
     * DSH 右侧栏当前占掉的宽度（0 = 收起/不存在）。
     *
     * 抽屉是右边缘的浮层，而 DSH 的右侧栏也在右边：不处理就会直接**盖住**侧栏。这里量一下
     * 侧栏的会话元素（DSH 自己用 `[data-sidebar-right-session]` 标记，`commandTarget` 也认它），
     * 让抽屉贴在它左边，两者并排而不是重叠。量不到就退回 0（贴窗口右边缘）。
     */

    /**
     * 打开侧边栏里的浏览器 tab —— 由**面板之外**的部分持有，所以即使用户从没打开过侧边栏也能用。
     *
     * 壳在「agent 要求显示页面、但面板当前不可见」时发来请求（IPC `browser-open-pane`）；
     * 这里调用 DSH 客户端的 `sidebarRight.openTab / openTabIn`（打开 pane 是纯客户端操作，
     * 主进程没有这个能力）。两者都失败时返回 false，壳会让页面留在后台并在结果里说明。
     *
     * @type {((sessionId: string) => boolean) | null}
     */
    let openBrowserPaneTab = null;

    /** DSH 的右侧栏控制器（ctx.sidebarRight）：用于在需要时展开侧栏。 */
    let paneSidebar = null;

    /**
     * DSH 的会话运行状态（`uiSession.sessionStatus`）。
     *
     * 遮罩要跟着 **agent 的回合**走，而不是跟着每一次工具调用走：两次调用之间模型要思考几秒到几十秒，
     * 按调用开关遮罩会让整个浏览器一闪一闪（用户实报）。DSH 自己就有这份状态（服务端 `api-session/status`
     * 事件 → `uiSession` 的 `sessionStatus` 快照），面板读它并把 running 上报给壳。
     *
     * 拿不到（老版本 DSH、服务缺失）时保持 null：壳退回"调用结束后短暂保留"的兜底，不会伪造状态。
     *
     * @type {{getSnapshot: Function, subscribe?: Function} | null}
     */
    let sessionStatusSource = null;

    /**
     * 注册侧边栏浏览器 tab；任何一步不满足就整段跳过，绝不影响设置页与 DSH 页面。
     * @returns 撤销函数：设置里关掉浏览器时用它把注册干净地收回。
     */
    function registerSidebarBrowser(ctx, t) {
      const bridge = browserBridge();
      if (bridge === undefined) {
        browserPanelCheck = 'no-bridge';
        return () => {};
      }
      if (typeof ctx.inject !== 'function') {
        browserPanelCheck = 'no-services';
        return () => {};
      }
      /** 收集注册产生的 disposer；设置里关掉时逐个调用。 */
      const disposers = [];
      let cancelled = false;
      // 引用 chip 的通道（`inputTriggers` 的 source 注册 + 会话作用域的事件派发）单独注入：
      // 任一服务缺失只让 chip 退化成纯文本插入，不影响面板本体。
      try {
        ctx.inject(['sessions', 'inputTriggers'], (scope) => {
          if (cancelled || scope === undefined || scope.sessions === undefined || scope.inputTriggers === undefined) return;
          referenceServices = { sessions: scope.sessions, inputTriggers: scope.inputTriggers };
          registerElementReference(scope);
        });
      } catch (error) {
        console.warn('[dsh-desktop-shell][client] 引用 chip 通道未就绪，拾取将退回纯文本', error);
      }
      try {
        // 手动入口之一：一个快捷键命令（引导页卡片也引用它，见下面 tab 类型的 `guide.commandId`）。
        // 这是 DSH 自己的命令机制（`ctx.shortcuts.register`），默认键只在 desktop 三平台给，
        // 注册失败只记日志——入口少了不该影响浏览器本身。
        ctx.inject(['shortcuts'], (scope) => {
          if (cancelled || scope === undefined || scope.shortcuts === undefined) return;
          try {
            disposers.push(scope.effect(() => scope.shortcuts.register({
              id: BROWSER_NEW_COMMAND,
              label: () => t('browserTab'),
              aliases: ['browser', 'new browser tab', '浏览器'],
              defaults: {
                'desktop:macos': { code: 'KeyB', modifiers: ['primary', 'shift'] },
                'desktop:windows': { code: 'KeyB', modifiers: ['primary', 'shift'] },
                'desktop:linux': { code: 'KeyB', modifiers: ['primary', 'shift'] },
              },
              regions: ['page', 'editable', 'terminal'],
              modals: [],
              resolve: () => ({
                status: 'handled',
                run: () => {
                  // 用户主动"新开一个浏览器标签"：按当前屏幕上的会话开（`openTab` 自带展开）。
                  const sidebar = paneSidebar;
                  if (sidebar === null || typeof sidebar.openTab !== 'function') {
                    console.warn('[dsh-desktop-shell][client] 侧边栏服务尚不可用，无法新开浏览器标签');
                    return;
                  }
                  try {
                    sidebar.openTab(BROWSER_TAB_KIND, {});
                  } catch (error) {
                    console.warn('[dsh-desktop-shell][client] 新开浏览器标签失败', error);
                  }
                },
              }),
            }), 'dsh-desktop-shell: browser shortcut'));
          } catch (error) {
            console.warn('[dsh-desktop-shell][client] 浏览器快捷键注册失败（引导页卡片仍在）', error);
          }
        });
      } catch (error) {
        console.warn('[dsh-desktop-shell][client] 快捷键通道未就绪，跳过浏览器快捷键', error);
      }
      try {
        ctx.inject(['sidebarRight', 'sidebarRightTabs'], (scope) => {
          if (cancelled) return;
          if (scope === undefined) return;
          if (scope.sidebarRightTabs === undefined || scope.sidebarRight === undefined || scope.slots === undefined) {
            browserPanelCheck = 'no-services';
            console.warn('[dsh-desktop-shell][client] 缺少 sidebarRight 服务，跳过侧边栏浏览器');
            return;
          }
          const Panel = createPanelComponent(t);
          const Title = createTitleComponent(t);
          disposers.push(scope.effect(
            () =>
              scope.sidebarRightTabs.register({
                id: BROWSER_TAB_ID,
                kind: BROWSER_TAB_KIND,
                // 产品外的类型用 extension 档（也是不写时的默认值）；kind 唯一，不参与资源认领。
                priority: 'extension',
                // 每个 occurrence 独立一个标签（也就是一个原生视图）。
                multiple: true,
                // 切 tab / 收起侧栏时正文不卸载：页面与滚动位置都留着，只是被 park。
                keepMounted: true,
                title: () => t('browserTab'),
                // 引导页（「开始」）里的手动入口：DSH 用它自己的卡片机制渲染，点一下就按 kind 打开。
                // `commandId` 指向下面注册的快捷键命令，卡片上会显示按键提示。
                guide: [
                  {
                    id: 'open',
                    commandId: BROWSER_NEW_COMMAND,
                    order: 40,
                    title: () => t('browserTab'),
                    description: () => t('browserGuide'),
                  },
                ],
              }),
            'dsh-desktop-shell: browser tab type',
          ));
          disposers.push(scope.effect(
            () =>
              scope.slots.inject('sidebar.right.pane.tab', () =>
                scope.slots.register(
                  {
                    name: 'sidebar.right.pane.tab',
                    key: BROWSER_TAB_ID,
                    locale: NS,
                    // 框架把当前会话 id 注入进来：引用 chip 需要它来取会话作用域 ctx。
                    inject: (sessionId) => ({ sessionId }),
                  },
                  Panel,
                ),
              ),
            'dsh-desktop-shell: browser body',
          ));
          disposers.push(scope.effect(
            () =>
              scope.slots.inject('sidebar.right.pane.tab.title', () =>
                scope.slots.register(
                  { name: 'sidebar.right.pane.tab.title', key: BROWSER_TAB_ID, locale: NS },
                  Title,
                ),
              ),
            'dsh-desktop-shell: browser title',
          ));
          disposers.push(scope.effect(
            () =>
              scope.sidebarRight.registerCloseHandler(BROWSER_TAB_KIND, (closeSessionId, tab) => {
                // 关掉哪一个标签就销毁哪一个视图；拿不到 id 时不做任何破坏性动作。
                const id = tab !== null && typeof tab === 'object' && typeof tab.id === 'string' ? tab.id : undefined;
                if (id === undefined) return;
                // 必须用**和其他命令同一个身份** `<会话 id>::<侧边栏 tab id>`：一个侧边栏 tab 就是一个浏览器
                // 组件实例。以前这里发的是 DSH 的裸 tab id，壳里根本没有这个 key，于是关掉的标签既不销毁
                // 视图也不停页面（原生 WebContentsView 一直留着、继续跑）。
                const closeSession = typeof closeSessionId === 'string' ? closeSessionId : '';
                const viewId = closeSession === '' ? id : `${closeSession}::${id}`;
                void bridge.command({ name: 'close', tabId: viewId, sessionId: closeSession });
              }),
            'dsh-desktop-shell: browser close handler',
          ));
          browserPanelCheck = 'registered';
          // 打开面板的能力：agent 要求显示页面而面板不在屏幕上时由壳调用。
          // `openTabIn` 面向某个会话（面板从未挂载也能开），`openTab` 面向当前挂载的侧栏；两个都试。
          // 打开面板的能力：agent 要求显示页面而面板不在屏幕上时由壳调用。
          //
          // 只用 DSH 的公开语义（源码 `packages/client/ui-sidebar-right`）：
          // - `openTabIn(sessionId, kind)` / `openTab(kind)` → `placeTab` → store 的 `openContent`，
          //   而 `openContent` 的**第一件事就是** `planSetExpanded(state, true)`：**打开即展开**。
          //   不需要我们判断/切换展开状态（当年那套 toggle 猜测正是"打开又立马收起"的根源）；
          // - `multiple: true` 的类型每次 open 都是独立内容（新的 contentId），所以 agent 反复
          //   "显示页面"会造一堆标签；因此**先复用本会话已有的同类 tab**（`tabsIn`），没有才开；
          // - `focus(tabId)` 聚焦已有 tab；`isExpanded()` 是文档化的读法，只在明确 false 时展开。
          paneSidebar = scope.sidebarRight;
          openBrowserPaneTab = (sessionId) => {
            const sidebar = scope.sidebarRight;
            try {
              if (typeof sessionId === 'string' && sessionId !== '' && typeof sidebar.tabsIn === 'function') {
                const existing = sidebar.tabsIn(sessionId).find((tab) => tab !== null && typeof tab === 'object' && tab.kind === BROWSER_TAB_KIND);
                if (existing !== undefined) {
                  if (typeof sidebar.isExpanded === 'function' && sidebar.isExpanded() === false && typeof sidebar.toggleExpanded === 'function') {
                    sidebar.toggleExpanded();
                  }
                  if (typeof sidebar.focus === 'function') sidebar.focus(existing.id);
                  return 'reused';
                }
              }
            } catch (error) {
              console.warn('[dsh-desktop-shell][client] 复用已有浏览器 tab 失败，改为新开', error);
            }
            // 会话定向优先：`openTabIn` 只对**已被采纳 store** 的会话生效——源码注释明确写着
            // "nothing happens for a session whose store was never adopted"，而且**不抛错**。
            // 所以调用之后必须自己核对（`tabsIn`）：否则新会话里会静默什么都不发生
            // （用户实报：「我再新建一个会话，这次侧边栏就没有打开了」）。
            // 核对不上就退到 `openTab`（作用于当前屏幕上的会话）。
            const attempts = [];
            const oursInSession = () => {
              try {
                if (typeof sidebar.tabsIn !== 'function' || typeof sessionId !== 'string' || sessionId === '') return false;
                return sidebar.tabsIn(sessionId).some((tab) => tab !== null && typeof tab === 'object' && tab.kind === BROWSER_TAB_KIND);
              } catch {
                return false;
              }
            };
            if (typeof sessionId === 'string' && sessionId !== '' && typeof sidebar.openTabIn === 'function') {
              attempts.push(() => {
                sidebar.openTabIn(sessionId, BROWSER_TAB_KIND, {});
                if (!oursInSession()) throw new Error('openTabIn 未生效（该会话的 store 尚未被采纳）');
              });
            }
            attempts.push(() => sidebar.openTab(BROWSER_TAB_KIND, {}));
            for (const attempt of attempts) {
              try {
                attempt();
                return 'opened';
              } catch (error) {
                console.warn('[dsh-desktop-shell][client] 打开侧边栏浏览器 tab 失败，尝试下一种方式', error);
              }
            }
            console.warn('[dsh-desktop-shell][client] DSH 未接受打开侧边栏浏览器的请求');
            return 'rejected';
          };
          console.log('[dsh-desktop-shell][client] 侧边栏浏览器 tab 已注册（桌面壳自研视图）');
        });
        return () => {
          cancelled = true;
          openBrowserPaneTab = null;
          paneSidebar = null;
          for (const dispose of disposers) {
            if (typeof dispose !== 'function') continue;
            try {
              dispose();
            } catch (error) {
              console.warn('[dsh-desktop-shell][client] 撤销浏览器注册失败', error);
            }
          }
        };
      } catch (error) {
        browserPanelCheck = 'failed';
        console.warn('[dsh-desktop-shell][client] 侧边栏浏览器注册失败，已跳过', error);
        return () => {};
      }
    }

    const inject = ['slots', 'locale'];

    function apply(ctx) {
      try {
        ctx.effect(
          () => ctx.locale.register(NS, { zh, en }),
          'dsh-desktop-shell: dictionaries',
        );
        const t = ctx.locale.bind(NS);
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'desktop',
              order: 18,
              label: () => t('title'),
              locale: NS,
              inject: () => ({ t }),
            },
            DesktopSection,
          ),
        );
        console.log('[dsh-desktop-shell][client] settings.section 已注册');
        // 侧边栏浏览器：**先注册，再按设置撤销**。
        //
        // 以前是「await 设置成功后才注册」，而那个 await 是一次网络往返：请求挂住时面板永远
        // 不出现（表现为右侧栏白屏，而且没有任何日志）。注册本身很便宜，撤销也是一次 disposer 调用，
        // 所以门控不能压在启动路径上。
        // 会话运行状态：遮罩按 agent 回合显示/撤下的数据源。拿不到就退回兜底，绝不影响其余功能。
        try {
          ctx.inject(['uiSession'], (scope) => {
            const observable = scope === undefined || scope === null ? undefined : scope.uiSession?.sessionStatus;
            if (observable === undefined || observable === null || typeof observable.getSnapshot !== 'function') {
              console.warn('[dsh-desktop-shell][client] uiSession 没有会话状态：遮罩退回「调用结束后短暂保留」');
              return;
            }
            sessionStatusSource = observable;
            console.log('[dsh-desktop-shell][client] 已接入会话运行状态：遮罩按 agent 回合显示');
          });
        } catch (error) {
          console.warn('[dsh-desktop-shell][client] 注入 uiSession 失败，遮罩退回兜底', error);
        }
        const disposeBrowser = registerSidebarBrowser(ctx, t);
        // agent 要求「让用户看到这个页面」但面板不在屏幕上时，壳会请这里把浏览器 tab 打开。
        // 这段**不能**放在 Panel 组件里：用户从没打开过侧边栏时，Panel 根本没挂载。
        try {
          const bridge = browserBridge();
          if (bridge !== undefined && typeof bridge.onOpenPane === 'function') {
            bridge.onOpenPane((request) => {
              try {
                const info = request !== null && typeof request === 'object' ? request : {};
                const sessionId = typeof info.sessionId === 'string' ? info.sessionId : '';
                // 壳只在「用户此前从未让面板显示过」时才允许展开侧栏。已经显示过就只做 reveal，
                // 绝不 toggle —— 否则会把用户展开着的侧栏收起来（那正是「想隐藏却关不掉」的镜像错误）。
                const mayExpand = info.expand === true;
                const tabId = typeof info.tabId === 'string' ? info.tabId : '';
                const report = (text) => {
                  console.log(`[dsh-desktop-shell][client] ${text}`);
                  void bridge.command({ name: 'diag', text });
                };
                /**
                 * 面板此刻是否真的在屏幕上 —— **问壳**，不要查 DOM：keepMounted 让别的会话里
                 * 没显示的面板体也留在文档里，`querySelector` 会给出假阳性（踩过）。
                 */
                const shellSaysVisible = async () => {
                  try {
                    const answer = await bridge.command({ name: 'panelVisible', tabId });
                    return answer !== null && typeof answer === 'object' && answer.visible === true;
                  } catch {
                    return false;
                  }
                };
                /**
                 * 侧栏当前是否**已经展开**。
                 *
                 * `sidebarRight` 只暴露 `toggleExpanded()`（切换），没有 setter，而 DSH 自己的
                 * ExpandButton 用的是内部 `actions.setExpanded(id, true)`。**绝不能**拿「面板不可见」
                 * 去推断「侧栏收起了」：侧栏展开着但选中了别的 pane 时同样不可见，那时 toggle 会把
                 * 用户的侧栏收起来（用户实报：「打开一下立马关闭」「我手动打开又被关一次」）。
                 * 所以先读布局里的 `expanded`，只有明确读到 false 才切换。
                 *
                 * @returns true/false，或 undefined（读不到 → 永不切换）
                 */
                const sidebarExpanded = () => {
                  try {
                    if (paneSidebar === null) return undefined;
                    // DSH 给了公开的读法（`isExpanded()`，收起或没有挂载的 seat 时为 false）。
                    if (typeof paneSidebar.isExpanded === 'function') {
                      const value = paneSidebar.isExpanded();
                      if (typeof value === 'boolean') return value;
                    }
                    // 老版本没有它时退回到布局读取；两者都拿不到就返回 undefined（永不切换）。
                    if (typeof paneSidebar.mountedSurface !== 'function') return undefined;
                    const surface = paneSidebar.mountedSurface();
                    const expanded = surface === null || typeof surface !== 'object' ? undefined : surface.layout?.expanded;
                    return typeof expanded === 'boolean' ? expanded : undefined;
                  } catch {
                    return undefined;
                  }
                };
                const opened = typeof openBrowserPaneTab === 'function' ? openBrowserPaneTab(sessionId) : 'rejected';
                if (opened === 'rejected') {
                  report('DSH 未接受打开侧边栏浏览器的请求（页面留在后台）');
                  return;
                }
                report(
                  `已请求显示侧边栏浏览器（会话 ${sessionId || '未知'}，方式 ${
                    opened === 'reused' ? '复用已有 tab + focus' : 'openTabIn/openTab（自带展开）'
                  }${mayExpand ? '，壳原本请求展开' : ''}）`,
                );
                // 打开动作本身就会展开（store 的 `openContent` 先 `planSetExpanded(true)`），
                // 这里只做一次**事后核对**，不再切换展开状态——toggle 猜测正是"打开又立马收起"的根源。
                window.setTimeout(async () => {
                  try {
                    if (await shellSaysVisible()) {
                      report('面板已显示');
                      return;
                    }
                    // 已知情形：壳给的会话不是侧栏当前挂载的会话。用侧栏自己挂载的会话再 focus 一次
                    // （`tabsIn` / `focus` 都按会话查）。
                    const mountedSession = (() => {
                      try {
                        const store = paneSidebar === null ? undefined : paneSidebar.mounted;
                        const value = store !== undefined && typeof store.getSnapshot === 'function' ? store.getSnapshot() : undefined;
                        return typeof value === 'string' ? value : '';
                      } catch {
                        return '';
                      }
                    })();
                    const effectiveSessionId = sessionId !== '' ? sessionId : mountedSession;
                    const tabs = paneSidebar !== null && typeof paneSidebar.tabsIn === 'function' && effectiveSessionId !== ''
                      ? paneSidebar.tabsIn(effectiveSessionId)
                      : [];
                    const ours = Array.isArray(tabs)
                      ? tabs.find((tab) => tab !== null && typeof tab === 'object' && tab.kind === BROWSER_TAB_KIND)
                      : undefined;
                    if (ours !== undefined && typeof paneSidebar.focus === 'function') {
                      paneSidebar.focus(ours.id);
                      report(`已聚焦侧栏里的浏览器 tab（${String(ours.id)}）`);
                    } else {
                      report('尚未检测到面板（页面继续在后台运行）');
                    }
                  } catch (error) {
                    report(`核对面板显示状态失败：${String(error?.message ?? error)}`);
                  }
                }, 1200);
              } catch (error) {
                console.warn('[dsh-desktop-shell][client] 处理打开面板请求失败', error);
              }
            });
          }
        } catch (error) {
          console.warn('[dsh-desktop-shell][client] 订阅打开面板请求失败', error);
        }
        // 设置门控：只有"浏览器整体关闭"需要撤销注册；浏览器只有**一个**表面（DSH 右侧栏里的
        // 规范 tab 类型），所以这里不再有第二套形态要切换。
        void (async () => {
          try {
            const state = await loadState();
            const browser = state !== null && typeof state === 'object' && state.settings !== null && typeof state.settings === 'object'
              && state.settings.browser !== null && typeof state.settings.browser === 'object'
              ? state.settings.browser
              : undefined;
            if (browser !== undefined && browser.enabled === false) {
              disposeBrowser();
              browserPanelCheck = 'disabled';
              console.log('[dsh-desktop-shell][client] 侧边栏浏览器已在设置中关闭，已撤销注册');
            }
          } catch (error) {
            // 拿不到设置时按默认（开）保留注册；注册本身也带降级。
            console.warn('[dsh-desktop-shell][client] 读取设置失败，按默认启用处理', error);
          }
        })();
      } catch (error) {
        // 绝不外抛：客户端插件抛错会让整个 DSH Web 界面启动失败。
        console.warn('[dsh-desktop-shell][client] 初始化失败，已降级（不影响 DSH 启动）', error);
      }
    }

    return { apply, inject };
  },
});
