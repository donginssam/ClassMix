import { describe, expect, it, vi } from "vitest";
import { extractPdfPages } from "./pdfExtract";

describe("PDF 문서 읽기 한도", () => {
  it("지원 범위를 넘는 페이지 수를 확인한 뒤 페이지를 가져오지 않는다", async () => {
    const getPage = vi.fn();
    const destroy = vi.fn(async () => {});
    const getDocument = () => ({ promise: Promise.resolve({ numPages: 251, getPage }), destroy });

    await expect(extractPdfPages({ getDocument }, new Uint8Array())).rejects.toThrow("250쪽");
    expect(getPage).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("열기 중 취소하면 로딩 작업을 한 번만 종료한다", async () => {
    const controller = new AbortController();
    const destroy = vi.fn(async () => {});
    const getDocument = () => ({
      promise: new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
      }),
      destroy,
    });

    const extracting = extractPdfPages({ getDocument }, new Uint8Array(), controller.signal);
    controller.abort();

    await expect(extracting).rejects.toMatchObject({ name: "AbortError" });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("페이지 조각을 읽는 중 텍스트 한도를 적용한다", async () => {
    const destroy = vi.fn(async () => {});
    const getPage = async () => ({
      streamTextContent: () =>
        new ReadableStream<{ items: unknown[] }>({
          start(controller) {
            controller.enqueue({ items: [{ str: "가".repeat(4_000_001), transform: [1, 0, 0, 1, 0, 0] }] });
            controller.close();
          },
        }),
    });
    const getDocument = () => ({ promise: Promise.resolve({ numPages: 1, getPage }), destroy });

    await expect(extractPdfPages({ getDocument }, new Uint8Array())).rejects.toThrow("텍스트가 너무 많습니다");
    expect(destroy).toHaveBeenCalledOnce();
  });
});
