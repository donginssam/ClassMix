import { Component, type ErrorInfo, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

interface State {
  error: Error | null;
}

/**
 * 화면 그리기 중 예상하지 못한 오류가 나도 흰 화면 대신 안내를 보여 준다.
 * 모든 변경은 즉시 .mix 파일에 저장되므로 다시 불러오면 작업이 그대로 이어진다.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("화면 오류", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex min-h-svh items-center justify-center bg-board p-8">
        <div className="flex max-w-md flex-col gap-4 rounded-xl border bg-background p-6 shadow-xs">
          <div className="flex items-center gap-2">
            <TriangleAlert className="size-5 text-destructive" />
            <h1 className="text-base font-semibold">화면을 그리는 중 문제가 생겼습니다</h1>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            지금까지의 변경 내용은 작업 파일(.mix)에 이미 저장되어 있습니다. [다시 불러오기]를 누르면 열려 있던 파일을
            이어서 보여 줍니다. 같은 문제가 반복되면 아래 내용을 개발자에게 알려 주세요.
          </p>
          <pre className="max-h-32 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap text-muted-foreground">
            {error.message || String(error)}
          </pre>
          <Button className="self-end" onClick={() => window.location.reload()}>
            다시 불러오기
          </Button>
        </div>
      </div>
    );
  }
}
