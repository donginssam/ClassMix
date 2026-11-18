/**
 * pdf.js로 쪽별 텍스트 조각(좌표 포함)을 뽑는다.
 * pdf.js 모듈은 호출하는 쪽에서 넘긴다(앱: 브라우저 빌드 + 워커, 테스트: Node용 legacy 빌드).
 */
import type { PdfPage, TextItem } from "./pdfTable";

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
      getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }>;
    }>;
    destroy(): Promise<void>;
  };
}

export async function extractPdfPages(pdfjs: PdfJsLike, data: Uint8Array): Promise<PdfPage[]> {
  const task = pdfjs.getDocument({ data, verbosity: 0 });
  try {
    const doc = await task.promise;
    const pages: PdfPage[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const items: TextItem[] = [];
      for (const raw of content.items) {
        const it = raw as Partial<PdfJsTextItem>;
        if (typeof it.str !== "string" || !Array.isArray(it.transform)) continue;
        items.push({
          str: it.str,
          x: it.transform[4],
          y: it.transform[5],
          width: it.width ?? 0,
          height: it.height ?? 0,
        });
      }
      pages.push({ pageNumber: n, items });
    }
    return pages;
  } finally {
    await task.destroy();
  }
}
