/**
 * pdf.js로 쪽별 텍스트 조각(좌표 포함)을 뽑는다.
 * pdf.js 모듈은 호출하는 쪽에서 넘긴다(앱: 브라우저 빌드 + 워커, 테스트: Node용 legacy 빌드).
 */
import type { PdfPage, TextItem } from "./pdfTable";

const MAX_PAGES = 250;
const MAX_ITEMS = 300_000;
const MAX_TEXT_LENGTH = 4_000_000;

interface PdfJsTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

interface PdfJsLike {
  getDocument(src: { data: Uint8Array; verbosity?: number }): {
    promise: Promise<{
      numPages: number;
      getPage(n: number): Promise<{ streamTextContent(): ReadableStream<{ items: unknown[] }> }>;
    }>;
    destroy(): Promise<void>;
  };
}

export async function extractPdfPages(pdfjs: PdfJsLike, data: Uint8Array, signal?: AbortSignal): Promise<PdfPage[]> {
  signal?.throwIfAborted();
  const task = pdfjs.getDocument({ data, verbosity: 0 });
  let destruction: Promise<void> | undefined;
  const destroy = () => (destruction ??= task.destroy());
  const onAbort = () => void destroy().catch(() => undefined);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const doc = await task.promise;
    signal?.throwIfAborted();
    if (doc.numPages > MAX_PAGES) throw new Error(`PDF는 ${MAX_PAGES}쪽까지 읽을 수 있습니다.`);
    const pages: PdfPage[] = [];
    let itemCount = 0;
    let textLength = 0;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      signal?.throwIfAborted();
      const items: TextItem[] = [];
      const reader = page.streamTextContent().getReader();
      try {
        for (;;) {
          const chunk = await reader.read();
          signal?.throwIfAborted();
          if (chunk.done) break;
          itemCount += chunk.value.items.length;
          if (itemCount > MAX_ITEMS) throw new Error("PDF에 텍스트 조각이 너무 많습니다.");
          for (const raw of chunk.value.items) {
            const it = raw as Partial<PdfJsTextItem>;
            if (typeof it.str !== "string" || !Array.isArray(it.transform)) continue;
            textLength += it.str.length;
            if (textLength > MAX_TEXT_LENGTH) throw new Error("PDF에 텍스트가 너무 많습니다.");
            items.push({
              str: it.str,
              x: it.transform[4],
              y: it.transform[5],
              width: it.width ?? 0,
              height: it.height ?? 0,
            });
          }
        }
      } finally {
        reader.releaseLock();
      }
      pages.push({ pageNumber: n, items });
    }
    return pages;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await destroy();
  }
}
