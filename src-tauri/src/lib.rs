use serde::{Deserialize, Serialize};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    collections::VecDeque,
    env, fs,
    io::{BufRead, BufReader},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

// CREATE_NO_WINDOW prevents .cmd, node, netstat, and taskkill child processes
// from creating a visible console window in the installed Windows application.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Listener, Manager, PhysicalPosition, RunEvent, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_notification::NotificationExt;
use url::Url;

const LOOPBACK: &str = "127.0.0.1";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const LOG_CAPACITY: usize = 120;
const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_SHOW_ID: &str = "show";
const TRAY_ABOUT_ID: &str = "about";
const TRAY_QUIT_ID: &str = "quit";
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const UPDATE_OVERLAY_LABEL: &str = "update-overlay";
const UPDATE_OVERLAY_WIDTH: f64 = 300.0;
const UPDATE_OVERLAY_HEIGHT: f64 = 76.0;
const UPDATE_OVERLAY_PADDING: f64 = 18.0;
/// Desktop 固定使用的回环端口：避开 DSH 默认的 3080 与本机常见服务端口，
/// 可用环境变量 `DSH_DESKTOP_PORT` 覆盖。端口被占用时直接失败，不退回随机端口。
const DEFAULT_DSH_PORT: u16 = 41729;
const DSH_PORT_ENV: &str = "DSH_DESKTOP_PORT";
/// 桌面壳传给 DSH 子进程的桥目录：桌面设置文件、事实文件、overlay 都在这里。
const BRIDGE_DIR_ENV: &str = "DSH_DESKTOP_BRIDGE_DIR";
const DSH_OVERLAY_FILENAME: &str = "dsh-overlay.yml";
const DSH_FACTS_FILENAME: &str = "desktop-facts.json";
/// 随安装包分发的 DSH 面板插件目录名（位于资源目录下）。
const DSH_PLUGIN_DIR_NAME: &str = "dsh-desktop-shell";
/// 开发时可直接指向插件入口文件，绕过资源目录查找。
const DSH_PLUGIN_PATH_ENV: &str = "DSH_DESKTOP_PLUGIN_PATH";
/// DSH 浏览器会话认证（一次性 token + `dsh-auth` cookie）从该版本开始提供。
/// 低于它的实例会被拒绝启动：桌面端不允许在无认证状态下暴露 Web 服务。
const MINIMUM_DSH_VERSION: &str = "0.1.2-alpha.2";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DshUpdateStatus {
    phase: &'static str,
    message: String,
    current_version: Option<String>,
    latest_version: Option<String>,
    update_tag: Option<String>,
}

impl Default for DshUpdateStatus {
    fn default() -> Self {
        Self {
            phase: "checking",
            message: "正在准备版本检查…".to_string(),
            current_version: None,
            latest_version: None,
            update_tag: None,
        }
    }
}

impl DshUpdateStatus {
    fn checking() -> Self {
        Self {
            phase: "checking",
            message: "正在检查 DSH 版本…".to_string(),
            current_version: None,
            latest_version: None,
            update_tag: None,
        }
    }

