import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

interface DshWebStatus {
  state: "starting" | "ready" | "failed";
  url?: string;
  /** DSH 0.1.2-alpha.2+ 的一次性认证地址（带 token）；存在时由 Rust 负责两步导航。 */
  authUrl?: string;
  message: string;
  logs: string[];
}

interface ShellSettings {
  closeBehavior: "minimizeToTray" | "exit";
  version: string;
}

const title = requiredElement<HTMLHeadingElement>("title");
const detail = requiredElement<HTMLParagraphElement>("detail");
const address = requiredElement<HTMLParagraphElement>("address");
const logs = requiredElement<HTMLPreElement>("logs");
const retry = requiredElement<HTMLButtonElement>("retry");
const settingsPanel = requiredElement<HTMLElement>("settings-panel");
const aboutPanel = requiredElement<HTMLElement>("about-panel");
const closeBehavior = requiredElement<HTMLSelectElement>("close-behavior");
const settingsStatus = requiredElement<HTMLParagraphElement>("settings-status");
const version = requiredElement<HTMLElement>("version");

let navigating = false;
let settings: ShellSettings | undefined;

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id} element`);
  return element as T;
}

function windowLabel(): string {
  return getCurrentWebviewWindow().label;
}

function isAuxiliaryWindow(): boolean {
  return windowLabel() === "about" || windowLabel() === "settings";
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
  if (status.state === "ready" && status.url) {
    title.textContent = "正在打开 DeepSeek Harness";
    detail.textContent = "DSH Web 服务已经就绪。";
    address.textContent = status.url;
    return;
  }

  if (status.state === "failed") {
    title.textContent = "DSH Web 服务未能启动";
    detail.textContent = status.message;
    address.textContent = "请确认 dsh 命令可用，或在设置中配置 DSH_DESKTOP_DSH_COMMAND。";
    logs.textContent = status.logs.join("\n") || "未收到服务日志。";
    logs.hidden = false;
    retry.hidden = false;
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

async function loadSettings(): Promise<void> {
  settings = await invoke<ShellSettings>("shell_settings");
  closeBehavior.value = settings.closeBehavior;
  version.textContent = settings.version;
}

function showPanel(panel: HTMLElement): void {
  settingsPanel.hidden = panel !== settingsPanel;
  aboutPanel.hidden = panel !== aboutPanel;
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

requiredElement<HTMLButtonElement>("settings-trigger").addEventListener("click", () => {
  if (isAuxiliaryWindow()) return;
  void invoke("show_shell_settings");
});
requiredElement<HTMLButtonElement>("about-trigger").addEventListener("click", () => {
  if (isAuxiliaryWindow()) return;
  void invoke("show_about");
});

closeBehavior.addEventListener("change", () => {
  const nextBehavior = closeBehavior.value as ShellSettings["closeBehavior"];
  settingsStatus.textContent = "正在保存…";
  void invoke<ShellSettings>("update_close_behavior", { closeBehavior: nextBehavior })
    .then((updated) => {
      settings = updated;
      settingsStatus.textContent = "已保存。";
    })
    .catch((error: unknown) => {
      closeBehavior.value = settings?.closeBehavior ?? "minimizeToTray";
      settingsStatus.textContent = `保存失败：${String(error)}`;
    });
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

void loadSettings().catch((error: unknown) => {
  settingsStatus.textContent = `无法读取桌面设置：${String(error)}`;
});

if (isAuxiliaryWindow()) {
  document.body.classList.add("auxiliary-window");
}

if (windowLabel() === "about") {
  showPanel(aboutPanel);
} else if (windowLabel() === "settings") {
  showPanel(settingsPanel);
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
