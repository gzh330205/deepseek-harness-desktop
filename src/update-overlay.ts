import "./update-overlay.css";
import { invoke } from "@tauri-apps/api/core";

interface DshUpdateStatus {
  phase: string;
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
const progress = requiredElement<HTMLElement>("#progress");

// 本浮层只在 DSH 后台更新（updating）期间由 Rust 显示，纯粹展示右下角的
// 更新进度；更新完成/失败后 Rust 会关闭它并弹出居中的询问弹窗。
function render(update: DshUpdateStatus): void {
  if (update.phase === "updating") {
    message.textContent = "正在后台更新 DSH…";
    spinner.classList.remove("done");
    progress.hidden = false;
    return;
  }
  message.textContent = update.message;
  spinner.classList.add("done");
  progress.hidden = true;
}

async function poll(): Promise<void> {
  try {
    const status = await invoke<DshWebStatus>("dsh_status");
    render(status.update);
    if (status.update.phase !== "updating") {
      // 等待 Rust 关闭本浮层。
      return;
    }
  } catch {
    return;
  }
  window.setTimeout(() => void poll(), 300);
}

void poll();
