/** 작업 파일(.mix) 새로 만들기·열기·저장·닫기 동작. */
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { fileNameOf } from "@/lib/path";
import { useBoardUi } from "@/features/board/uiStore";
import { useWorkspace } from "@/store/workspace";

const MIX_FILTER = [{ name: "ClassMix 작업 파일", extensions: ["mix"] }];

function defaultFileName() {
  const year = new Date().getFullYear();
  return `${year}_반편성.mix`;
}

export async function createWorkFileWithDialog(): Promise<boolean> {
  const path = await save({ title: "새 반편성 파일 만들기", defaultPath: defaultFileName(), filters: MIX_FILTER });
  if (!path) return false;
  try {
    const ws = await api.createWorkFile(path);
    await useWorkspace.getState().setWorkspace(ws);
    toast.success(`${ws.fileName} 파일을 만들었습니다.`);
    return true;
  } catch (e) {
    toast.error("파일을 만들지 못했습니다.", { description: errorMessage(e) });
    return false;
  }
}

export async function openWorkFilePath(path: string): Promise<boolean> {
  try {
    const res = await api.openWorkFile(path);
    await useWorkspace.getState().setWorkspace(res.workspace);
    for (const w of res.warnings) toast.warning(w, { duration: 10000 });
    return true;
  } catch (e) {
    toast.error("파일을 열지 못했습니다.", { description: errorMessage(e) });
    // 열기에 실패하면 지금 파일은 그대로 열려 있다. 화면을 Rust 상태와 맞춘다.
    await useWorkspace
      .getState()
      .refresh()
      .catch(() => undefined);
    return false;
  }
}

function samePath(a: string, b: string) {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\/\/\?\//, "");
  // Windows 경로는 대소문자를 구분하지 않는다.
  return /^[a-z]:/i.test(a) ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

/**
 * 탐색기 더블클릭·끌어다 놓기·두 번째 실행으로 들어온 열기 요청.
 * 다른 파일이 열려 있으면 닫고 열지 먼저 묻는다(변경 내용은 이미 자동 저장되어 있음).
 */
export async function openRequestedFile(path: string, opts: { confirm?: boolean } = {}): Promise<boolean> {
  const { confirm = true } = opts;
  const current = useWorkspace.getState().workspace;
  if (current && samePath(current.path, path)) {
    toast.info(`${current.fileName} 파일이 이미 열려 있습니다.`);
    return false;
  }
  if (current) {
    const ok =
      !confirm ||
      (await ask(
        `지금 열린 ${current.fileName} 파일을 닫고 ${fileNameOf(path)} 파일을 열까요?\n지금 파일의 변경 내용은 이미 저장되어 있습니다.`,
        { title: "다른 파일 열기", kind: "info", okLabel: "닫고 열기", cancelLabel: "취소" },
      ).catch(() => false));
    if (!ok) return false;
    // 보드에 남은 선택·대화상자를 지운다(새 파일에는 없는 학생 id일 수 있음).
    const ui = useBoardUi.getState();
    ui.closeDialog();
    ui.clearSelection();
    ui.setHighlight([]);
  }
  return openWorkFilePath(path);
}

export async function openWorkFileWithDialog(): Promise<boolean> {
  const path = await open({ title: "반편성 파일 열기", multiple: false, directory: false, filters: MIX_FILTER });
  if (!path) return false;
  // 직접 고른 파일이므로 다시 묻지 않는다(지금 파일은 자동 저장되어 있음).
  return openRequestedFile(path, { confirm: false });
}

export async function saveWorkFileAsWithDialog(): Promise<void> {
  const ws = useWorkspace.getState().workspace;
  const path = await save({
    title: "다른 이름으로 저장",
    defaultPath: ws ? ws.fileName.replace(/\.mix$/i, "_사본.mix") : defaultFileName(),
    filters: MIX_FILTER,
  });
  if (!path) return;
  try {
    const next = await api.saveWorkFileAs(path);
    await useWorkspace.getState().setWorkspace(next);
    toast.success("다른 이름으로 저장했습니다.", {
      description: `${fileNameOf(next.path)}\n이제 이 파일에서 작업합니다.`,
    });
  } catch (e) {
    toast.error("저장하지 못했습니다.", { description: errorMessage(e) });
  }
}

export async function saveWorkFileCopyWithDialog(): Promise<void> {
  const ws = useWorkspace.getState().workspace;
  const stamp = new Date()
    .toISOString()
    .slice(0, 16)
    .replace(/[-:T]/g, "")
    .replace(/^(\d{8})/, "$1-");
  const path = await save({
    title: "사본 저장(백업)",
    defaultPath: ws ? ws.fileName.replace(/\.mix$/i, `_백업_${stamp}.mix`) : defaultFileName(),
    filters: MIX_FILTER,
  });
  if (!path) return;
  try {
    const saved = await api.saveWorkFileCopy(path);
    toast.success("사본을 저장했습니다.", {
      description: `${fileNameOf(saved)}\n지금 파일에서 계속 작업합니다.`,
    });
  } catch (e) {
    toast.error("사본을 저장하지 못했습니다.", { description: errorMessage(e) });
  }
}

export async function closeWorkFile(): Promise<void> {
  try {
    await api.closeWorkFile();
  } finally {
    await useWorkspace.getState().setWorkspace(null);
  }
}
