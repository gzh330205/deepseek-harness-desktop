import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

interface DshWebStatus {
  state: "starting" | "ready" | "failed";
  url?: string;
  /** DSH 0.1.2-alpha.2+ 的一次性认证地址（带 token）；存在时由 Rust 负责两步导航。 */
  authUrl?: string;
  message: string;
  logs: string[];
  /** 启动前置门禁判定需要升级 DSH：显示「更新 DSH」入口。 */
  requiresDshUpdate?: boolean;
  /** 前置门禁读到的 DSH 版本。 */
  dshVersion?: string;
  /** 本次启动是否成功注入了桌面面板插件。 */
  panelInjected?: boolean;
}

/** 手动检查更新的结果；`failed` 是业务状态而非异常，因此页面内展示原因。 */
interface UpdateCheckResult {
  status: "upToDate" | "available" | "failed";
  currentVersion: string;
  latestVersion?: string;
  message: string;
}

const title = requiredElement<HTMLHeadingElement>("title");
const detail = requiredElement<HTMLParagraphElement>("detail");
const address = requiredElement<HTMLParagraphElement>("address");
const logs = requiredElement<HTMLPreElement>("logs");
const retry = requiredElement<HTMLButtonElement>("retry");
const updateDsh = requiredElement<HTMLButtonElement>("update-dsh");
const aboutPanel = requiredElement<HTMLElement>("about-panel");
const version = requiredElement<HTMLElement>("version");
const aboutDshVersion = requiredElement<HTMLElement>("about-dsh-version");
const aboutDshUrl = requiredElement<HTMLElement>("about-dsh-url");
const aboutPanelState = requiredElement<HTMLElement>("about-panel-state");
const updateCheck = requiredElement<HTMLButtonElement>("update-check");
const updateStatus = requiredElement<HTMLParagraphElement>("update-status");