    fn up_to_date(current_version: String) -> Self {
        Self {
            phase: "upToDate",
            message: format!("DSH {current_version} 已是最新版本。"),
            current_version: Some(current_version),
            latest_version: None,
            update_tag: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DshWebStatus {
    state: &'static str,
    url: Option<String>,
    message: String,
    logs: Vec<String>,
    update: DshUpdateStatus,
    /// DSH 0.1.2-alpha.2+ 的一次性认证地址（带 token）。
    auth_url: Option<String>,
    /// 前置门禁判定需要升级 DSH；启动页据此提供更新入口。
    requires_dsh_update: bool,
    /// 前置门禁读到的 DSH 版本（「关于」窗口展示）。
    dsh_version: Option<String>,
    /// 本次启动是否成功注入了桌面面板插件（「关于」窗口展示）。
    panel_injected: bool,
}

#[derive(Default)]
struct DshWebService {
    // This is set only for the child started by this desktop application.
    // An externally discovered DSH service deliberately has no Child here.
    child: Option<Child>,
    url: Option<Url>,
    auth_url: Option<Url>,
    origin: ServiceOrigin,
    state: ServiceState,
    generation: u64,
    logs: VecDeque<String>,
    update: DshUpdateStatus,
    /// 前置门禁读到的 DSH 版本，供事实文件与状态展示复用。
    dsh_version: Option<String>,
    /// 本次启动是否成功注入了桌面面板插件。
    panel_injected: bool,
}

#[derive(Default, PartialEq, Eq)]
enum ServiceOrigin {
    #[default]
    None,
    ManagedChild,
}

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum CloseBehavior {
    #[default]
    MinimizeToTray,
    Exit,
}

/// 桌面壳为 DSH 子进程注入的代理配置。
///
/// DSH 只在进程启动时读取一次 `*_proxy` 环境变量，因此修改后需要重启托管的
/// DSH 服务才会生效；这些字段只是“代填环境变量”，不改变 DSH 自身的网络策略。
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
struct ProxySettings {
    enabled: bool,
    /// HTTPS_PROXY：https 请求（`web_fetch` 抓网页走这条）。
    https_proxy: String,
    /// HTTP_PROXY：http 请求；内网端点需要写进 `no_proxy` 例外，否则可能被代理拦走。
    http_proxy: String,
    /// NO_PROXY：额外的直连例外，逗号分隔。
    no_proxy: String,
}

/// 代理地址支持的协议；设置写入与校验现在由 DSH 面板插件负责，这里只服务单元测试。
#[cfg(test)]
const PROXY_SCHEMES: [&str; 4] = ["http", "https", "socks5", "socks5h"];

/// 本壳管理的代理环境变量（大小写两种写法都要处理：DSH 优先读小写）。
const MANAGED_PROXY_ENV: [&str; 6] = [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "NO_PROXY",
    "no_proxy",
];

#[cfg(test)]
fn normalize_proxy_url(raw: &str, label: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    // 允许用户只写 `127.0.0.1:7890`，自动补全协议。
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    let parsed =
        Url::parse(&candidate).map_err(|error| format!("{label}不是有效的代理地址：{error}"))?;
    if !PROXY_SCHEMES.contains(&parsed.scheme()) {
        return Err(format!(
            "{label}只支持 http / https / socks5 / socks5h，当前为 {}。",
            parsed.scheme()
        ));
    }
    if parsed.host_str().is_none() {
        return Err(format!("{label}缺少主机名。"));
    }
    Ok(candidate)
}

impl ProxySettings {
    /// 校验并规范化用户输入：补全协议、去空格、整理例外列表。
    /// P5 起桌面设置统一由 DSH 面板写入（校验也在插件侧），这里保留给单元测试。
    #[cfg(test)]
    fn normalized(&self) -> Result<Self, String> {
        let normalized = Self {
            enabled: self.enabled,
            https_proxy: normalize_proxy_url(&self.https_proxy, "HTTPS 代理地址")?,
            http_proxy: normalize_proxy_url(&self.http_proxy, "HTTP 代理地址")?,
            no_proxy: self
                .no_proxy
                .split(',')
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
                .collect::<Vec<_>>()
                .join(","),
        };
        if normalized.enabled
            && normalized.https_proxy.is_empty()
            && normalized.http_proxy.is_empty()
        {
            return Err("已启用代理，但至少需要填写一个代理地址。".to_string());
        }
        Ok(normalized)
    }

    /// 映射为子进程环境变量；未启用时返回空表（调用方会显式清除这些变量）。
    fn child_env(&self) -> Vec<(&'static str, String)> {
        if !self.enabled {
            return Vec::new();
        }
        let mut envs = Vec::new();
        if !self.https_proxy.is_empty() {
            envs.push(("HTTPS_PROXY", self.https_proxy.clone()));
            envs.push(("https_proxy", self.https_proxy.clone()));
        }
        if !self.http_proxy.is_empty() {
            envs.push(("HTTP_PROXY", self.http_proxy.clone()));
            envs.push(("http_proxy", self.http_proxy.clone()));
        }
        if !self.no_proxy.is_empty() {
            envs.push(("NO_PROXY", self.no_proxy.clone()));
            envs.push(("no_proxy", self.no_proxy.clone()));
        }
        envs
    }

    /// 供日志展示：只暴露实际启用的项。
    fn describe(&self) -> String {
        let mut parts = Vec::new();
        if !self.https_proxy.is_empty() {
            parts.push(format!("HTTPS_PROXY={}", self.https_proxy));
        }
        if !self.http_proxy.is_empty() {
            parts.push(format!("HTTP_PROXY={}", self.http_proxy));
        }
        if !self.no_proxy.is_empty() {
            parts.push(format!("NO_PROXY={}", self.no_proxy));
        }
        parts.join("，")
    }
}

/// 服务相关设置：下次启动使用的回环端口（环境变量优先）。
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceSettings {
    #[serde(default = "default_dsh_port")]
    port: u16,
}

impl Default for ServiceSettings {
    fn default() -> Self {
        Self { port: DEFAULT_DSH_PORT }
    }
}

fn default_dsh_port() -> u16 {
    DEFAULT_DSH_PORT
}

fn default_true() -> bool {
    true
}

/// 启动时的更新检查偏好（DSH 面板可编辑）。
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdatePreferences {
    #[serde(default = "default_true")]
    check_desktop_on_start: bool,
    #[serde(default = "default_true")]
    check_dsh_on_start: bool,
}

impl Default for UpdatePreferences {
    fn default() -> Self {
        Self {
            check_desktop_on_start: true,
            check_dsh_on_start: true,
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellSettings {
    close_behavior: CloseBehavior,
    /// 旧版本设置文件没有该字段，缺失时回落到默认（不启用代理）。
    #[serde(default)]
    proxy: ProxySettings,
    /// 服务端口等；旧文件缺失时回落到默认端口。
    #[serde(default)]
    service: ServiceSettings,
    /// 启动时的更新检查偏好；旧文件缺失时默认开启。
    #[serde(default)]
    updates: UpdatePreferences,
    /// DSH 面板写入时递增的乐观锁版本；桌面壳只读，不参与写入。
    #[serde(default)]
    revision: u64,
    /// 旧文件可能没有版本号（面板首次创建的文件为 0.0.0）。
    #[serde(default)]
    version: String,
}

#[derive(Default)]
struct AppLifecycle {
    explicit_exit_requested: bool,
    close_behavior: CloseBehavior,
    proxy: ProxySettings,
    /// 桌面更新检测只在本会话内收敛一次：窗口显式通知与窗口关闭事件可能同时
    /// 到达，需要去重后再进入 DSH 更新检查。
    desktop_update_resolved: bool,
}

type ManagedLifecycle = Arc<Mutex<AppLifecycle>>;

#[derive(Default)]
enum ServiceState {
    #[default]
    Starting,
    Ready,
    Failed(String),
}

type ManagedService = Arc<Mutex<DshWebService>>;

impl DshWebService {
    fn push_log(&mut self, line: impl Into<String>) {
        if self.logs.len() == LOG_CAPACITY {
            self.logs.pop_front();
        }
        self.logs.push_back(line.into());
    }

    fn status(&mut self) -> DshWebStatus {
        if matches!(self.state, ServiceState::Starting) {
            if let Some(child) = self.child.as_mut() {
                if let Ok(Some(exit_status)) = child.try_wait() {
                    let message = format!("DSH Web 进程意外退出：{exit_status}");
                    self.push_log(&message);
                    self.state = ServiceState::Failed(message);
                }
            }
        }

        let (state, message) = match &self.state {
            ServiceState::Starting => ("starting", "正在启动 DSH Web 服务…".to_string()),
            ServiceState::Ready => ("ready", "DSH Web 服务已就绪。".to_string()),
            ServiceState::Failed(message) => ("failed", message.clone()),
        };

        DshWebStatus {
            state,
            url: self.url.as_ref().map(ToString::to_string),
            message,
            logs: self.logs.iter().cloned().collect(),
            update: self.update.clone(),
            auth_url: self.auth_url.as_ref().map(ToString::to_string),
            requires_dsh_update: self.update.phase == "updateRequired",
            dsh_version: self.dsh_version.clone(),
            panel_injected: self.panel_injected,
        }
    }

    // Only stop the process owned by this desktop instance. A discovered service
    // may belong to a terminal, a different desktop instance, or another user workflow.
    fn stop(&mut self) {
        if let Some(child) = self.child.take() {
            #[cfg(windows)]
            {
                // dsh.cmd/node can create descendants. taskkill /T clears that tree.
                let mut taskkill = Command::new("taskkill");
                taskkill
                    .args(["/PID", &child.id().to_string(), "/T", "/F"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .creation_flags(CREATE_NO_WINDOW);
                let _ = taskkill.status();
            }
            #[cfg(not(windows))]
            {
                let mut child = child;
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        self.url = None;
        self.auth_url = None;
        self.origin = ServiceOrigin::None;
        self.generation = self.generation.wrapping_add(1);
    }
}

/// DSH 页面 localStorage 按 origin（含端口）隔离，随机端口会让每次启动的
/// 存储互相不可见。优先固定使用 3080（DSH 默认端口）保持 origin 稳定；
/// 仅当 3080 被其他程序占用时才退回随机空闲端口。
/// 桌面壳使用的端口，优先级：`DSH_DESKTOP_PORT` 环境变量 > 设置文件 `service.port` > 默认 41729。
fn configured_dsh_port(app: &AppHandle) -> u16 {
    if let Ok(raw) = env::var(DSH_PORT_ENV) {
        if let Ok(port) = raw.trim().parse::<u16>() {
            if port >= 1024 {
                return port;
            }
        }
    }
    load_shell_settings(app)
        .map(|settings| settings.service.port)
        .filter(|port| *port >= 1024)
        .unwrap_or(DEFAULT_DSH_PORT)
}

/// 从 `netstat -ano -p tcp` 输出里找出监听指定回环端口的 PID。
/// 只看 `LISTENING` 行与 127.0.0.1 / [::1] 两类本地地址；抽成纯函数便于单测。
fn listening_pid(netstat_output: &str, port: u16) -> Option<u32> {
    netstat_output.lines().find_map(|line| {
        let columns: Vec<_> = line.split_whitespace().collect();
        if columns.len() < 5
            || !columns[0].eq_ignore_ascii_case("tcp")
            || !columns[3].eq_ignore_ascii_case("listening")
        {
            return None;
        }
        let local = columns[1].trim().to_ascii_lowercase();
        if !(local.starts_with("127.0.0.1:") || local.starts_with("[::1]:")) {
            return None;
        }
        let listening_port: u16 = local.rsplit(':').next()?.parse().ok()?;
        (listening_port == port).then(|| columns[4].parse::<u32>().ok())?
    })
}

/// 占用指定回环端口的监听进程（PID、映像名），只用于失败诊断，绝不用于复用。
fn port_occupant(port: u16) -> Option<(u32, String)> {
    let mut netstat = Command::new("netstat");
    netstat.args(["-ano", "-p", "tcp"]);
    configure_hidden_command(&mut netstat);
    let output = netstat.output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let pid = listening_pid(&text, port)?;

    let mut tasklist = Command::new("tasklist");
    tasklist.args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"]);
    configure_hidden_command(&mut tasklist);
    let name = tasklist
        .output()
        .ok()
        .and_then(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .and_then(|line| line.split(',').next())
                .map(|value| value.trim().trim_matches('"').to_string())
        })
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "未知进程".to_string());
    Some((pid, name))
}

/// 固定端口的可用性检查：不可用直接失败，绝不退回随机端口。
fn require_loopback_port(port: u16) -> Result<(), String> {
    match TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)) {
        Ok(listener) => {
            drop(listener);
            Ok(())
        }
        Err(error) => {
            let detail = match port_occupant(port) {
                Some((pid, name)) => format!("已被 {name}（PID {pid}）占用"),
                None => format!("当前不可绑定（{error}）"),
            };
            Err(format!(
                "固定端口 {port} {detail}。请关闭占用该端口的程序（若是另一个 DSH 实例，请先退出它）；确需换端口时可设置环境变量 {DSH_PORT_ENV}=<端口> 后重试。"
            ))
        }
    }
}

fn dsh_command() -> String {
    env::var("DSH_DESKTOP_DSH_COMMAND").unwrap_or_else(|_| {
        if cfg!(windows) {
            "dsh.cmd".to_string()
        } else {
            "dsh".to_string()
        }
    })
}

fn configure_hidden_command(command: &mut Command) {
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
}

fn run_command_output(command: &mut Command, description: &str) -> Result<String, String> {
    configure_hidden_command(command);
    let output = command
        .output()
        .map_err(|error| format!("无法运行 {description}：{error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            format!("{description} 失败（退出码：{}）。", output.status)
        } else {
            format!("{description} 失败：{detail}")
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn compare_dsh_versions(left: &str, right: &str) -> Option<std::cmp::Ordering> {
    fn split(version: &str) -> Option<([u64; 3], Option<&str>)> {
        let version = version.trim().trim_start_matches('v');
        let (core, prerelease) = version
            .split_once('-')
            .map_or((version, None), |(core, pre)| (core, Some(pre)));
        let mut parts = core.split('.').map(str::parse::<u64>);
        let parsed = [
            parts.next()?.ok()?,
            parts.next()?.ok()?,
            parts.next()?.ok()?,
        ];
        Some((parsed, prerelease))
    }

    let (left_core, left_pre) = split(left)?;
    let (right_core, right_pre) = split(right)?;
    for index in 0..3 {
        match left_core[index].cmp(&right_core[index]) {
            std::cmp::Ordering::Equal => {}
            order => return Some(order),
        }
    }
    match (left_pre, right_pre) {
        (None, None) => Some(std::cmp::Ordering::Equal),
        (None, Some(_)) => Some(std::cmp::Ordering::Greater),
        (Some(_), None) => Some(std::cmp::Ordering::Less),
        (Some(left), Some(right)) => Some(left.cmp(right)),
    }
}

fn installed_dsh_version() -> Result<String, String> {
    let command = dsh_command();
    let mut version = Command::new(&command);
    version.arg("--version");
    let output = run_command_output(&mut version, &format!("`{command} --version`"))?;
    output
        .lines()
        .find_map(|line| {
            let candidate = line.trim().trim_start_matches('v');
            compare_dsh_versions(candidate, "0.0.0")
                .filter(|order| order.is_gt())
                .map(|_| candidate.to_string())
        })
        .ok_or_else(|| format!("无法从 `{command} --version` 的输出中读取版本号。"))
}

fn latest_dsh_release() -> Result<(String, String), String> {
    let npm = if cfg!(windows) { "npm.cmd" } else { "npm" };
    let mut release = Command::new(npm);
    release.args(["view", "@deepseek-ai/dsh", "dist-tags", "--json"]);
    let output = run_command_output(&mut release, "从 npm 查询 DSH 发布版本")?;
    let tags: serde_json::Value = serde_json::from_str(&output)
        .map_err(|error| format!("无法解析 npm 返回的 DSH 发布标签：{error}"))?;
    // 遍历全部 dist-tag，取 semver 最大的版本作为“最新发布”。
    // 发布方可能把更新放到 alpha/beta 等任意 tag（例如 latest 仍停留在旧版
    // 本而 alpha 已发布 0.1.2-alpha.2），只认 next/latest 会漏报更新。
    let mut best: Option<(String, String)> = None;
    if let Some(tag_map) = tags.as_object() {
        for (tag, value) in tag_map {
            let Some(version) = value.as_str() else {
                continue;
            };
            if !compare_dsh_versions(version, "0.0.0").is_some_and(|order| order.is_gt()) {
                continue;
            }
            let is_better = match &best {
                None => true,
                Some((best_version, _)) => {
                    compare_dsh_versions(version, best_version).is_some_and(|order| order.is_gt())
                }
            };
            if is_better {
                best = Some((version.to_string(), tag.clone()));
            }
        }
    }
    best.ok_or_else(|| "npm 未返回有效的 DSH 版本号。".to_string())
}

fn set_update_status(service: &ManagedService, update: DshUpdateStatus) {
    if let Ok(mut instance) = service.lock() {
        instance.update = update;
    }
}

fn check_for_dsh_update(service: &ManagedService) -> Result<bool, String> {
    set_update_status(service, DshUpdateStatus::checking());
    let current_version = installed_dsh_version()?;
    let (latest_version, update_tag) = latest_dsh_release()?;
    let older_than_minimum = compare_dsh_versions(&current_version, MINIMUM_DSH_VERSION)
        .is_some_and(|order| order.is_lt());
    let update_available =
        compare_dsh_versions(&current_version, &latest_version).is_some_and(|order| order.is_lt());

    if older_than_minimum || update_available {
        let message = if older_than_minimum {
            format!(
                "当前 DSH {current_version} 低于最低支持版本 {MINIMUM_DSH_VERSION}；可更新至 {latest_version}。"
            )
        } else {
            format!("发现 DSH 新版本（{update_tag}）：{current_version} → {latest_version}。")
        };
        set_update_status(
            service,
            DshUpdateStatus {
                phase: "updateAvailable",
                message,
                current_version: Some(current_version),
                latest_version: Some(latest_version),
                update_tag: Some(update_tag),
            },
        );
        return Ok(true);
    }

    set_update_status(service, DshUpdateStatus::up_to_date(current_version));
    Ok(false)
}

fn collect_logs<R: std::io::Read + Send + 'static>(
    reader: R,
    service: ManagedService,
    stream: &'static str,
    generation: u64,
) {
    thread::spawn(move || {
        for result in BufReader::new(reader).lines() {
            let line = match result {
                Ok(line) => line,
                Err(error) => format!("读取 {stream} 日志失败：{error}"),
            };
            // 认证地址必须在脱敏之前从**原始**行提取：导航需要真实 token，
            // 而任何可见日志都不得携带它。这里是 0.2.29 导航 401 回归的修复点。
            let auth_url = parse_dsh_web_auth_url(&line);
            if let Ok(mut instance) = service.lock() {
                // 旧进程的残留输出不得污染当前实例的状态与日志。
                if instance.generation != generation {
                    continue;
                }
                if let Some(url) = auth_url {
                    instance.auth_url = Some(url);
                }
                instance.push_log(format!("[{stream}] {}", redact_auth_token(&line)));
            }
        }
    });
}

/// 日志脱敏：DSH 会把一次性认证地址（`?token=…`）打印到 stdout，
/// 该 token 能直接换取浏览器会话 cookie，任何可见日志都不得携带它。
fn redact_auth_token(line: &str) -> String {
    let Some(index) = line.find("token=") else {
        return line.to_string();
    };
    let value_start = index + "token=".len();
    let value_end = line[value_start..]
        .find(|character: char| character.is_whitespace() || character == '&')
        .map(|offset| value_start + offset)
        .unwrap_or(line.len());
    format!("{}token=***{}", &line[..index], &line[value_end..])
}

fn loopback_socket(url: &Url) -> Option<SocketAddr> {
    let host = url.host_str()?;
    let address: IpAddr = host.parse().ok()?;
    if !address.is_loopback() {
        return None;
    }
    Some(SocketAddr::new(address, url.port_or_known_default()?))
}


fn monitor_managed_dsh_web(app: AppHandle, service: ManagedService, generation: u64) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(2));
        let failed = {
            let Ok(mut instance) = service.lock() else {
                return;
            };
            if instance.generation != generation || instance.origin != ServiceOrigin::ManagedChild {
                return;
            }
            let exit_status = instance
                .child
                .as_mut()
                .and_then(|child| child.try_wait().ok().flatten());
            if let Some(exit_status) = exit_status {
                let message = format!("DSH Web 进程意外退出：{exit_status}");
                instance.push_log(&message);
                instance.state = ServiceState::Failed(message);
                true
            } else {
                false
            }
        };
        if failed {
            return_to_launcher_if_viewing_dsh(&app);
            return;
        }
    });
}

/// 启动前置门禁：版本、能力、端口三项全部通过才拉起 DSH；任一不通过都不启动服务，
/// 把原因写进服务状态（启动页据此提示并可引导更新 DSH）。
fn preflight_and_start_dsh_web(app: AppHandle, service: ManagedService) -> Result<(), String> {
    let command = dsh_command();

    // 闸门 1：DSH 必须提供浏览器会话认证，否则本机其它浏览器可直接访问该服务。
    let version = installed_dsh_version()?;
    if let Ok(mut instance) = service.lock() {
        instance.dsh_version = Some(version.clone());
    }
    if compare_dsh_versions(&version, MINIMUM_DSH_VERSION).is_some_and(|order| order.is_lt()) {
        let reason = format!(
            "当前 DSH {version} 低于桌面版要求的最低版本 {MINIMUM_DSH_VERSION}：该版本不提供浏览器会话认证，桌面端拒绝在无认证状态下暴露 Web 服务。请先更新 DSH。"
        );
        record_upgrade_required(&service, &version, &reason);
        return Err(reason);
    }

    // 闸门 2：设置面板经 `--patch` overlay 注入，没有该能力就不启动。
    if !dsh_supports_patch(&command) {
        let reason =
            "当前 DSH 不支持 `--patch` 叠加层，桌面端无法注入设置面板。请更新 DSH 后重试。"
                .to_string();
        record_upgrade_required(&service, &version, &reason);
        return Err(reason);
    }

    // 闸门 3：固定端口必须可用。
    let port = configured_dsh_port(&app);
    require_loopback_port(port)?;
    spawn_dsh_web(app, service, port)
}

/// 记录「需要升级 DSH」状态：启动页据此给出更新入口，并尽力取到最新发布版本。
fn record_upgrade_required(service: &ManagedService, current_version: &str, reason: &str) {
    let latest = latest_dsh_release().ok();
    set_update_status(
        service,
        DshUpdateStatus {
            phase: "updateRequired",
            message: reason.to_string(),
            current_version: Some(current_version.to_string()),
            latest_version: latest.as_ref().map(|(version, _)| version.clone()),
            update_tag: latest.map(|(_, tag)| tag),
        },
    );
}

/// `--patch` 是启动器级选项（`dsh --help` 可见；web app 自己的 help 不列）。
fn dsh_supports_patch(command: &str) -> bool {
    let mut probe = Command::new(command);
    probe.args(["--help"]);
    configure_hidden_command(&mut probe);
    let Ok(output) = probe.output() else {
        return false;
    };
    let help = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    help.contains("--patch")
}

fn app_config_path(app: &AppHandle, file: &str) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(file))
        .map_err(|error| format!("无法确定桌面配置目录：{error}"))
}

/// 随安装包分发的面板插件入口；开发时可用 `DSH_DESKTOP_PLUGIN_PATH` 覆盖。
fn dsh_plugin_entry_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    if let Ok(raw) = env::var(DSH_PLUGIN_PATH_ENV) {
        let path = std::path::PathBuf::from(raw);
        if path.is_file() {
            return Some(path);
        }
    }
    // 与 `tauri.conf.json > bundle.resources` 使用同一套路径语法解析，
    // 避免手工拼接在不同平台/打包器版本上产生偏差。
    let candidate = app
        .path()
        .resolve(
            format!("resources/{DSH_PLUGIN_DIR_NAME}/index.js"),
            tauri::path::BaseDirectory::Resource,
        )
        .ok()?;
    candidate.is_file().then_some(candidate)
}

/// 每次启动重写 overlay：
/// 1) 覆盖 bundle 行 `web-runtime`，强制打印认证地址、不开系统浏览器、不带 LAN trust；
/// 2) 插入随安装包分发的面板插件（资源缺失时只保留第 1 条）。
fn write_dsh_overlay(app: &AppHandle) -> Result<(std::path::PathBuf, bool), String> {
    let mut body = String::from(
        r#"# 由 DSH Desktop 每次启动生成，请勿手工编辑。
- id: web-runtime
  config:
    openBrowser: false
    printUrl: true
    surfaceContext: true
    trustedHosts: []
"#,
    );
    let injected = match dsh_plugin_entry_path(app) {
        Some(entry) => {
            let escaped = entry.to_string_lossy().replace('\'', "''");
            body.push_str(&format!(
                "- insert:
    - id: dsh-desktop-shell
      name: '{escaped}'
"
            ));
            true
        }
        None => false,
    };
    let path = app_config_path(app, DSH_OVERLAY_FILENAME)?;
    let directory = path
        .parent()
        .ok_or_else(|| "无法确定桌面配置目录".to_string())?;
    fs::create_dir_all(directory).map_err(|error| format!("无法创建桌面配置目录：{error}"))?;
    fs::write(&path, body).map_err(|error| format!("无法写入 DSH overlay：{error}"))?;
    Ok((path, injected))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopFacts {
    schema: u32,
    generated_at_unix_ms: u64,
    desktop_version: String,
    settings_path: Option<String>,
    bridge_dir: String,
    panel_injected: bool,
    dsh_url: Option<String>,
    dsh_port: u16,
    dsh_version: Option<String>,
    dsh_managed: bool,
    dsh_browser_auth: bool,
}

/// 写桌面事实文件（只读信息，供插件 host 半与诊断使用）。写入失败不影响启动。
fn write_desktop_facts(
    app: &AppHandle,
    service: &ManagedService,
    port: u16,
    browser_auth: bool,
) {
    let Ok(bridge) = app
        .path()
        .app_config_dir()
        .map(|directory| directory.to_string_lossy().to_string())
    else {
        return;
    };
    let settings_path = shell_settings_path(app)
        .ok()
        .map(|path| path.to_string_lossy().to_string());
    let (url, version) = service
        .lock()
        .map(|instance| {
            (
                instance.url.as_ref().map(ToString::to_string),
                instance.dsh_version.clone(),
            )
        })
        .unwrap_or((None, None));
    let facts = DesktopFacts {
        schema: 1,
        generated_at_unix_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or(0),
        desktop_version: APP_VERSION.to_string(),
        settings_path,
        bridge_dir: bridge,
        panel_injected: dsh_plugin_entry_path(app).is_some(),
        dsh_url: url,
        dsh_port: port,
        dsh_version: version,
        dsh_managed: true,
        dsh_browser_auth: browser_auth,
    };
    if let Ok(path) = app_config_path(app, DSH_FACTS_FILENAME) {
        if let Ok(contents) = serde_json::to_vec_pretty(&facts) {
            let _ = fs::write(path, contents);
        }
    }
}

/// `dsh web` 默认会用系统默认浏览器打开 Web UI。新版 DSH 支持 `--no-open`
/// 关闭该行为；老版本不认识此参数（commander 会报错退出），因此先通过
/// `dsh web --help` 探测，支持才追加。
fn dsh_web_supports_no_open(command: &str) -> bool {
    let mut probe = Command::new(command);
    probe
        .args(["web", "--help"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    probe.creation_flags(CREATE_NO_WINDOW);
    let Ok(output) = probe.output() else {
        return false;
    };
    let help = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    help.contains("--no-open")
}

fn spawn_dsh_web(app: AppHandle, service: ManagedService, port: u16) -> Result<(), String> {
    let url = Url::parse(&format!("http://{LOOPBACK}:{port}"))
        .map_err(|error| format!("无法构造本地 DSH 地址：{error}"))?;
    let command = dsh_command();

    // `dsh web` 默认会在系统默认浏览器打开 Web UI；桌面壳自己承载页面，
    // 必须传 --no-open（老版本 DSH 不认识该参数，先探测再决定）。
    let no_open_supported = dsh_web_supports_no_open(&command);

    // 每次启动重写 overlay：资源路径可能随版本变化；插件本体随安装包分发。
    let (overlay, panel_injected) = write_dsh_overlay(&app)?;

    // 代理设置只作用于由本壳托管的 DSH 子进程。DSH 在启动时读取一次环境变量，
    // 因此设置变更后需要重启服务。
    let proxy = app
        .try_state::<ManagedLifecycle>()
        .and_then(|state| state.lock().ok().map(|lifecycle| lifecycle.proxy.clone()))
        .unwrap_or_default();

    let bridge = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法确定桌面配置目录：{error}"))?;

    let mut dsh_process = Command::new(&command);
    // 启动器选项必须排在 web app 自己的参数之前：commander 的 passThroughOptions
    // 会把 launcher 不认识的选项之后的参数整体透传，--patch 放在 --host 之后会被
    // 当成 web app 的选项并报 `unknown option '--patch'`（P0 实测）。
    let mut args = vec![
        "web".to_string(),
        "--patch".to_string(),
        overlay.to_string_lossy().to_string(),
        "--host".to_string(),
        LOOPBACK.to_string(),
        "--port".to_string(),
        port.to_string(),
    ];
    if no_open_supported {
        args.push("--no-open".to_string());
    }
    dsh_process
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env(BRIDGE_DIR_ENV, &bridge);
    if proxy.enabled {
        for (key, value) in proxy.child_env() {
            dsh_process.env(key, value);
        }
    } else {
        // 明确清除，避免关闭开关后父进程遗留的代理变量仍然悄悄生效。
        for key in MANAGED_PROXY_ENV {
            dsh_process.env_remove(key);
        }
    }
    #[cfg(windows)]
    dsh_process.creation_flags(CREATE_NO_WINDOW);

    let mut child = dsh_process.spawn().map_err(|error| {
        format!(
            "无法运行 `{command}`：{error}。请安装 DSH，或设置 DSH_DESKTOP_DSH_COMMAND 指向 dsh 可执行文件。"
        )
    })?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let generation = {
        let mut instance = service
            .lock()
            .map_err(|_| "DSH 服务状态锁已损坏".to_string())?;
        instance.stop();
        instance.child = Some(child);
        instance.url = Some(url.clone());
        instance.origin = ServiceOrigin::ManagedChild;
        instance.state = ServiceState::Starting;
        instance.panel_injected = panel_injected;
        instance.push_log(format!(
            "启动 `{command} web --patch <overlay> --host {LOOPBACK} --port {port}{}`",
            if no_open_supported { " --no-open" } else { "" }
        ));
        if proxy.enabled {
            instance.push_log(format!("已为 DSH 子进程注入代理：{}", proxy.describe()));
        }
        if !panel_injected {
            instance.push_log(format!(
                "未找到桌面面板插件资源（{DSH_PLUGIN_DIR_NAME}），本次启动不注入面板；开发模式可设置 {DSH_PLUGIN_PATH_ENV} 指向插件入口。"
            ));
        }
        instance.generation
    };

    if let Some(stdout) = stdout {
        collect_logs(stdout, Arc::clone(&service), "stdout", generation);
    }
    if let Some(stderr) = stderr {
        collect_logs(stderr, Arc::clone(&service), "stderr", generation);
    }

    monitor_managed_dsh_web(app.clone(), Arc::clone(&service), generation);
    write_desktop_facts(&app, &service, port, false);

    // 就绪判定只看 DSH 自己打印的一次性认证地址：无认证的实例已被前置门禁拒绝，
    // 因此不再保留匿名探针兜底。
    thread::spawn(move || {
        let deadline = Instant::now() + STARTUP_TIMEOUT;
        while Instant::now() < deadline {
            let (auth_url, bare_url) = {
                let Ok(instance) = service.lock() else {
                    return;
                };
                if instance.generation != generation {
                    return;
                }
                // 只认 collect_logs 从原始行提取并保存的真实认证地址；
                // 不再扫描（已脱敏的）日志。
                (instance.auth_url.clone(), instance.url.clone())
            };
            if let Some(auth_url) = auth_url {
                let Some(bare_url) = bare_url.clone() else {
                    thread::sleep(Duration::from_millis(250));
                    continue;
                };
                {
                    let Ok(mut instance) = service.lock() else {
                        return;
                    };
                    if instance.generation == generation {
                        instance.state = ServiceState::Ready;
                        instance.auth_url = Some(auth_url.clone());
                        instance
                            .push_log("DSH Web 已启动（带一次性认证），正在自动认证并打开页面…");
                    }
                }
                write_desktop_facts(&app, &service, port, true);
                // 认证导航：先访问带 token 的认证地址（浏览器存储 dsh-auth
                // cookie），重定向回裸地址后若启动页与 DSH 跨站（发布版启动页
                // 在 tauri.localhost），`SameSite=Strict` cookie 不会随 303 跳转
                // 发送，需再导航一次裸地址（此时已与页面同站、携带 cookie）。
                // 启动页同在 127.0.0.1（开发版）时同站一次即达，跳过第二步，
                // 避免已加载的 DSH 页面被二次刷新。
                let app_handle = app.clone();
                thread::spawn(move || {
                    thread::sleep(Duration::from_millis(600));
                    let Some(main) = app_handle.get_webview_window(MAIN_WINDOW_LABEL) else {
                        return;
                    };
                    let needs_second_navigation = main
                        .url()
                        .ok()
                        .map_or(true, |launcher_url| loopback_socket(&launcher_url).is_none());
                    let _ = main.navigate(auth_url.clone());
                    if needs_second_navigation {
                        thread::sleep(Duration::from_millis(400));
                        let _ = main.navigate(bare_url.clone());
                    }
                });
                return;
            }
            thread::sleep(Duration::from_millis(250));
        }
        if let Ok(mut instance) = service.lock() {
            if instance.generation == generation && matches!(instance.state, ServiceState::Starting) {
                let message = format!(
                    "等待 DSH Web 认证地址超时（{} 秒）：当前 DSH 可能未启用浏览器会话认证。请更新 DSH 后重试。",
                    STARTUP_TIMEOUT.as_secs()
                );
                instance.push_log(&message);
                instance.state = ServiceState::Failed(message);
            }
        }
    });

    Ok(())
}

/// 从 DSH 启动日志中解析一次性认证地址（`dsh web: http://127.0.0.1:PORT/?token=…`）。
/// 仅接受带 token 查询参数的回环地址。
fn parse_dsh_web_auth_url(line: &str) -> Option<Url> {
    let start = line.find("http://")?;
    let rest = &line[start..];
    let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    let url = Url::parse(&rest[..end]).ok()?;
    if loopback_socket(&url).is_none() {
        return None;
    }
    // 脱敏后的占位 token（`***`）不可用于导航：曾经因为「先脱敏、后解析」
    // 把 `?token=***` 交给 WebView，导致用户停在一个 401 页面。
    let usable = url
        .query_pairs()
        .any(|(key, value)| key == "token" && !value.is_empty() && value != "***");
    usable.then_some(url)
}

fn show_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn overlay_corner_position(app: &AppHandle) -> Option<(f64, f64)> {
    let main_window = app.get_webview_window(MAIN_WINDOW_LABEL)?;
    let size = main_window.inner_size().ok()?;
    let position = main_window.outer_position().ok()?;
    let x = f64::from(position.x + size.width as i32) - UPDATE_OVERLAY_WIDTH - UPDATE_OVERLAY_PADDING;
    let y = f64::from(position.y + size.height as i32) - UPDATE_OVERLAY_HEIGHT - UPDATE_OVERLAY_PADDING;
    Some((x, y))
}

/// 主窗口移动或缩放时重新把更新浮层贴回右下角。
fn position_update_overlay(app: &AppHandle) {
    let Some(window) = app.get_webview_window(UPDATE_OVERLAY_LABEL) else {
        return;
    };
    let Some((x, y)) = overlay_corner_position(app) else {
        return;
    };
    let _ = window.set_position(PhysicalPosition::new(x as i32, y as i32));
}

fn show_update_overlay(app: &AppHandle) {
    if app.get_webview_window(UPDATE_OVERLAY_LABEL).is_some() {
        return;
    }
    let Some(main_window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    // 浮层只在进入 DSH 页面后才创建，此时主窗口已显示，位置真实有效；
    // 计算失败（窗口不可见等）则不弹，避免浮层漂到屏幕左上角。
    let Some((x, y)) = overlay_corner_position(app) else {
        return;
    };
    let Ok(builder) = WebviewWindowBuilder::new(
        app,
        UPDATE_OVERLAY_LABEL,
        WebviewUrl::App("update-overlay.html".into()),
    )
    .title("DSH 更新")
    .inner_size(UPDATE_OVERLAY_WIDTH, UPDATE_OVERLAY_HEIGHT)
    .min_inner_size(UPDATE_OVERLAY_WIDTH, UPDATE_OVERLAY_HEIGHT)
    .max_inner_size(UPDATE_OVERLAY_WIDTH, UPDATE_OVERLAY_HEIGHT)
    .position(x, y)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .transparent(true)
    .shadow(false)
    .data_directory(auxiliary_webview_data_directory(app, UPDATE_OVERLAY_LABEL))
    .parent(&main_window)
    else {
        return;
    };
    let _ = builder.build();
}

#[tauri::command]
fn dismiss_update_overlay(app: AppHandle) {
    if let Some(window) = app.get_webview_window(UPDATE_OVERLAY_LABEL) {
        let _ = window.close();
    }
}

/// 显示 DSH 更新的居中询问弹窗：发现新版本时询问是否更新，更新完成后询问
/// 是否重启。与 show_desktop_update_window 一样，必须在主线程之外调用
/// （否则与 WebView2 环境初始化的消息泵互相等待而死锁）。
fn show_dsh_update_prompt(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(DSH_UPDATE_PROMPT_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(
        app,
        DSH_UPDATE_PROMPT_LABEL,
        WebviewUrl::App("dsh-update-prompt.html".into()),
    )
    .title("DSH 更新")
    .inner_size(460.0, 320.0)
    .min_inner_size(460.0, 320.0)
    .max_inner_size(460.0, 320.0)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .always_on_top(true)
    .center()
    .data_directory(auxiliary_webview_data_directory(app, DSH_UPDATE_PROMPT_LABEL))
    .build();
}

#[tauri::command]
fn dismiss_dsh_update_prompt(app: AppHandle) {
    if let Some(window) = app.get_webview_window(DSH_UPDATE_PROMPT_LABEL) {
        let _ = window.close();
    }
}

const DESKTOP_UPDATE_LABEL: &str = "desktop-update";
const DSH_UPDATE_PROMPT_LABEL: &str = "dsh-update-prompt";

/// 显示 DSH Desktop 软件自身更新的独立对话框窗口。进入 DSH 页面后弹出，
/// 用户选择更新时锁定主窗口并在本窗口中下载、安装。
///
/// 注意：本函数必须在主线程之外的线程运行。Tauri 在同步命令/事件回调的主线程
/// 内联创建 WebView 时会与 WebView2 环境初始化的消息泵互相等待而死锁；
/// 从后台线程创建则通过事件循环代理到主线程，可正常完成。
///
/// `reveal` 控制是否显示已存在的窗口：只有前端确认“发现新版本”时才允许
/// 显示（reveal=true）；启动后的重复调用（如服务抖动导致重新进入 DSH）
/// 不得把正在静默检查的窗口提前弹出来。
fn show_desktop_update_window(app: &AppHandle, reveal: bool) {
    if let Some(window) = app.get_webview_window(DESKTOP_UPDATE_LABEL) {
        if reveal {
            let _ = window.show();
            let _ = window.set_focus();
        }
        return;
    }
    let window = WebviewWindowBuilder::new(
        app,
        DESKTOP_UPDATE_LABEL,
        WebviewUrl::App("desktop-update.html".into()),
    )
    .title("DSH Desktop 更新")
    .inner_size(480.0, 370.0)
    .min_inner_size(480.0, 370.0)
    .max_inner_size(480.0, 370.0)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .always_on_top(true)
    .visible(false)
    .center()
    .data_directory(auxiliary_webview_data_directory(app, DESKTOP_UPDATE_LABEL))
    .build();
    let Ok(window) = window else {
        return;
    };
    // 窗口默认隐藏：检查更新期间完全不打扰用户，只有真正发现新版本时
    // 前端才会调用 reveal_desktop_update 显示本窗口。
    // 窗口关闭（“暂不更新”/检查失败/直接点标题栏 X）时恢复主窗口操作并
    // 继续检查 DSH 更新；安装成功路径会直接重启应用，不受影响。
    let app_handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            if let Some(main) = app_handle.get_webview_window(MAIN_WINDOW_LABEL) {
                let _ = main.set_enabled(true);
            }
            resolve_desktop_update(&app_handle);
        }
    });
}

/// 创建（隐藏的）桌面更新检查窗口；重复调用不会显示窗口。
#[tauri::command]
async fn show_desktop_update(app: AppHandle) {
    // 用户在 DSH 面板关闭了「启动时检查桌面端更新」：跳过桌面检查，直接进入 DSH 更新检查。
    if !startup_update_preferences(&app).check_desktop_on_start {
        resolve_desktop_update(&app);
        return;
    }
    show_desktop_update_window(&app, false);
}

/// 手动检查更新的结果，供设置窗口直接展示。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCheckResult {
    /// `upToDate` | `available` | `failed`
    status: &'static str,
    current_version: String,
    latest_version: Option<String>,
    message: String,
}

/// 设置窗口的「检查更新」按钮：立即查询一次桌面端更新。
///
/// 与启动时的静默检查相互独立——这里只负责查询与反馈，发现新版本时复用既有的
/// 桌面更新窗口完成下载与安装；本命令不触碰 `desktop_update_resolved`，
/// 因此不会打乱「桌面更新 → DSH 更新」的一次性顺序。
#[tauri::command]
async fn check_desktop_update_now(app: AppHandle) -> Result<UpdateCheckResult, String> {
    use tauri_plugin_updater::UpdaterExt;

    let current_version = APP_VERSION.to_string();
    // 与启动时的静默检查保持一致（10 秒）：网络挂起时不要一直转，直接给出失败反馈。
    let updater = app
        .updater_builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| format!("无法初始化更新器：{error}"))?;
    match updater.check().await {
        Ok(Some(update)) => {
            let latest_version = update.version.clone();
            // 复用既有窗口：它在自身检查成功后显示自己并承载下载/安装流程。
            // async 命令运行在工作线程上，满足“不得在主线程内联创建 WebView”的约束。
            show_desktop_update_window(&app, false);
            Ok(UpdateCheckResult {
                status: "available",
                message: format!(
                    "发现新版本 {latest_version}（当前 {current_version}），已打开更新窗口。"
                ),
                current_version,
                latest_version: Some(latest_version),
            })
        }
        Ok(None) => Ok(UpdateCheckResult {
            status: "upToDate",
            message: format!("已是最新版本（{current_version}）。"),
            current_version,
            latest_version: None,
        }),
        // 检查失败不返回 Err：设置窗口需要把失败原因展示在行内，而不是当异常抛出。
        Err(error) => Ok(UpdateCheckResult {
            status: "failed",
            message: format!("检查更新失败：{error}"),
            current_version,
            latest_version: None,
        }),
    }
}

/// 前端发现新版本后调用：显示桌面更新询问窗口。
#[tauri::command]
fn reveal_desktop_update(app: AppHandle) {
    show_desktop_update_window(&app, true);
}

/// 桌面更新窗口通知：没有更新 / 用户选择暂不更新 / 更新失败 → 继续检查 DSH 更新。
#[tauri::command]
fn desktop_update_done(app: AppHandle) {
    resolve_desktop_update(&app);
}

/// 桌面更新下载/安装期间锁定主窗口，禁止操作 DSH 页面。
#[tauri::command]
fn set_main_window_locked(app: AppHandle, locked: bool) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.set_enabled(!locked);
    }
}

