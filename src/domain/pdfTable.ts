/**
 * 나이스 "반편성내역[배정반기준]" PDF의 표를 글자 좌표로 복원한다.
 *
 * - 머리글(학년·반·번호·성명·생년월일·성별·기준성적·이전학적(학년·반·번호)·특이사항)의
 *   x 좌표로 열 경계를 정한다.
 * - 학년 열의 `n학년` 글자를 행 기준선으로 삼고, 성명 열에서 기준선 위·아래로 줄바꿈된
 *   이름 조각을 그 행에 합친다.
 * - 표 아래 나이스 표준 인원 요약 `남(n)명 여(n)명 계:(n)`의 계로 쪽별 행 수를 검증한다.
 *   (그 아래 쪽 번호 꼬리말 `1 / 8`은 무시한다.)
 */
import { collapseSpaces, toInt, toIsoDate, toBaseScore } from "./normalize";

/** pdf.js 텍스트 조각. y는 PDF 좌표(아래가 0)이다. */
export interface TextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfPage {
  pageNumber: number;
  items: TextItem[];
}

export interface PdfRow {
  page: number;
  grade: string;
  class: number;
  number: number;
  name: string;
  /** 원문 생년월일(예: `2007.11.19.`) */
  birthRaw: string;
  birthDate: string | null;
  gender: "남" | "여" | null;
  /** 원문 기준성적(예: `1,073.89`) */
  scoreRaw: string;
  /** 기준성적 ×100 정수(0.01점 단위). 예: 107389 */
  baseScore: number | null;
  prevGrade: string | null;
  prevClass: number | null;
  prevNumber: number | null;
  note: string | null;
}

export interface PageCheck {
  page: number;
  rows: number;
  /** 쪽 아래 요약(없으면 null) */
  footer: { male: number; female: number; total: number } | null;
  /** 요약과 행 수가 맞고 모든 행을 읽었는지 */
  ok: boolean;
  /** 실패 이유 또는 참고 안내 */
  message: string | null;
}

export interface PdfParseResult {
  rows: PdfRow[];
  pages: PageCheck[];
  /** 표를 찾지 못한 쪽 등 */
  problems: string[];
}

type Col =
  | "grade"
  | "class"
  | "number"
  | "name"
  | "birth"
  | "gender"
  | "score"
  | "prevGrade"
  | "prevClass"
  | "prevNumber"
  | "note";

const COL_ORDER: Col[] = [
  "grade",
  "class",
  "number",
  "name",
  "birth",
  "gender",
  "score",
  "prevGrade",
  "prevClass",
  "prevNumber",
  "note",
];

const center = (it: TextItem) => it.x + it.width / 2;

interface Layout {
  centers: Record<Col, number>;
  headerY: number;
}

/** 머리글에서 열 가운데 x를 찾는다. */
function findLayout(items: TextItem[]): Layout | null {
  const find = (label: string) => items.find((it) => it.str.trim() === label);
  const nameH = find("성명");
  const birthH = find("생년월일");
  const genderH = find("성별");
  const scoreH = find("기준성적");
  if (!nameH || !birthH || !genderH || !scoreH) return null;
  const headerY = nameH.y;
  const near = (it: TextItem) => Math.abs(it.y - headerY) < 20;
  const labeled = (label: string) => items.filter((it) => it.str.trim() === label && near(it));

  const left = (label: string) =>
    labeled(label)
      .filter((it) => center(it) < center(nameH))
      .sort((a, b) => a.x - b.x)[0];
  const right = (label: string) =>
    labeled(label)
      .filter((it) => center(it) > center(scoreH))
      .sort((a, b) => a.x - b.x)[0];

  const grade = left("학년");
  const cls = left("반");
  const num = left("번호");
  const prevGrade = right("학년");
  const prevClass = right("반");
  const prevNumber = right("번호");
  if (!grade || !cls || !num || !prevGrade || !prevClass || !prevNumber) return null;
  const noteH = find("특이사항");
  const centers: Record<Col, number> = {
    grade: center(grade),
    class: center(cls),
    number: center(num),
    name: center(nameH),
    birth: center(birthH),
    gender: center(genderH),
    score: center(scoreH),
    prevGrade: center(prevGrade),
    prevClass: center(prevClass),
    prevNumber: center(prevNumber),
    note: noteH ? center(noteH) : center(prevNumber) + 60,
  };
  return { centers, headerY };
}

function columnOf(x: number, centers: Record<Col, number>): Col {
  let best: Col = "grade";
  let bestDist = Infinity;
  for (const c of COL_ORDER) {
    const d = Math.abs(x - centers[c]);
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}

// 나이스 표준 인원 요약: `남(18)명 여(12)명 계:(30)`
const FOOTER_RE = /남\s*\(\s*(\d+)\s*\)\s*명[\s\S]*?여\s*\(\s*(\d+)\s*\)\s*명[\s\S]*?계\s*:\s*\(\s*(\d+)\s*\)/;

/**
 * 성명 칸 조각을 잇는다. 나이스 성명은 한국 국적이면 띄어쓰기 없는 한글, 외국 국적이면 여권상 대문자
 * 로마자(단어 사이 한 칸)이므로, 한글과 한글 사이는 줄이 같든 다르든 항상 붙이고 그 밖은 한 칸 띄운다.
 */
export function pdfName(parts: string[]): string {
  return collapseSpaces(joinWrapped(parts.flatMap((p) => p.split(/\s+/))));
}

/**
 * 줄바꿈된 조각을 잇는다. 한글 사이에서 끊긴 경우(`귀여운제비` / `꽃`)는 붙이고,
 * 그 밖(로마자 이름 `HANNAH CRUZ` / `QU`)은 한 칸 띄운다.
 */
export function joinWrapped(parts: string[]): string {
  let out = "";
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    if (out && !(/[가-힣]$/.test(out) && /^[가-힣]/.test(part))) out += " ";
    out += part;
  }
  return out;
}

