import "./desktop-update.css";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { check, type DownloadEvent } from "@tauri-apps/plugin-updater";

function requiredElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`桌面更新元素缺失：${selector}`);
  return element;
}

const title = requiredElement<HTMLHeadingElement>("#title");
const message = requiredElement<HTMLParagraphElement>("#message");
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

async function main(): Promise<void> {
  const closeWindow = (): void => void getCurrentWebviewWindow().close();
  const update = await check({ timeout: 10_000 }).catch(() => null);
  if (!update) {
    title.textContent = "当前已是最新版本";
    message.textContent = "没有发现 DSH Desktop 新版本。";
    addButton("关闭", closeWindow, true);
    return;
  }

  title.textContent = "发现 DSH Desktop 新版本";
  message.textContent = `当前版本 ${update.currentVersion}，最新版本 ${update.version}。是否下载并安装更新？`;
  const install = addButton("下载并安装", async () => {
    install.disabled = true;
    clearActions();
    title.textContent = "正在下载更新…";
    let downloaded = 0;
    let total: number | undefined;
    const onEvent = (event: DownloadEvent): void => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? undefined;
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
      }
      const percent =
        total && total > 0 ? `（${Math.round((downloaded / total) * 100)}%）` : "";
      message.textContent = `正在下载更新… ${(downloaded / 1024 / 1024).toFixed(1)} MB${percent}`;
    };
    try {
      await update.downloadAndInstall(onEvent);
      title.textContent = "更新已完成";
      message.textContent = "DSH Desktop 已更新到最新版本，正在重启…";
      clearActions();
      await invoke("restart_desktop_app");
    } catch (error) {
      title.textContent = "更新失败";
      message.textContent = String(error);
      addButton("关闭", closeWindow, true);
    }
  });
  addButton("暂不更新", closeWindow, true);
}

void main();
