import "./update-overlay.css";
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
  if (!element) throw new Error(`更新浮层元素缺失：${selector}`);
  return element;
}

const message = requiredElement<HTMLElement>("#message");
const spinner = requiredElement<HTMLElement>("#spinner");
const actions = requiredElement<HTMLElement>("#actions");

function render(update: DshUpdateStatus): void {
  // updateAvailable 与 skipped（DSH 已自动启动，Rust 标记为 skipped）都要
  // 展示“发现新版本”提示，用户仍可随时点“后台更新”。
  if (update.phase === "updateAvailable" || update.phase === "skipped") {
    message.textContent = `发现 DSH 新版本（${update.updateTag ?? "next"}）：${update.currentVersion ?? "?"} → ${update.latestVersion ?? "?"}`;
    spinner.classList.remove("done");
    actions.replaceChildren();
    const updateNow = document.createElement("button");
    updateNow.type = "button";
    updateNow.textContent = "后台更新";
    updateNow.addEventListener("click", () => {
      updateNow.disabled = true;
      void invoke("update_dsh_in_background").catch(() => {
        updateNow.disabled = false;
      });
    });
    actions.append(updateNow);
    actions.hidden = false;
    return;
  }

  message.textContent = update.phase === "updating" ? "正在后台更新 DSH…" : update.message;
  spinner.classList.toggle("done", update.phase !== "updating");

  if (update.phase !== "updateComplete" && update.phase !== "updateFailed") {
    actions.hidden = true;
    actions.replaceChildren();
    return;
  }

  actions.replaceChildren();
  if (update.phase === "updateComplete") {
    const restart = document.createElement("button");
    restart.type = "button";
    restart.textContent = "重启";
    restart.addEventListener("click", () => {
      void invoke("restart_dsh_web");
      void invoke("dismiss_update_overlay");
    });
    actions.append(restart);
  }
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.textContent = update.phase === "updateComplete" ? "稍后" : "关闭";
  dismiss.addEventListener("click", () => void invoke("dismiss_update_overlay"));
  actions.append(dismiss);
  actions.hidden = false;

  // 完成/失败后主窗口已有对话框引导，浮层 5 秒后自动关闭，避免一直残留。
  window.setTimeout(() => void invoke("dismiss_update_overlay"), 5000);
}

async function poll(): Promise<void> {
  try {
    const status = await invoke<DshWebStatus>("dsh_status");
    render(status.update);
    if (
      status.update.phase !== "updateAvailable" &&
      status.update.phase !== "updating" &&
      status.update.phase !== "skipped"
    ) {
      return;
    }
  } catch {
    return;
  }
  window.setTimeout(() => void poll(), 300);
}

void poll();