/// 桌面更新的结果收敛点：本会话内只触发一次 DSH 更新检查。
fn resolve_desktop_update(app: &AppHandle) {
    let Some(lifecycle) = app.try_state::<ManagedLifecycle>() else {
        return;
    };
    {
        let Ok(mut state) = lifecycle.lock() else {
            return;
        };
        if state.desktop_update_resolved {
            return;
        }
        state.desktop_update_resolved = true;
    }
    if !startup_update_preferences(app).check_dsh_on_start {
        return;
    }
    let Some(service) = app.try_state::<ManagedService>() else {
        return;
    };
    let service = Arc::clone(service.inner());
    let app = app.clone();
    thread::spawn(move || match check_for_dsh_update(&service) {
        // 发现新版本：弹出居中的询问弹窗，由用户决定是否更新。
        Ok(true) => show_dsh_update_prompt(&app),
        Ok(false) => {}
        Err(error) => set_update_status(
            &service,
            DshUpdateStatus {
                phase: "checkFailed",
                message: format!("无法检查 DSH 更新：{error}"),
                current_version: None,
                latest_version: None,
                update_tag: None,
            },
        ),
    });
}

#[tauri::command]
fn restart_desktop_app(app: AppHandle) {
    let _ = app.restart();
}

#[tauri::command]
fn show_launcher(app: AppHandle) {
    show_main_window(&app);
}

