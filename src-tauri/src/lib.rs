use serde::{Deserialize, Serialize};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    collections::{BTreeSet, VecDeque},
    env, fs,
    io::{BufRead, BufReader, Read},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream},
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
    AppHandle, Manager, RunEvent, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use url::Url;

const LOOPBACK: &str = "127.0.0.1";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_millis(350);
const RESPONSE_TIMEOUT: Duration = Duration::from_millis(900);
const LOG_CAPACITY: usize = 120;
const MAX_PROBE_BODY_BYTES: u64 = 64 * 1024;
const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_SHOW_ID: &str = "show";
const TRAY_SETTINGS_ID: &str = "settings";
const TRAY_ABOUT_ID: &str = "about";
const TRAY_QUIT_ID: &str = "quit";
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const UPDATE_OVERLAY_LABEL: &str = "update-overlay";
// The launcher will flag a DSH installation older than this baseline even when
// the registry does not yet offer a newer release.
const MINIMUM_DSH_VERSION: &str = "0.1.0-rc.7";

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
}

#[derive(Default)]
struct DshWebService {
    // This is set only for the child started by this desktop application.
    // An externally discovered DSH service deliberately has no Child here.
    child: Option<Child>,
    url: Option<Url>,
    origin: ServiceOrigin,
    state: ServiceState,
    generation: u64,
    logs: VecDeque<String>,
    update: DshUpdateStatus,
}

#[derive(Default, PartialEq, Eq)]
enum ServiceOrigin {
    #[default]
    None,
    ManagedChild,
    ExistingLocalService,
}

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum CloseBehavior {
    #[default]
    MinimizeToTray,
    Exit,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellSettings {
    close_behavior: CloseBehavior,
    version: String,
}

#[derive(Default)]
struct AppLifecycle {
    explicit_exit_requested: bool,
    close_behavior: CloseBehavior,
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
            ServiceState::Starting => ("starting", "正在寻找或启动本机 DSH Web 服务…".to_string()),
            ServiceState::Ready if self.origin == ServiceOrigin::ExistingLocalService => {
                ("ready", "已连接到本机已运行的 DSH Web 服务。".to_string())
            }
            ServiceState::Ready => ("ready", "DSH Web 服务已就绪。".to_string()),
            ServiceState::Failed(message) => ("failed", message.clone()),
        };

        DshWebStatus {
            state,
            url: self.url.as_ref().map(ToString::to_string),
            message,
            logs: self.logs.iter().cloned().collect(),
            update: self.update.clone(),
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
        self.origin = ServiceOrigin::None;
        self.generation = self.generation.wrapping_add(1);
    }
}

fn reserve_loopback_port() -> Result<u16, String> {
    let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .map_err(|error| format!("无法选择本地监听端口：{error}"))?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("无法读取本地监听端口：{error}"))
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
    let tag = if tags
        .get("next")
        .and_then(serde_json::Value::as_str)
        .is_some()
    {
        "next"
    } else {
        "latest"
    };
    let version = tags
        .get(tag)
        .and_then(serde_json::Value::as_str)
        .filter(|version| compare_dsh_versions(version, "0.0.0").is_some_and(|order| order.is_gt()))
        .map(ToString::to_string)
        .ok_or_else(|| format!("npm 未返回有效的 DSH {tag} 版本号。"))?;
    Ok((version, tag.to_string()))
}

fn set_update_status(service: &ManagedService, update: DshUpdateStatus) {
    if let Ok(mut instance) = service.lock() {
        instance.update = update;
    }
}

fn check_for_dsh_update(service: &ManagedService) -> Result<bool, String> {
    set_update_status(service, DshUpdateStatus::checking());
    let current_version = installed_dsh_version()?;
    // DSH publishes release candidates on `next` before promoting them to npm's
    // `latest` tag. Check `next` first so desktop users are notified promptly.
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
) {
    thread::spawn(move || {
        for result in BufReader::new(reader).lines() {
            let line = match result {
                Ok(line) => line,
                Err(error) => format!("读取 {stream} 日志失败：{error}"),
            };
            if let Ok(mut instance) = service.lock() {
                instance.push_log(format!("[{stream}] {line}"));
            }
        }
    });
}