function parsePage(page: PdfPage, problems: string[]): { rows: PdfRow[]; check: PageCheck } | null {
  const items = page.items.filter((it) => it.str.trim() !== "");
  const layout = findLayout(items);
  if (!layout) {
    problems.push(`${page.pageNumber}쪽에서 반편성 표 머리글을 찾지 못했습니다.`);
    return null;
  }
  const { centers, headerY } = layout;
  const body = items.filter((it) => it.y < headerY - 12);

  // 행 기준선: 학년 열의 `n학년`
  const anchors = body
    .filter((it) => /^\d+\s*학년$/.test(it.str.trim()) && columnOf(center(it), centers) === "grade")
    .sort((a, b) => b.y - a.y);
  const lineTol = 2.5;
  const rowGap = anchors.length > 1 ? median(anchors.slice(1).map((a, i) => anchors[i].y - a.y)) : 17;

  const rows: PdfRow[] = [];
  anchors.forEach((anchor, i) => {
    const upper = i > 0 ? (anchors[i - 1].y + anchor.y) / 2 : anchor.y + rowGap / 2;
    const lower = i < anchors.length - 1 ? (anchors[i + 1].y + anchor.y) / 2 : anchor.y - rowGap / 2;
    const cells: Record<Col, TextItem[]> = Object.fromEntries(COL_ORDER.map((c) => [c, []])) as never;

    for (const it of body) {
      const col = columnOf(center(it), centers);
      const onLine = Math.abs(it.y - anchor.y) <= lineTol;
      // 성명·특이사항은 줄바꿈될 수 있으므로 행 띠 안의 조각을 모두 모은다.
      const inBand = it.y < upper && it.y >= lower;
      if (onLine || ((col === "name" || col === "note") && inBand)) cells[col].push(it);
    }
    // 같은 줄 조각은 띄어 잇고, 줄바꿈된 조각은 joinWrapped 규칙으로 잇는다(특이사항 등).
    const text = (c: Col) => {
      const lines: { y: number; parts: string[] }[] = [];
      for (const it of cells[c].sort((a, b) => b.y - a.y || a.x - b.x)) {
        const last = lines.at(-1);
        if (last && Math.abs(last.y - it.y) <= lineTol) last.parts.push(it.str);
        else lines.push({ y: it.y, parts: [it.str] });
      }
      return collapseSpaces(joinWrapped(lines.map((l) => collapseSpaces(l.parts.join(" ")))));
    };

    const gender = text("gender");
    const birthRaw = text("birth");
    rows.push({
      page: page.pageNumber,
      grade: text("grade").replace(/\s+/g, ""),
      class: toInt(text("class")) ?? NaN,
      number: toInt(text("number")) ?? NaN,
      name: pdfName(cells.name.sort((a, b) => b.y - a.y || a.x - b.x).map((it) => it.str)),
      birthRaw,
      birthDate: toIsoDate(birthRaw),
      gender: gender === "남" || gender === "여" ? gender : null,
      scoreRaw: text("score"),
      baseScore: toBaseScore(text("score")),
      prevGrade: text("prevGrade").replace(/\s+/g, "") || null,
      prevClass: toInt(text("prevClass")),
      prevNumber: toInt(text("prevNumber")),
      note: text("note") || null,
    });
  });

  const footerText = items
    .filter((it) => it.y < (anchors.at(-1)?.y ?? headerY))
    .sort((a, b) => b.y - a.y || a.x - b.x)
    .map((it) => it.str)
    .join(" ");
  const fm = footerText.match(FOOTER_RE);
  const footer = fm ? { male: Number(fm[1]), female: Number(fm[2]), total: Number(fm[3]) } : null;
  let ok = true;
  let message: string | null = null;
  if (!footer) {
    message = `${page.pageNumber}쪽 아래 인원 요약을 찾지 못했습니다.`;
  } else if (footer.total !== rows.length) {
    ok = false;
    message = `${page.pageNumber}쪽: 표에서 읽은 학생 ${rows.length}명과 쪽 요약 ${footer.total}명이 다릅니다.`;
  }
  for (const r of rows) {
    if (Number.isNaN(r.class) || Number.isNaN(r.number) || !r.name) {
      ok = false;
      message = `${page.pageNumber}쪽에 반·번호·성명을 읽지 못한 행이 있습니다.`;
    }
  }
  return {
    rows,
    check: { page: page.pageNumber, rows: rows.length, footer, ok, message },
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function parsePdfPages(pages: PdfPage[]): PdfParseResult {
  const problems: string[] = [];
  const rows: PdfRow[] = [];
  const checks: PageCheck[] = [];
  for (const p of pages) {
    const res = parsePage(p, problems);
    if (!res) continue;
    rows.push(...res.rows);
    checks.push(res.check);
  }
  if (rows.length === 0 && problems.length === 0) problems.push("PDF에서 학생 행을 찾지 못했습니다.");
  return { rows, pages: checks, problems };
}