fn hide_main_window(window: &WebviewWindow) {
    let _ = window.hide();
}

fn auxiliary_webview_data_directory(app: &AppHandle, label: &str) -> std::path::PathBuf {
    app.path()
        .app_local_data_dir()
        .unwrap_or_else(|_| env::temp_dir().join("dsh-desktop"))
        .join("webview-profiles")
        .join(label)
}

fn show_about_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("about") {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    let _ = WebviewWindowBuilder::new(app, "about", WebviewUrl::App("index.html".into()))
        .title("关于 DSH Desktop")
        // 关于页现在承载「检查更新」入口（原先在设置页），因此按内容加高；
        // 仍是固定尺寸、不可最大化的辅助窗口，超出部分由面板滚动。
        .inner_size(460.0, 470.0)
        .min_inner_size(460.0, 470.0)
        .max_inner_size(460.0, 470.0)
        .resizable(false)
        .maximizable(false)
        .center()
        .data_directory(auxiliary_webview_data_directory(app, "about"))
        .build();
}

fn return_to_launcher_if_viewing_dsh(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    let Ok(current_url) = window.url() else {
        return;
    };
    // The frontend's retry action is only available on the Tauri-owned launcher page.
    // Do not navigate away from an unrelated page unless it is the failed DSH endpoint.
    if loopback_socket(&current_url).is_some() {
        let _ = window.navigate(Url::parse("tauri://localhost/").expect("valid launcher URL"));
    }
}

