/** 경로에서 파일 이름만 꺼낸다(macOS·Windows 구분자 모두). */
export function fileNameOf(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i < 0 ? path : path.slice(i + 1);
}