fn loopback_socket(url: &Url) -> Option<SocketAddr> {
    let host = url.host_str()?;
    let address: IpAddr = host.parse().ok()?;
    if !address.is_loopback() {
        return None;
    }
    Some(SocketAddr::new(address, url.port_or_known_default()?))
}

/// Make a bounded HTTP request and verify markers injected by a genuine DSH web host.
/// A generic 200 response is never enough to reuse a local port.
fn is_dsh_web_endpoint(url: &Url) -> bool {
    let Some(address) = loopback_socket(url) else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT) else {
        return false;
    };

    use std::io::Write;
    let host = url.host_str().unwrap_or(LOOPBACK);
    let request =
        format!("GET / HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nAccept: text/html\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    let _ = stream.set_read_timeout(Some(RESPONSE_TIMEOUT));
    let mut reader = BufReader::new(stream);
    let mut status_line = String::new();
    if reader.read_line(&mut status_line).is_err() || !status_line.contains(" 200 ") {
        return false;
    }

    let mut headers = String::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() {
            return false;
        }
        if line == "\r\n" || line.is_empty() {
            break;
        }
        headers.push_str(&line);
        if headers.len() > 16 * 1024 {
            return false;
        }
    }
    if !headers
        .to_ascii_lowercase()
        .contains("content-type: text/html")
    {
        return false;
    }

    let mut body = Vec::new();
    if reader
        .take(MAX_PROBE_BODY_BYTES)
        .read_to_end(&mut body)
        .is_err()
    {
        return false;
    }
    let body = String::from_utf8_lossy(&body);
    // DSH 0.1.1-rc.1 起注入形式由 `window.__DSH_BOOT__` 变为
    // `globalThis["__DSH_BOOT__"]`，因此按标记名子串匹配以兼容两种格式。
    body.contains("__DSH_BOOT__")
        && body.contains("@deepseek-ai/dsh-client-connection")
        && body.contains("/plugins/")
}

fn port_from_listener_address(address: &str) -> Option<u16> {
    // Windows netstat uses 127.0.0.1:3080, [::1]:3080, and occasionally 0.0.0.0:port.
    // We only accept the explicit loopback forms before probing.
    let normalized = address.trim().to_ascii_lowercase();
    if !(normalized.starts_with("127.0.0.1:") || normalized.starts_with("[::1]:")) {
        return None;
    }
    normalized.rsplit(':').next()?.parse().ok()
}

/// Enumerate local TCP listeners, never network interfaces. Failure is harmless:
/// port 3080 remains a cheap compatibility fallback for the DSH default configuration.
#[cfg(windows)]
fn loopback_listening_ports() -> BTreeSet<u16> {
    let mut ports = BTreeSet::from([3080]);
    let mut netstat = Command::new("netstat");
    netstat
        .args(["-ano", "-p", "tcp"])
        .creation_flags(CREATE_NO_WINDOW);
    let Ok(output) = netstat.output() else {
        return ports;
    };
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        let columns: Vec<_> = line.split_whitespace().collect();
        if columns.len() >= 4
            && columns[0].eq_ignore_ascii_case("tcp")
            && columns[3].eq_ignore_ascii_case("listening")
        {
            if let Some(port) = port_from_listener_address(columns[1]) {
                ports.insert(port);
            }
        }
    }
    ports
}

#[cfg(not(windows))]
fn loopback_listening_ports() -> BTreeSet<u16> {
    // DSH defaults to 3080. Platform-specific listener enumeration can be added
    // with native APIs before packaging for macOS/Linux.
    BTreeSet::from([3080])
}

fn configured_dsh_url() -> Option<Url> {
    let raw = env::var("DSH_DESKTOP_URL").ok()?;
    let url = Url::parse(&raw).ok()?;
    loopback_socket(&url).map(|_| url)
}

fn find_existing_dsh_web() -> Option<Url> {
    // An explicit URL wins, but is still fingerprinted and restricted to loopback.
    if let Some(url) = configured_dsh_url() {
        if is_dsh_web_endpoint(&url) {
            return Some(url);
        }
    }

    for port in loopback_listening_ports() {
        for url in [
            Url::parse(&format!("http://127.0.0.1:{port}")).ok(),
            Url::parse(&format!("http://[::1]:{port}")).ok(),
        ]
        .into_iter()
        .flatten()
        {
            if is_dsh_web_endpoint(&url) {
                return Some(url);
            }
        }
    }
    None
}