/// DSH 面板经 Tauri 事件桥发来的动作（`{ "action": "…" }`）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopShellAction {
    action: String,
}

/// 推送给 DSH 面板的状态快照。刻意不含认证地址：token 不进入页面数据。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopPanelState {
    service_state: &'static str,
    service_message: String,
    update_phase: &'static str,
    update_message: String,
    dsh_version: Option<String>,
}

fn desktop_panel_state(service: &ManagedService) -> Option<DesktopPanelState> {
    let mut instance = service.lock().ok()?;
    let status = instance.status();
    Some(DesktopPanelState {
        service_state: status.state,
        service_message: status.message,
        update_phase: status.update.phase,
        update_message: status.update.message,
        dsh_version: instance.dsh_version.clone(),
    })
}

/// 把服务/更新状态推给 DSH 面板（页面用 `event.listen("dsh-desktop-state")` 接收）。
fn push_desktop_state(app: &AppHandle) {
    let Some(service) = app.try_state::<ManagedService>() else {
        return;
    };
    let service = Arc::clone(service.inner());
    let Some(payload) = desktop_panel_state(&service) else {
        return;
    };
    let _ = app.emit_to(MAIN_WINDOW_LABEL, "dsh-desktop-state", payload);
}

/// 重读桌面设置并应用可即时生效的部分（关闭行为）；代理等需要重启 DSH 才生效。
fn reload_shell_settings(app: &AppHandle) {
    let Some(settings) = load_shell_settings(app) else {
        return;
    };
    if let Some(lifecycle) = app.try_state::<ManagedLifecycle>() {
        if let Ok(mut state) = lifecycle.lock() {
            state.close_behavior = settings.close_behavior;
            state.proxy = settings.proxy;
        }
    }
}

