import "./update-overlay.css";
import { invoke } from "@tauri-apps/api/core";

interface DshUpdateStatus {
  phase: "checking" | "upToDate" | "updateAvailable" | "updating" | "updateComplete" | "updateFailed" | "checkFailed" | "skipped";
  message: string;
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
}

async function poll(): Promise<void> {
  try {
    const status = await invoke<DshWebStatus>("dsh_status");
    render(status.update);
    if (status.update.phase !== "updating") return;
  } catch {
    return;
  }
  window.setTimeout(() => void poll(), 300);
}

void poll();