let navigating = false;

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id} element`);
  return element as T;
}

function windowLabel(): string {
  return getCurrentWebviewWindow().label;
}

function isAuxiliaryWindow(): boolean {
  return windowLabel() === "about";
}

// 启动流程：桌面壳打开时 Rust 已在后台启动 DSH Web 服务，启动页只负责
// 等待服务就绪并导航进入 DSH；桌面更新与 DSH 更新的检查都在进入 DSH 后
// 由 Rust/独立窗口负责，不阻塞这里的启动。
async function start(): Promise<void> {
  await waitForReady();
}

async function restartDsh(): Promise<void> {
  retry.hidden = true;
  logs.hidden = true;
  address.textContent = "";
  await invoke("restart_dsh_web");
  await waitForReady();
}

function render(status: DshWebStatus): void {
  // 「更新 DSH」只在启动前置门禁判定需要升级时出现。
  updateDsh.hidden = true;
  updateDsh.disabled = false;

  if (status.state === "ready" && status.url) {
    title.textContent = "正在打开 DeepSeek Harness";
    detail.textContent = "DSH Web 服务已经就绪。";
    address.textContent = status.url;
    return;
  }

  if (status.state === "failed") {
    title.textContent = "DSH Web 服务未能启动";
    detail.textContent = status.message;
    address.textContent = "请确认 dsh 命令可用（可设置 DSH_DESKTOP_DSH_COMMAND 指定可执行文件）。";
    logs.textContent = status.logs.join("\n") || "未收到服务日志。";
    logs.hidden = false;
    retry.hidden = false;
    updateDsh.hidden = !status.requiresDshUpdate;
    return;
  }

  title.textContent = "正在准备 DeepSeek Harness";
  detail.textContent = status.message;
}

async function openDsh(): Promise<void> {
  const status = await invoke<DshWebStatus>("dsh_status");
  render(status);

  if (status.state === "ready" && status.url && !navigating) {
    navigating = true;
    // 进入 DSH 后立即弹出桌面更新检测窗口（无更新时窗口自动关闭并继续
    // DSH 更新检查）；失败不影响导航。
    try {
      await invoke("show_desktop_update");
    } catch {
      // 忽略：桌面更新窗口打开失败不阻塞进入 DSH。
    }
    if (status.authUrl) {
      // 新版 DSH 带一次性认证：导航由 Rust 负责（先认证地址写入 cookie，
      // 跨站时再导航裸地址，均不会提前触发未认证请求）。
      return;
    }
    window.location.replace(status.url);
  }
}

/**
 * 手动检查桌面端更新。发现新版本时 Rust 会打开既有的更新窗口接管下载与安装，
 * 这里只负责给出「已是最新 / 发现新版本 / 检查失败」的明确反馈。
 */
async function checkDesktopUpdate(): Promise<void> {
  updateCheck.disabled = true;
  updateStatus.textContent = "正在检查更新…";
  try {
    const result = await invoke<UpdateCheckResult>("check_desktop_update_now");
    updateStatus.textContent = result.message;
    updateStatus.dataset.status = result.status;
  } catch (error) {
    updateStatus.dataset.status = "failed";
    updateStatus.textContent = `检查更新失败：${String(error)}`;
  } finally {
    updateCheck.disabled = false;
  }
}

function showPanel(panel: HTMLElement): void {
  aboutPanel.hidden = panel !== aboutPanel;
}

async function loadVersion(): Promise<void> {
  try {
    version.textContent = await getVersion();
  } catch {
    version.textContent = "—";
  }
}

/**
 * 「关于」窗口的运行状态：DSH 版本/地址、桌面面板是否注入。
 * 面板是唯一的设置入口后，这里是用户排查「面板为什么没出现」的地方。
 */
async function refreshAboutStatus(): Promise<void> {
  try {
    const status = await invoke<DshWebStatus>("dsh_status");
    aboutDshVersion.textContent = status.dshVersion ?? "—";
    aboutDshUrl.textContent = status.url ?? "—";
    aboutPanelState.textContent = status.panelInjected
      ? "已注入（DSH 设置 → 桌面端）"
      : "未注入";
    if (status.requiresDshUpdate) {
      aboutPanelState.textContent = "未注入：需要先升级 DSH";
    }
  } catch (error) {
    aboutPanelState.textContent = `无法读取服务状态：${String(error)}`;
  }
}

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    const status = await invoke<DshWebStatus>("dsh_status");
    render(status);
    if (status.state === "ready" && status.url) {
      await openDsh();
      return;
    }
    if (status.state === "failed") return;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 300));
  }
  render({
    state: "failed",
    message: "等待 DSH Web 服务超时（35 秒）。",
    logs: [],
  });
}

requiredElement<HTMLButtonElement>("about-trigger").addEventListener("click", () => {
  if (isAuxiliaryWindow()) return;
  void invoke("show_about");
});

updateCheck.addEventListener("click", () => {
  void checkDesktopUpdate();
});

retry.addEventListener("click", () => {
  void restartDsh().catch((error: unknown) => {
    render({
      state: "failed",
      message: `重启请求失败：${String(error)}`,
      logs: [],
    });
  });
});

// 前置门禁要求升级 DSH：复用既有的后台更新流程（右下角进度浮层 + 更新完成后
// 的居中重启询问），更新完成后由更新弹窗调用 restart_dsh_web 重新走门禁。
updateDsh.addEventListener("click", () => {
  updateDsh.disabled = true;
  address.textContent = "正在后台更新 DSH，完成后会提示重启…";
  void invoke("update_dsh_in_background").catch((error: unknown) => {
    updateDsh.disabled = false;
    address.textContent = `启动 DSH 更新失败：${String(error)}`;
  });
});

if (isAuxiliaryWindow()) {
  document.body.classList.add("auxiliary-window");
  showPanel(aboutPanel);
  void loadVersion();
  void refreshAboutStatus();
} else {
  // The native window starts hidden. Reveal it only after this launcher has
  // painted, so users see the loading view instead of a blank WebView.
  requestAnimationFrame(() => {
    void invoke("show_launcher").catch((error: unknown) => {
      render({
        state: "failed",
        message: `无法显示启动窗口：${String(error)}`,
        logs: [],
      });
    });
  });

  void start().catch((error: unknown) => {
    render({
      state: "failed",
      message: `无法启动 DSH Web 服务：${String(error)}`,
      logs: [],
    });
  });
}