/// 启动时的更新检查偏好；设置文件缺失时按默认（都开启）。
fn startup_update_preferences(app: &AppHandle) -> UpdatePreferences {
    load_shell_settings(app)
        .map(|settings| settings.updates)
        .unwrap_or_default()
}

/// 监听 DSH 面板的动作：只接受白名单动作、不接受任何参数，也不新增 Tauri 命令能力
/// （能力文件仍只授予 `core:event:default`）。
fn register_desktop_shell_bridge(app: &AppHandle) {
    let handle = app.clone();
    app.listen("dsh-desktop-shell", move |event| {
        let Ok(action) = serde_json::from_str::<DesktopShellAction>(event.payload()) else {
            return;
        };
        match action.action.as_str() {
            // 面板已写入 shell-settings.json：重读并应用可即时生效的设置。
            "settings-changed" => reload_shell_settings(&handle),
            // 保存并重启 DSH：新环境变量（代理）与端口变更都在重启时生效。
            "restart-dsh" => {
                reload_shell_settings(&handle);
                if let Some(service) = handle.try_state::<ManagedService>() {
                    let service = Arc::clone(service.inner());
                    let app = handle.clone();
                    thread::spawn(move || {
                        if let Err(error) = restart_managed_dsh_web(app.clone(), Arc::clone(&service))
                        {
                            if let Ok(mut instance) = service.lock() {
                                instance.push_log(format!("面板请求重启 DSH 失败：{error}"));
                                instance.state = ServiceState::Failed(error);
                            }
                        }
                        push_desktop_state(&app);
                    });
                }
            }
            // 面板的「检查桌面端更新」：复用既有命令，结果推回面板。
            "check-desktop-update" => {
                let app = handle.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = check_desktop_update_now(app.clone()).await;
                    push_desktop_state(&app);
                });
            }
            "show-about" => show_about_window(&handle),
            "focus-main" => show_main_window(&handle),
            // 白名单之外一律忽略。
            _ => {}
        }
        push_desktop_state(&handle);
    });
}

/// dsh-win-notify 插件经 Tauri 事件桥接的系统通知载荷（`{ title, body, sessionId }`）。
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct DshNotify {
    title: String,
    body: String,
    #[allow(dead_code)] // sessionId 预留：后续可点击通知聚焦对应会话
    session_id: Option<String>,
}

/// 监听 dsh-win-notify 插件从 DSH Web 页面（client 路线）经
/// `window.__TAURI__.event.emit` 发出的事件，并弹出系统通知。
fn register_session_notifications(app: &AppHandle) {
    let handle = app.clone();
    // 通知 appLogoOverride 图标：捆绑进安装包的鲸鱼图标（资源目录）。
    let icon_path = app
        .path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join("whale-original.png"))
        .filter(|path| path.exists());
    app.listen("dsh-notify", move |event| {
        let notify: DshNotify = serde_json::from_str(event.payload()).unwrap_or_else(|_| DshNotify {
            title: "DSH".into(),
            body: event.payload().to_string(),
            session_id: None,
        });
        let title = if notify.title.trim().is_empty() {
            "DSH".to_string()
        } else {
            notify.title
        };
        let mut builder = handle.notification().builder().title(title).body(notify.body);
        if let Some(icon_path) = &icon_path {
            builder = builder.icon(icon_path.to_string_lossy().to_string());
        }
        let _ = builder.show();
    });
}

/// 注册应用自己的 AUMID（`HKCU\Software\Classes\AppUserModelId\<identifier>`），
/// 使 Windows 通知在 toast 头部显示「DSH Desktop」名称与本程序图标，而不是
/// 未注册时的回退身份（如 PowerShell）。对两条路线都生效：壳内原生通知
/// （tauri-plugin-notification 使用 identifier 作为 AppId）与 dsh-win-notify
/// 宿主路线（其 `appId` 配置为同一 identifier 时）。
#[cfg(windows)]
fn register_notification_identity(app: &AppHandle) {
    let aumid = app.config().identifier.clone();
    let exe = env::current_exe()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default();
    // 优先使用捆绑的 PNG 图标（部分系统版本对 exe 作为 IconUri 不解析图标）。
    let icon_uri = app
        .path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join("whale-original.png"))
        .filter(|path| path.exists())
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| exe.clone());
    for (value, data) in [
        ("DisplayName", app.config().product_name.clone().unwrap_or_else(|| "DSH Desktop".into())),
        ("IconUri", icon_uri),
        ("IconUriBackgroundColor", "#1E2A44".to_string()),
    ] {
        let mut reg = Command::new("reg");
        reg.args([
            "add",
            &format!(r"HKCU\Software\Classes\AppUserModelId\{aumid}"),
            "/v",
            value,
            "/d",
            &data,
            "/f",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null());
        configure_hidden_command(&mut reg);
        let _ = reg.status();
    }
}

fn quit_application(app: &AppHandle) {
    if let Some(lifecycle) = app.try_state::<ManagedLifecycle>() {
        if let Ok(mut state) = lifecycle.lock() {
            state.explicit_exit_requested = true;
        }
    }
    app.exit(0);
}

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, TRAY_SHOW_ID, "显示", true, None::<&str>)?;
    let about = MenuItem::with_id(app, TRAY_ABOUT_ID, "关于", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, TRAY_QUIT_ID, "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &about, &quit])?;

    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().cloned().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "application tray icon is missing",
            )
        })?)
        .tooltip("DSH Desktop")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            TRAY_SHOW_ID => show_main_window(app),
            // 托盘事件也在主线程回调；建窗口移到后台线程，避免与 WebView2
            // 环境初始化的消息泵互相等待（见 show_desktop_update_window 注释）。
            TRAY_ABOUT_ID => {
                let app = app.clone();
                thread::spawn(move || show_about_window(&app));
            }
            TRAY_QUIT_ID => quit_application(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn shell_settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("shell-settings.json"))
        .map_err(|error| format!("无法确定桌面设置目录：{error}"))
}

