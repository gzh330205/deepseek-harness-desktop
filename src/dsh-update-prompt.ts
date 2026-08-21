import "./dsh-update-prompt.css";
import { invoke } from "@tauri-apps/api/core";

interface DshUpdateStatus {
  phase: "checking" | "upToDate" | "updateAvailable" | "updating" | "updateComplete" | "updateFailed" | "checkFailed" | "skipped";
  message: string;
  currentVersion?: string;
  latestVersion?: string;
  updateTag?: string;
}

interface DshWebStatus {
  update: DshUpdateStatus;
}

function requiredElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`DSH 更新弹窗元素缺失：${selector}`);
  return element;
}

const title = requiredElement<HTMLHeadingElement>("#title");
const message = requiredElement<HTMLParagraphElement>("#message");
const actions = requiredElement<HTMLElement>("#actions");

function addButton(
  label: string,
  onClick: () => void,
  secondary = false,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.classList.toggle("secondary", secondary);
  button.addEventListener("click", onClick);
  actions.append(button);
  actions.hidden = false;
  return button;
}

function render(update: DshUpdateStatus): void {
  // 发现新版本（skipped 为服务重启时的自动跳过标记，同样保留询问）：
  // 居中弹窗询问是否立即更新；更新时的右下角进度浮层由 Rust 负责。
  if (update.phase === "updateAvailable" || update.phase === "skipped") {
    title.textContent = "发现 DSH 新版本";
    message.textContent = `当前版本 ${update.currentVersion ?? "?"}，最新版本 ${update.latestVersion ?? "?"}。是否立即更新？`;
    actions.replaceChildren();
    const updateNow = addButton("更新", () => {
      updateNow.disabled = true;
      void invoke("update_dsh_in_background").catch(() => {
        updateNow.disabled = false;
      });
    });
    addButton("暂不更新", () => void invoke("dismiss_dsh_update_prompt"), true);
    return;
  }

  if (update.phase === "updateComplete") {
    // 更新完成：居中弹窗询问「现在重启还是稍后重启」，重启后即使用新版本。
    title.textContent = "DSH 已更新";
    message.textContent = `${update.message} 现在重启还是稍后重启？`;
    actions.replaceChildren();
    addButton("立即重启", () => {
      void invoke("restart_dsh_web");
      void invoke("dismiss_dsh_update_prompt");
    });
    addButton("稍后重启", () => void invoke("dismiss_dsh_update_prompt"), true);
    return;
  }

  if (update.phase === "updateFailed") {
    title.textContent = "DSH 更新失败";
    message.textContent = update.message;
    actions.replaceChildren();
    addButton("关闭", () => void invoke("dismiss_dsh_update_prompt"), false);
    return;
  }

  // 其它阶段（checking/upToDate/updating/checkFailed）不由本弹窗展示。
  actions.replaceChildren();
  actions.hidden = true;
}

async function poll(): Promise<void> {
  try {
    const status = await invoke<DshWebStatus>("dsh_status");
    render(status.update);
  } catch {
    return;
  }
  window.setTimeout(() => void poll(), 300);
}

void poll();
