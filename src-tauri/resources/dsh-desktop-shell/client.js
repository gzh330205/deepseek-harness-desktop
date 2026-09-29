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
      } catch (error) {
        // 绝不外抛：客户端插件抛错会让整个 DSH Web 界面启动失败。
        console.warn('[dsh-desktop-shell][client] 初始化失败，已降级（不影响 DSH 启动）', error);
      }
    }

    return { apply, inject };
  },
});