/// 读取桌面设置文件；文件缺失或损坏时按“未配置”处理。
/// 旧版本只写了 `closeBehavior` / `version`，缺失的 `proxy` 由 serde 默认值补齐。
fn load_shell_settings(app: &AppHandle) -> Option<ShellSettings> {
    let path = shell_settings_path(app).ok()?;
    let contents = fs::read_to_string(path).ok()?;
    serde_json::from_str::<ShellSettings>(&contents).ok()
}

/// 停掉托管子进程并把状态置回启动中；调用方随后触发后台启动。
/// `start_dsh_web`、`restart_dsh_web` 与面板的「保存并重启 DSH」共用这段逻辑。
fn prepare_dsh_restart(service: &ManagedService) -> Result<(), String> {
    let mut instance = service
        .lock()
        .map_err(|_| "DSH 服务状态锁已损坏".to_string())?;
    instance.stop();
    instance.state = ServiceState::Starting;
    instance.logs.clear();
    if instance.update.phase == "updateAvailable" || instance.update.phase == "checkFailed" {
        instance.update = DshUpdateStatus {
            phase: "skipped",
            message: "已跳过更新，本次将使用当前安装的 DSH。".to_string(),
            current_version: instance.update.current_version.clone(),
            latest_version: instance.update.latest_version.clone(),
            update_tag: instance.update.update_tag.clone(),
        };
    }
    Ok(())
}

/// 同步重启入口：重置状态后交给后台线程按**当前**设置重新拉起 DSH。
fn restart_managed_dsh_web(app: AppHandle, service: ManagedService) -> Result<(), String> {
    prepare_dsh_restart(&service)?;
    start_dsh_web_in_background(app, service);
    Ok(())
}

#[tauri::command]
async fn show_about(app: AppHandle) {
    show_about_window(&app);
}

#[tauri::command]
fn dsh_status(service: State<'_, ManagedService>) -> Result<DshWebStatus, String> {
    service
        .lock()
        .map(|mut instance| instance.status())
        .map_err(|_| "DSH 服务状态锁已损坏".to_string())
}

fn start_dsh_web_in_background(app: AppHandle, service: ManagedService) {
    thread::spawn(move || {
        if let Err(error) = preflight_and_start_dsh_web(app, Arc::clone(&service)) {
            if let Ok(mut instance) = service.lock() {
                instance.state = ServiceState::Failed(error.clone());
                instance.push_log(error);
            }
        }
    });
}

#[tauri::command]
fn start_dsh_web(app: AppHandle, service: State<'_, ManagedService>) -> Result<(), String> {
    prepare_dsh_restart(service.inner())?;
    start_dsh_web_in_background(app, Arc::clone(service.inner()));
    Ok(())
}

#[tauri::command]
async fn update_dsh_in_background(
    app: AppHandle,
    service: State<'_, ManagedService>,
) -> Result<(), String> {
    let update_tag = {
        let mut instance = service
            .lock()
            .map_err(|_| "DSH 服务状态锁已损坏".to_string())?;
        // `skipped` 表示用户选择“暂不更新，继续启动”或自动跳过；此时仍保留
        // 已知的最新版本与发布标签，允许用户稍后发起后台更新。
        if !matches!(
            instance.update.phase,
            "updateAvailable" | "updateRequired" | "skipped"
        ) {
            return Err("当前没有可安装的 DSH 更新。".to_string());
        }
        let update_tag = instance
            .update
            .update_tag
            .clone()
            .ok_or_else(|| "缺少可用的 DSH 更新版本信息。".to_string())?;
        instance.update = DshUpdateStatus {
            phase: "updating",
            message: "正在后台下载并安装 DSH 更新…".to_string(),
            current_version: instance.update.current_version.clone(),
            latest_version: instance.update.latest_version.clone(),
            update_tag: Some(update_tag.clone()),
        };
        update_tag
    };

    // 关掉居中询问弹窗，变成右下角进度浮层；窗口创建统一放在后台线程
    // （主线程内联创建 WebView 会与 WebView2 消息泵死锁）。
    let service = Arc::clone(service.inner());
    thread::spawn(move || {
        dismiss_dsh_update_prompt(app.clone());
        show_update_overlay(&app);

        let npm = if cfg!(windows) { "npm.cmd" } else { "npm" };
        let mut update = Command::new(npm);
        let package_spec = format!("@deepseek-ai/dsh@{update_tag}");
        update.args(["install", "--global", &package_spec]);
        let result = run_command_output(&mut update, "更新 DSH").and_then(|_| installed_dsh_version());

        set_update_status(
            &service,
            match result {
                Ok(installed_version) => DshUpdateStatus {
                    phase: "updateComplete",
                    message: format!("DSH 已更新至 {installed_version}。重启后将使用新版本。"),
                    current_version: Some(installed_version),
                    latest_version: service
                        .lock()
                        .ok()
                        .and_then(|instance| instance.update.latest_version.clone()),
                    update_tag: Some(update_tag),
                },
                Err(error) => DshUpdateStatus {
                    phase: "updateFailed",
                    message: format!("DSH 更新失败：{error}"),
                    current_version: None,
                    latest_version: None,
                    update_tag: None,
                },
            },
        );

        // 更新完成/失败：收起右下角进度，回到居中弹窗让用户选择重启或查看错误。
        dismiss_update_overlay(app.clone());
        show_dsh_update_prompt(&app);
    });
    Ok(())
}

#[tauri::command]
fn restart_dsh_web(app: AppHandle, service: State<'_, ManagedService>) -> Result<(), String> {
    start_dsh_web(app, service)
}

