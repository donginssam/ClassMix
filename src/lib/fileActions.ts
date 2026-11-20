/** 작업 파일(.mix) 새로 만들기·열기·저장·닫기 동작. */
import { open, save } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { fileNameOf } from "@/lib/path";
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
    return false;
  }
}

export async function openWorkFileWithDialog(): Promise<boolean> {
  const path = await open({ title: "반편성 파일 열기", multiple: false, directory: false, filters: MIX_FILTER });
  if (!path) return false;
  return openWorkFilePath(path);
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