fn monitor_external_dsh_web(app: AppHandle, service: ManagedService, url: Url, generation: u64) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(2));
        let healthy = is_dsh_web_endpoint(&url);
        let failed = {
            let Ok(mut instance) = service.lock() else {
                return;
            };
            if instance.generation != generation
                || instance.origin != ServiceOrigin::ExistingLocalService
            {
                return;
            }
            if healthy {
                false
            } else {
                let message = format!("已复用的 DSH Web 服务不可访问：{url}");
                instance.push_log(&message);
                instance.state = ServiceState::Failed(message);
                true
            }
        };
        if failed {
            return_to_launcher_if_viewing_dsh(&app);
            return;
        }
    });
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

fn connect_or_start_dsh_web(app: AppHandle, service: ManagedService) -> Result<(), String> {
    if let Some(url) = find_existing_dsh_web() {
        let generation = {
            let mut instance = service
                .lock()
                .map_err(|_| "DSH 服务状态锁已损坏".to_string())?;
            instance.stop();
            instance.url = Some(url.clone());
            instance.origin = ServiceOrigin::ExistingLocalService;
            instance.state = ServiceState::Ready;
            instance.push_log(format!("复用已验证的本机 DSH Web 服务：{url}"));
            instance.generation
        };
        monitor_external_dsh_web(app, Arc::clone(&service), url, generation);
        return Ok(());
    }
    spawn_dsh_web(app, service)
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

fn spawn_dsh_web(app: AppHandle, service: ManagedService) -> Result<(), String> {
    let port = reserve_loopback_port()?;
    let url = Url::parse(&format!("http://{LOOPBACK}:{port}"))
        .map_err(|error| format!("无法构造本地 DSH 地址：{error}"))?;
    let command = dsh_command();

    // `dsh web` 默认会在系统默认浏览器打开 Web UI；桌面壳自己承载页面，
    // 必须传 --no-open 关闭该行为（老版本 DSH 不认识该参数，先探测再决定）。
    let no_open_supported = dsh_web_supports_no_open(&command);

    let mut dsh_process = Command::new(&command);
    let mut args = vec![
        "web".to_string(),
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
        .stderr(Stdio::piped());
    #[cfg(windows)]
    dsh_process.creation_flags(CREATE_NO_WINDOW);

    let mut child = dsh_process
        .spawn()
        .map_err(|error| {
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
        instance.push_log(format!(
            "未发现可复用的 DSH 服务；启动 `{command} web --host {LOOPBACK} --port {port}{}`",
            if no_open_supported { " --no-open" } else { "" }
        ));
        instance.generation
    };

    if let Some(stdout) = stdout {
        collect_logs(stdout, Arc::clone(&service), "stdout");
    }
    if let Some(stderr) = stderr {
        collect_logs(stderr, Arc::clone(&service), "stderr");
    }

    monitor_managed_dsh_web(app, Arc::clone(&service), generation);

    thread::spawn(move || {
        let deadline = Instant::now() + STARTUP_TIMEOUT;
        while Instant::now() < deadline {
            if is_dsh_web_endpoint(&url) {
                if let Ok(mut instance) = service.lock() {
                    if instance.generation == generation {
                        instance.state = ServiceState::Ready;
                        instance.push_log(format!("DSH Web 已在 {url} 就绪"));
                    }
                }
                return;
            }
            thread::sleep(Duration::from_millis(250));
        }
        if let Ok(mut instance) = service.lock() {
            if instance.generation == generation && matches!(instance.state, ServiceState::Starting)
            {
                let message = format!(
                    "等待 DSH Web 服务就绪超时（{} 秒）。",
                    STARTUP_TIMEOUT.as_secs()
                );
                instance.push_log(&message);
                instance.state = ServiceState::Failed(message);
            }
        }
    });

    Ok(())
}

fn show_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn show_update_overlay(app: &AppHandle) {
    if app.get_webview_window(UPDATE_OVERLAY_LABEL).is_some() {
        return;
    }
    let Some(main_window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    let Ok(size) = main_window.inner_size() else {
        return;
    };
    let Ok(position) = main_window.outer_position() else {
        return;
    };
    let width = 280.0;
    let height = 52.0;
    let padding = 18.0;
    let x = f64::from(position.x + size.width as i32) - width - padding;
    let y = f64::from(position.y + size.height as i32) - height - padding;
    let Ok(builder) = WebviewWindowBuilder::new(
        app,
        UPDATE_OVERLAY_LABEL,
        WebviewUrl::App("update-overlay.html".into()),
    )
    .title("DSH 更新")
    .inner_size(width, height)
    .min_inner_size(width, height)
    .max_inner_size(width, height)
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
    .parent(&main_window) else {
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

#[tauri::command]
fn show_launcher(app: AppHandle) {
    show_main_window(&app);
}

fn hide_main_window(window: &WebviewWindow) {
    let _ = window.hide();
}

fn show_settings_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    let _ = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html".into()))
        .title("DSH Desktop 设置")
        .inner_size(560.0, 330.0)
        .min_inner_size(560.0, 330.0)
        .max_inner_size(560.0, 330.0)
        .resizable(false)
        .maximizable(false)
        .center()
        // The DSH page is later loaded into the main WebView. Give auxiliary
        // windows an independent WebView2 profile so they always retain the
        // local launcher URL and render their own settings view.
        .data_directory(auxiliary_webview_data_directory(app, "settings"))
        .build();
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
        .inner_size(460.0, 330.0)
        .min_inner_size(460.0, 330.0)
        .max_inner_size(460.0, 330.0)
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
    let settings = MenuItem::with_id(app, TRAY_SETTINGS_ID, "设置", true, None::<&str>)?;
    let about = MenuItem::with_id(app, TRAY_ABOUT_ID, "关于", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, TRAY_QUIT_ID, "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &settings, &about, &quit])?;

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
            TRAY_SETTINGS_ID => show_settings_window(app),
            TRAY_ABOUT_ID => show_about_window(app),
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

fn load_close_behavior(app: &AppHandle) -> CloseBehavior {
    let Ok(path) = shell_settings_path(app) else {
        return CloseBehavior::default();
    };
    let Ok(contents) = fs::read_to_string(path) else {
        return CloseBehavior::default();
    };
    serde_json::from_str::<ShellSettings>(&contents)
        .map(|settings| settings.close_behavior)
        .unwrap_or_default()
}

fn save_shell_settings(app: &AppHandle, settings: &ShellSettings) -> Result<(), String> {
    let path = shell_settings_path(app)?;
    let directory = path
        .parent()
        .ok_or_else(|| "无法确定桌面设置目录".to_string())?;
    fs::create_dir_all(directory).map_err(|error| format!("无法创建桌面设置目录：{error}"))?;
    let contents = serde_json::to_vec_pretty(settings)
        .map_err(|error| format!("无法序列化桌面设置：{error}"))?;
    fs::write(path, contents).map_err(|error| format!("无法保存桌面设置：{error}"))
}

#[tauri::command]
fn shell_settings(lifecycle: State<'_, ManagedLifecycle>) -> Result<ShellSettings, String> {
    let close_behavior = lifecycle
        .lock()
        .map(|state| state.close_behavior)
        .map_err(|_| "桌面生命周期状态锁已损坏".to_string())?;
    Ok(ShellSettings {
        close_behavior,
        version: APP_VERSION.to_string(),
    })
}

#[tauri::command]
fn update_close_behavior(
    app: AppHandle,
    close_behavior: CloseBehavior,
    lifecycle: State<'_, ManagedLifecycle>,
) -> Result<ShellSettings, String> {
    {
        let mut state = lifecycle
            .lock()
            .map_err(|_| "桌面生命周期状态锁已损坏".to_string())?;
        state.close_behavior = close_behavior;
    }
    let settings = ShellSettings {
        close_behavior,
        version: APP_VERSION.to_string(),
    };
    save_shell_settings(&app, &settings)?;
    Ok(settings)
}

#[tauri::command]
fn show_shell_settings(app: AppHandle) {
    show_settings_window(&app);
}

#[tauri::command]
fn show_about(app: AppHandle) {
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
        if let Err(error) = connect_or_start_dsh_web(app, Arc::clone(&service)) {
            if let Ok(mut instance) = service.lock() {
                instance.state = ServiceState::Failed(error.clone());
                instance.push_log(error);
            }
        }
    });
}

#[tauri::command]
fn start_dsh_web(app: AppHandle, service: State<'_, ManagedService>) -> Result<(), String> {
    {
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
    }
    start_dsh_web_in_background(app, Arc::clone(service.inner()));
    Ok(())
}

#[tauri::command]
fn update_dsh_in_background(
    app: AppHandle,
    service: State<'_, ManagedService>,
) -> Result<(), String> {
    {
        let mut instance = service
            .lock()
            .map_err(|_| "DSH 服务状态锁已损坏".to_string())?;
        // `skipped` 表示用户选择“暂不更新，继续启动”或自动跳过；此时仍保留
        // 已知的最新版本与发布标签，允许用户稍后从右下角浮层发起后台更新。
        if !matches!(instance.update.phase, "updateAvailable" | "skipped") {
            return Err("当前没有可安装的 DSH 更新。".to_string());
        }
        if instance.update.update_tag.is_none() {
            return Err("缺少可用的 DSH 更新版本信息。".to_string());
        }
        instance.update = DshUpdateStatus {
            phase: "updating",
            message: "正在后台下载并安装 DSH 更新…".to_string(),
            current_version: instance.update.current_version.clone(),
            latest_version: instance.update.latest_version.clone(),
            update_tag: instance.update.update_tag.clone(),
        };
    }

    show_update_overlay(&app);
    let service = Arc::clone(service.inner());
    thread::spawn(move || {
        let update_tag = service
            .lock()
            .ok()
            .and_then(|instance| instance.update.update_tag.clone())
            .unwrap_or_else(|| "latest".to_string());
        let npm = if cfg!(windows) { "npm.cmd" } else { "npm" };
        let mut update = Command::new(npm);
        let package_spec = format!("@deepseek-ai/dsh@{update_tag}");
        update.args(["install", "--global", &package_spec]);
        let result = run_command_output(&mut update, "更新 DSH");
        match result.and_then(|_| installed_dsh_version()) {
            Ok(installed_version) => {
                let latest_version = service
                    .lock()
                    .ok()
                    .and_then(|instance| instance.update.latest_version.clone());
                set_update_status(
                    &service,
                    DshUpdateStatus {
                        phase: "updateComplete",
                        message: format!("DSH 已更新至 {installed_version}，可以启动新版本。"),
                        current_version: Some(installed_version),
                        latest_version,
                        update_tag: Some(update_tag),
                    },
                );
            }
            Err(error) => set_update_status(
                &service,
                DshUpdateStatus {
                    phase: "updateFailed",
                    message: format!("DSH 更新失败：{error}"),
                    current_version: None,
                    latest_version: None,
                    update_tag: None,
                },
            ),
        }
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
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // A second launch must reuse the first instance and its already-running
            // DSH connection rather than starting another desktop process/service.
            show_main_window(app);
        }))
        .setup(move |app| {
            if let Some(lifecycle) = app.handle().try_state::<ManagedLifecycle>() {
                if let Ok(mut state) = lifecycle.lock() {
                    state.close_behavior = load_close_behavior(app.handle());
                }
            }
            create_tray(app.handle())?;
            // Check the installed DSH against npm before starting DSH Web. The
            // launcher remains responsive while this runs in the background.
            let update_service = Arc::clone(&service_for_setup);
            thread::spawn(move || {
                if let Err(error) = check_for_dsh_update(&update_service) {
                    set_update_status(
                        &update_service,
                        DshUpdateStatus {
                            phase: "checkFailed",
                            message: format!("无法检查 DSH 更新：{error}"),
                            current_version: None,
                            latest_version: None,
                            update_tag: None,
                        },
                    );
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            dsh_status,
            start_dsh_web,
            update_dsh_in_background,
            dismiss_update_overlay,
            restart_dsh_web,
            show_launcher,
            shell_settings,
            update_close_behavior,
            show_shell_settings,
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