pub fn run() {
    let service: ManagedService = Arc::new(Mutex::new(DshWebService::default()));
    let service_for_setup = Arc::clone(&service);

    tauri::Builder::default()
        .manage(service)
        .manage(Arc::new(Mutex::new(AppLifecycle::default())) as ManagedLifecycle)
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 系统通知：供 dsh-win-notify 插件（client 路线）经事件桥接到壳后弹出。
        .plugin(tauri_plugin_notification::init())
        // 不恢复窗口可见性：桌面更新等窗口在启动时按需隐藏（visible:false），
        // 若插件把上次的“可见”状态还原回来，检查更新期间就会弹出窗口。
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // A second launch must reuse the first instance and its already-running
            // DSH connection rather than starting another desktop process/service.
            show_main_window(app);
        }))
        .setup(move |app| {
            if let Some(settings) = load_shell_settings(app.handle()) {
                if let Some(lifecycle) = app.handle().try_state::<ManagedLifecycle>() {
                    if let Ok(mut state) = lifecycle.lock() {
                        state.close_behavior = settings.close_behavior;
                        state.proxy = settings.proxy;
                    }
                }
            }
            create_tray(app.handle())?;
            // 打开即先启动 DSH Web 服务；桌面更新与 DSH 更新的检查都推迟到
            // 用户进入 DSH 页面之后（见 desktop_update_done / resolve_desktop_update）。
            start_dsh_web_in_background(app.handle().clone(), Arc::clone(&service_for_setup));
            // 监听 dsh-win-notify 插件的会话完成通知事件（client 路线）。
            register_session_notifications(app.handle());
            // 监听 DSH 设置页「桌面端」面板的动作（client 路线）。
            register_desktop_shell_bridge(app.handle());
            // 注册通知 AUMID：让系统通知显示“DSH Desktop”名称与本程序图标。
            #[cfg(windows)]
            register_notification_identity(app.handle());
            // 右下角更新浮层跟随主窗口移动/缩放。
            if let Some(main_window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                let app_handle = app.handle().clone();
                main_window.on_window_event(move |event| {
                    if matches!(
                        event,
                        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)
                    ) {
                        position_update_overlay(&app_handle);
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            dsh_status,
            start_dsh_web,
            update_dsh_in_background,
            dismiss_update_overlay,
            dismiss_dsh_update_prompt,
            show_desktop_update,
            check_desktop_update_now,
            reveal_desktop_update,
            desktop_update_done,
            set_main_window_locked,
            restart_desktop_app,
            restart_dsh_web,
            show_launcher,
            show_about
        ])
        .build(tauri::generate_context!())
        .expect("error while building DSH Desktop")
        .run(|app_handle, event| match event {
            RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { api, .. },
                ..
            } if label == MAIN_WINDOW_LABEL => {
                let close_behavior = app_handle
                    .try_state::<ManagedLifecycle>()
                    .and_then(|lifecycle| {
                        lifecycle.lock().ok().map(|state| {
                            if state.explicit_exit_requested {
                                CloseBehavior::Exit
                            } else {
                                state.close_behavior
                            }
                        })
                    })
                    .unwrap_or_default();
                if matches!(close_behavior, CloseBehavior::MinimizeToTray) {
                    api.prevent_close();
                    if let Some(window) = app_handle.get_webview_window(MAIN_WINDOW_LABEL) {
                        hide_main_window(&window);
                    }
                }
            }
            RunEvent::Exit | RunEvent::ExitRequested { .. } => {
                if let Some(service) = app_handle.try_state::<ManagedService>() {
                    if let Ok(mut instance) = service.lock() {
                        instance.stop();
                    }
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod proxy_settings_tests {
    use super::*;

    fn settings(enabled: bool, https: &str, http: &str, no_proxy: &str) -> ProxySettings {
        ProxySettings {
            enabled,
            https_proxy: https.to_string(),
            http_proxy: http.to_string(),
            no_proxy: no_proxy.to_string(),
        }
    }

    #[test]
    fn bare_host_port_gets_http_scheme() {
        let normalized = settings(true, "127.0.0.1:7890", "", "")
            .normalized()
            .expect("应接受省略协议的地址");
        assert_eq!(normalized.https_proxy, "http://127.0.0.1:7890");
    }

    #[test]
    fn socks_scheme_is_accepted() {
        let normalized = settings(true, "socks5://127.0.0.1:7891", "", "")
            .normalized()
            .expect("应接受 socks5");
        assert_eq!(normalized.https_proxy, "socks5://127.0.0.1:7891");
    }

    #[test]
    fn unsupported_scheme_is_rejected() {
        let error = settings(true, "ftp://127.0.0.1:21", "", "")
            .normalized()
            .expect_err("ftp 应被拒绝");
        assert!(error.contains("只支持"), "错误信息应说明支持的协议：{error}");
    }

    #[test]
    fn enabled_without_any_address_is_rejected() {
        let error = settings(true, "  ", "", "")
            .normalized()
            .expect_err("启用但没有地址应被拒绝");
        assert!(error.contains("至少需要填写一个代理地址"));
    }

    #[test]
    fn disabled_settings_never_emit_env() {
        let envs = settings(false, "http://127.0.0.1:7890", "", "10.1.20.160").child_env();
        assert!(envs.is_empty(), "未启用时不应注入任何变量");
    }

    #[test]
    fn enabled_settings_emit_both_casings_and_trim_no_proxy() {        let normalized = settings(true, "http://127.0.0.1:7890", "", " 10.1.20.160 , ,*.internal ")
            .normalized()
            .expect("应接受合法输入");
        assert_eq!(normalized.no_proxy, "10.1.20.160,*.internal");

        let envs = normalized.child_env();
        assert!(envs.contains(&("HTTPS_PROXY", "http://127.0.0.1:7890".to_string())));
        assert!(envs.contains(&("https_proxy", "http://127.0.0.1:7890".to_string())));
        assert!(envs.contains(&("NO_PROXY", "10.1.20.160,*.internal".to_string())));
        // 只填了 HTTPS 代理时不应凭空生成 HTTP 代理，否则 http 请求会被意外代理。
        assert!(!envs.iter().any(|(key, _)| *key == "HTTP_PROXY"));
    }

    /// 旧版本设置文件没有 `proxy` 字段，必须仍然能解析（否则老用户升级后设置会丢）。
    #[test]
    fn legacy_settings_file_without_proxy_still_parses() {
        let legacy = r#"{ "closeBehavior": "exit", "version": "0.2.22" }"#;
        let parsed: ShellSettings = serde_json::from_str(legacy).expect("旧设置文件应能解析");
        assert!(matches!(parsed.close_behavior, CloseBehavior::Exit));
        assert!(!parsed.proxy.enabled);
        assert_eq!(parsed.proxy.https_proxy, "");
    }

    /// 前后端字段契约：设置文件必须是前端 `ShellSettings.proxy` 期待的 camelCase 键名。
    #[test]
    fn settings_round_trip_uses_camel_case_proxy_keys() {
        let snapshot = ShellSettings {
            close_behavior: CloseBehavior::MinimizeToTray,
            proxy: settings(true, "http://127.0.0.1:7890", "", "10.1.20.160"),
            service: ServiceSettings::default(),
            updates: UpdatePreferences::default(),
            revision: 0,
            version: APP_VERSION.to_string(),
        };
        let json = serde_json::to_string(&snapshot).expect("应能序列化");
        assert!(json.contains("\"closeBehavior\":\"minimizeToTray\""), "{json}");
        assert!(json.contains("\"enabled\":true"), "{json}");
        assert!(
            json.contains("\"httpsProxy\":\"http://127.0.0.1:7890\""),
            "{json}"
        );
        assert!(json.contains("\"httpProxy\":\"\""), "{json}");
        assert!(json.contains("\"noProxy\":\"10.1.20.160\""), "{json}");
    }
}

#[cfg(test)]
mod dsh_shell_tests {
    use super::*;

    #[test]
    fn auth_token_is_redacted_from_logs() {
        let line = "dsh web: http://127.0.0.1:41729/?token=SECRET-VALUE extra";
        let redacted = redact_auth_token(line);
        assert!(!redacted.contains("SECRET-VALUE"), "{redacted}");
        assert!(redacted.contains("token=***"), "{redacted}");
        assert!(redacted.contains("extra"), "token 之后的正文应保留：{redacted}");
    }

    /// 顺序不变量：认证地址必须从**原始**行解析；脱敏后的行不再产出可用地址。
    /// 回归：0.2.29 因为「先脱敏、后解析」把 `?token=***` 交给 WebView，
    /// 用户停在一个 401 页面。此测试直接跑 collect_logs 的真实管线。
    #[test]
    fn collect_logs_saves_real_auth_url_and_redacts_logs() {
        use std::io::Cursor;

        let service: ManagedService = Arc::new(Mutex::new(DshWebService::default()));
        {
            let mut instance = service.lock().expect("锁可用");
            instance.generation = 7;
            instance.state = ServiceState::Starting;
        }
        let input = "dsh web: http://127.0.0.1:41729/?token=REAL-TOKEN\n第二行\n";
        collect_logs(
            Cursor::new(input.as_bytes().to_vec()),
            Arc::clone(&service),
            "stdout",
            7,
        );

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if service.lock().map(|instance| instance.logs.len()).unwrap_or(0) >= 2 {
                break;
            }
            assert!(Instant::now() < deadline, "collect_logs 未在超时前写入日志");
            thread::sleep(Duration::from_millis(20));
        }

        let instance = service.lock().expect("锁可用");
        let auth_url = instance.auth_url.as_ref().expect("应保存真实认证地址");
        let token = auth_url
            .query_pairs()
            .find(|(key, _)| key == "token")
            .map(|(_, value)| value.to_string());
        assert_eq!(token.as_deref(), Some("REAL-TOKEN"));
        let logs = instance.logs.iter().cloned().collect::<Vec<_>>().join("\n");
        assert!(logs.contains("token=***"), "日志应脱敏：{logs}");
        assert!(!logs.contains("REAL-TOKEN"), "日志不得携带真实 token：{logs}");
    }

    /// 旧进程的残留输出不得污染当前实例。
    #[test]
    fn collect_logs_ignores_stale_generation() {
        use std::io::Cursor;

        let service: ManagedService = Arc::new(Mutex::new(DshWebService::default()));
        {
            let mut instance = service.lock().expect("锁可用");
            instance.generation = 9;
        }
        let input = "dsh web: http://127.0.0.1:41729/?token=STALE\n";
        collect_logs(
            Cursor::new(input.as_bytes().to_vec()),
            Arc::clone(&service),
            "stdout",
            8,
        );
        thread::sleep(Duration::from_millis(300));
        let instance = service.lock().expect("锁可用");
        assert!(instance.auth_url.is_none(), "过期 generation 不得写入");
        assert!(instance.logs.is_empty(), "过期 generation 不得写日志");
    }

    #[test]
    fn auth_url_is_parsed_before_redaction_only() {
        let raw = "dsh web: http://127.0.0.1:41729/?token=SECRET-TOKEN";
        let parsed = parse_dsh_web_auth_url(raw).expect("原始行应产出认证地址");
        let token = parsed
            .query_pairs()
            .find(|(key, _)| key == "token")
            .map(|(_, value)| value.to_string());
        assert_eq!(token.as_deref(), Some("SECRET-TOKEN"));

        let redacted = redact_auth_token(raw);
        assert!(redacted.contains("token=***"), "{redacted}");
        assert!(
            parse_dsh_web_auth_url(&redacted).is_none(),
            "脱敏后的占位 token 绝不能当作可用认证地址"
        );
    }

    #[test]
    fn token_redaction_stops_at_ampersand() {
        let line = "GET /?token=SECRET&foo=1";
        assert_eq!(redact_auth_token(line), "GET /?token=***&foo=1");
    }

    #[test]
    fn lines_without_token_are_untouched() {
        let line = "[stdout] DSH Web 已启动";
        assert_eq!(redact_auth_token(line), line);
    }

    #[test]
    fn fixed_port_default_is_not_the_dsh_default() {
        assert_ne!(DEFAULT_DSH_PORT, 3080, "桌面端必须避开 DSH 默认端口");
    }

    const NETSTAT_SAMPLE: &str = "\n  \
        TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1024\n  \
        TCP    127.0.0.1:3080         0.0.0.0:0              LISTENING       20204\n  \
        TCP    127.0.0.1:41729        0.0.0.0:0              LISTENING       31464\n  \
        TCP    127.0.0.1:41729        127.0.0.1:50565        TIME_WAIT       0\n  \
        TCP    [::1]:41729            [::]:0                 LISTENING       999\n";

    #[test]
    fn port_occupant_finds_only_loopback_listeners() {
        assert_eq!(listening_pid(NETSTAT_SAMPLE, 41729), Some(31464));
        assert_eq!(listening_pid(NETSTAT_SAMPLE, 3080), Some(20204));
        assert_eq!(listening_pid(NETSTAT_SAMPLE, 9999), None);
    }

    #[test]
    fn wildcard_and_time_wait_rows_are_ignored() {
        assert_eq!(listening_pid(NETSTAT_SAMPLE, 135), None, "非回环绑定不算占用");
    }
}
