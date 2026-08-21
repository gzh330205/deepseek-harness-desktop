import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { check as checkDesktopUpdate } from "@tauri-apps/plugin-updater";

interface DshUpdateStatus {
  phase: "checking" | "upToDate" | "updateAvailable" | "updating" | "updateComplete" | "updateFailed" | "checkFailed" | "skipped";
  message: string;
  currentVersion?: string;
  latestVersion?: string;
  updateTag?: string;
}

interface DshWebStatus {
  state: "starting" | "ready" | "failed";
  url?: string;
  message: string;
  logs: string[];
  update: DshUpdateStatus;
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
const updateIndicator = requiredElement<HTMLElement>("update-indicator");
const updateIndicatorText = requiredElement<HTMLElement>("update-indicator-text");
const updateSpinner = requiredElement<HTMLElement>("update-spinner");
const updateDialog = requiredElement<HTMLElement>("update-dialog");
const updateDialogTitle = requiredElement<HTMLHeadingElement>("update-dialog-title");
const updateDialogMessage = requiredElement<HTMLParagraphElement>("update-dialog-message");
const updateDialogActions = requiredElement<HTMLElement>("update-dialog-actions");

let navigating = false;
let settings: ShellSettings | undefined;
let lastUpdatePhase: DshUpdateStatus["phase"] | undefined;
let activeUpdate: DshUpdateStatus | undefined;
let dshStartRequested = false;
let desktopUpdateCheckStarted = false;

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

async function checkForDesktopUpdate(): Promise<void> {
  if (isAuxiliaryWindow() || desktopUpdateCheckStarted) return;
  desktopUpdateCheckStarted = true;
  try {
    const update = await checkDesktopUpdate({ timeout: 10_000 });
    if (!update) return;
    // 发现桌面壳新版本：由独立的 desktop-update 窗口承载提示与下载安装，
    // 主窗口导航到 DSH 后依然可见可操作。
    void invoke("show_desktop_update");
  } catch {
    // A network or release-metadata failure must never interrupt DSH startup.
  }
}

function renderUpdate(update: DshUpdateStatus): void {
  activeUpdate = update;
  // Settings and About share this launcher document, but update controls belong
  // exclusively to the main DSH window.
  if (isAuxiliaryWindow()) {
    updateIndicator.hidden = true;
    updateDialog.hidden = true;
    return;
  }
  if (update.phase === lastUpdatePhase) return;
  lastUpdatePhase = update.phase;

  const showIndicator = (message: string, complete = false): void => {
    updateIndicatorText.textContent = message;
    updateSpinner.classList.toggle("done", complete);
    updateIndicator.hidden = false;
  };
  const clearActions = (): void => { updateDialogActions.replaceChildren(); };
  const addAction = (label: string, onClick: () => void, secondary = false): void => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.classList.toggle("secondary", secondary);
    button.addEventListener("click", onClick);
    updateDialogActions.append(button);
  };
  const showDialog = (titleText: string, message: string): void => {
    updateDialogTitle.textContent = titleText;
    updateDialogMessage.textContent = message;
    updateDialog.hidden = false;
  };
  const hideDialog = (): void => { updateDialog.hidden = true; };

  switch (update.phase) {
    case "checking":
      updateIndicator.hidden = true;
      break;
    case "upToDate":
    case "skipped":
    case "checkFailed":
      updateIndicator.hidden = true;
      if (!dshStartRequested) void startDsh();
      break;
    case "updateAvailable":
      // 不阻塞启动：自动启动 DSH；“发现新版本”提示由独立的 update-overlay
      // 窗口承载（导航到 DSH 页面后依然可见、可点“后台更新”）。
      updateIndicator.hidden = true;
      if (!dshStartRequested) void startDsh();
      break;
    case "updating":
      showIndicator("正在后台更新 DSH…");
      break;
    case "updateComplete":
      showIndicator("DSH 更新已完成", true);
      clearActions();
      showDialog("DSH 已更新", "更新已完成。DSH 正在以当前版本运行；是否立即重启 DSH Web 以使用新版本？");
      addAction("立即重启", () => {
        hideDialog();
        void restartDsh();
      });
      addAction("继续使用当前版本", () => {
        hideDialog();
        void openDsh();
      }, true);
      break;
    case "updateFailed":
      showIndicator("DSH 更新失败", true);
      clearActions();
      showDialog("DSH 更新失败", update.message);
      addAction("使用当前版本继续启动", () => {
        hideDialog();
        void startDsh();
      });
      break;
  }
}

async function startDsh(): Promise<void> {
  if (dshStartRequested) return;
  dshStartRequested = true;
  await invoke("start_dsh_web");
  await waitForReady();
}

async function restartDsh(): Promise<void> {
  retry.hidden = true;
  logs.hidden = true;
  address.textContent = "";
  dshStartRequested = true;
  await invoke("restart_dsh_web");
  await waitForReady();
}

function render(status: DshWebStatus): void {
  renderUpdate(status.update);
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

async function loadSettings(): Promise<void> {
  settings = await invoke<ShellSettings>("shell_settings");
  closeBehavior.value = settings.closeBehavior;
  version.textContent = settings.version;
}

function showPanel(panel: HTMLElement): void {
  settingsPanel.hidden = panel !== settingsPanel;
  aboutPanel.hidden = panel !== aboutPanel;
}

async function openDsh(): Promise<void> {
  const status = await invoke<DshWebStatus>("dsh_status");
  render(status);

  if (status.state === "ready" && status.url && !navigating) {
    navigating = true;
    window.location.replace(status.url);
  }
}

async function start(): Promise<void> {
  await restartDsh();
}

async function waitForUpdateCheck(): Promise<void> {
  while (true) {
    const status = await invoke<DshWebStatus>("dsh_status");
    render(status);
    if (status.update.phase !== "checking") return;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 300));
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
    update: activeUpdate ?? {
      phase: "skipped",
      message: "DSH 更新状态不变。",
    },
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
  void start().catch((error: unknown) => {
    render({
      state: "failed",
      message: `重启请求失败：${String(error)}`,
      logs: [],
      update: activeUpdate ?? {
        phase: "skipped",
        message: "DSH 更新状态不变。",
      },
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
        update: activeUpdate ?? {
          phase: "skipped",
          message: "DSH 更新状态不变。",
        },
      });
    });
  });

  void checkForDesktopUpdate();
  void waitForUpdateCheck().catch((error: unknown) => {
    render({
      state: "failed",
      message: `无法读取 DSH 更新状态：${String(error)}`,
      logs: [],
      update: {
        phase: "checkFailed",
        message: "无法检查 DSH 更新。",
      },
    });
    void startDsh();
  });
}
