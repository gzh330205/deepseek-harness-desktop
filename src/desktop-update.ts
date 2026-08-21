import "./desktop-update.css";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";

function requiredElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`桌面更新元素缺失：${selector}`);
  return element;
}

const title = requiredElement<HTMLHeadingElement>("#title");
const message = requiredElement<HTMLParagraphElement>("#message");
const progress = requiredElement<HTMLElement>("#progress");
const progressFill = requiredElement<HTMLElement>("#progress-fill");
const status = requiredElement<HTMLParagraphElement>("#status");
const actions = requiredElement<HTMLElement>("#actions");

function clearActions(): void {
  actions.replaceChildren();
  actions.hidden = true;
}

function addButton(label: string, onClick: () => void, secondary = false): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.classList.toggle("secondary", secondary);
  button.addEventListener("click", onClick);
  actions.append(button);
  actions.hidden = false;
  return button;
}

// 结果通知 Rust 并关闭窗口：Rust 继续检查 DSH 更新（有桌面更新的成功路径
// 会直接重启应用，不会走到这里）。本窗口默认隐藏，仅“发现新版本”时显示。
function notifyAndClose(): void {
  const currentWindow = getCurrentWebviewWindow();
  void invoke("desktop_update_done").finally(() => {
    void currentWindow.close().catch(() => {});
  });
}

async function main(): Promise<void> {
  // 检查期间窗口保持隐藏，完全不打扰用户。
  let update: Update | null;
  try {
    update = await check({ timeout: 10_000 });
  } catch {
    // 检查失败（网络/服务器不可用）：静默继续检查 DSH 更新。
    notifyAndClose();
    return;
  }
  if (!update) {
    // 没有新版本：静默关闭窗口并继续检查 DSH 更新。
    notifyAndClose();
    return;
  }

  // 发现新版本：渲染提示后再显示窗口，让用户选择是否更新。
  title.textContent = "发现 DSH Desktop 新版本";
  message.textContent = `当前版本 ${update.currentVersion}，最新版本 ${update.version}。是否立即下载并更新？`;
  addButton("更新", () => {
    void startUpdate(update);
  });
  addButton("暂不更新", notifyAndClose, true);
  void invoke("reveal_desktop_update").catch(() => {});
}

async function startUpdate(update: Update): Promise<void> {
  // 下载/安装期间锁定主窗口：禁止操作 DSH 页面，避免与更新冲突。
  const unlock = (): void => void invoke("set_main_window_locked", { locked: false }).catch(() => {});
  try {
    await invoke("set_main_window_locked", { locked: true });
  } catch {
    // 主窗口不存在等异常不阻塞下载。
  }

  clearActions();
  title.textContent = "正在下载更新…";
  message.textContent = "下载期间已锁定页面，请等待更新完成。";
  progress.hidden = false;
  progressFill.style.width = "0%";

  let downloaded = 0;
  let total: number | undefined;
  const onEvent = (event: DownloadEvent): void => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? undefined;
    } else if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
    }
    const percent =
      total && total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : undefined;
    progressFill.style.width = percent != null ? `${percent}%` : "40%";
    status.textContent = percent != null ? `${percent}%` : "";
    const megabytes = (downloaded / 1024 / 1024).toFixed(1);
    message.textContent =
      percent != null
        ? `正在下载更新… ${megabytes} MB（${percent}%）`
        : `正在下载更新… ${megabytes} MB`;
  };

  try {
    await update.download(onEvent);
    // 下载完成 → 开始安装更新。
    title.textContent = "下载完成，正在安装更新…";
    message.textContent = "安装完成后应用将自动重启并使用新版本。";
    progressFill.style.width = "100%";
    status.textContent = "100%";
    await update.install();
    title.textContent = "更新已完成";
    message.textContent = "DSH Desktop 已更新到最新版本，正在重启…";
    clearActions();
    await invoke("restart_desktop_app");
  } catch (error) {
    unlock();
    progress.hidden = true;
    status.textContent = "";
    title.textContent = "更新失败";
    message.textContent = String(error);
    addButton("关闭", notifyAndClose, true);
  }
}

void main();
