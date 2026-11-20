import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ImportReport } from "@/lib/api";

export function ImportReportDialog({ report, onClose }: { report: ImportReport | null; onClose: () => void }) {
  return (
    <Dialog open={report != null} onOpenChange={(o) => !o && onClose()}>
      {report && (
        <DialogContent className="sm:max-w-2xl" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>XLSX 가져오기 완료</DialogTitle>
            <DialogDescription>
              {report.fileName} · {report.targetGrade} {report.classCount}개 반
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-3 gap-2 text-center">
            <Stat label="가져온 학생" value={`${report.imported}명`} />
            <Stat label="로마자 이름" value={`${report.romanNameCount}명`} />
            <Stat label="동명이인" value={`${report.sameNameGroups.length}그룹`} />
          </div>

          <div className="max-h-[50vh] space-y-4 overflow-y-auto pr-1">
            <section>
              <h3 className="mb-1.5 text-sm font-semibold">반별 인원</h3>
              <div className="flex flex-wrap gap-1.5">
                {report.classes.map((c) => (
                  <Badge key={c.class} variant="outline" className="tabular-nums">
                    {c.class}반 {c.count}명{c.gaps.length > 0 && ` · 빈 번호 ${c.gaps.join(", ")}`}
                  </Badge>
                ))}
              </div>
            </section>

            {report.sameNameGroups.length > 0 && (
              <section>
                <h3 className="mb-1.5 text-sm font-semibold">동명이인 분리 규칙 자동 생성</h3>
                <p className="text-sm text-muted-foreground">
                  {report.sameNameGroups.map((g) => `${g[0]}(${g.length}명)`).join(", ")} — 같은 반이 되면 경고합니다.
                </p>
              </section>
            )}

            {report.romanNameCount > 0 && (
              <section>
                <h3 className="mb-1.5 text-sm font-semibold">로마자 이름 학생 {report.romanNameCount}명</h3>
                <p className="text-sm text-muted-foreground">
                  확인을 누르면 번호 정렬에 쓸 한글 발음을 입력하는 단계가 이어집니다. 건너뛰고 나중에 [번호] 메뉴나
                  학생 메뉴에서 넣어도 됩니다.
                </p>
              </section>
            )}

            {report.warnings.length > 0 && (
              <section>
                <h3 className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold">
                  <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400" />
                  확인할 점
                </h3>
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {report.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </section>
            )}
          </div>

          <DialogFooter>
            <Button onClick={onClose}>확인</Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/40 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}
