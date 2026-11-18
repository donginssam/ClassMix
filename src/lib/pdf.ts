/** 앱(웹뷰)에서 PDF를 읽는다. pdf.js 워커는 번들에 포함되어 오프라인에서도 동작한다. */
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { extractPdfPages } from "@/domain/pdfExtract";
import { parsePdfPages, type PdfParseResult } from "@/domain/pdfTable";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export async function parsePdf(data: Uint8Array): Promise<PdfParseResult> {
  const pages = await extractPdfPages(pdfjs as never, data);
  return parsePdfPages(pages);
}
