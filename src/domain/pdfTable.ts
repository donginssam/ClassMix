/**
 * 나이스 "반편성내역[배정반기준]" PDF의 표를 글자 좌표로 복원한다.
 *
 * - 머리글(학년·반·번호·성명·생년월일·성별·기준성적·이전학적(학년·반·번호)·특이사항)의
 *   x 좌표로 열 경계를 정한다.
 * - 학년 열의 `n학년` 글자를 행 기준선으로 삼고, 성명 열에서 기준선 위·아래로 줄바꿈된
 *   이름 조각을 그 행에 합친다.
 * - 쪽 아래 `남(n명) 여(n명) 계:(n)`으로 쪽별 행 수를 검증한다.
 */
import { collapseSpaces, toInt, toIsoDate, toScore } from "./normalize";

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

export type PdfRowStatus = "regular" | "transfer_in" | "transfer_out";

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
  baseScore: number | null;
  status: PdfRowStatus;
  prevGrade: string | null;
  prevClass: number | null;
  prevNumber: number | null;
  note: string | null;
}

export interface PageCheck {
  page: number;
  rows: number;
  transferOut: number;
  /** 쪽 아래 요약(없으면 null) */
  footer: { male: number; female: number; total: number } | null;
  /** 요약과 행 수가 맞고 모든 행을 읽었는지(요약은 전출 학생을 빼고 센다) */
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

const FOOTER_RE = /남\s*\((\d+)명\)[\s\S]*?여\s*\((\d+)명\)[\s\S]*?계\s*:?\s*\((\d+)\)/;

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
    const text = (c: Col) =>
      collapseSpaces(
        cells[c]
          .sort((a, b) => b.y - a.y || a.x - b.x)
          .map((it) => it.str)
          .join(" "),
      );

    const prevTexts = [text("prevGrade"), text("prevClass"), text("prevNumber")].join(" ");
    let status: PdfRowStatus = "regular";
    if (/전입/.test(prevTexts)) status = "transfer_in";
    else if (/전출/.test(prevTexts)) status = "transfer_out";

    const gender = text("gender");
    const birthRaw = text("birth");
    rows.push({
      page: page.pageNumber,
      grade: text("grade").replace(/\s+/g, ""),
      class: toInt(text("class")) ?? NaN,
      number: toInt(text("number")) ?? NaN,
      name: text("name"),
      birthRaw,
      birthDate: toIsoDate(birthRaw),
      gender: gender === "남" || gender === "여" ? gender : null,
      baseScore: toScore(text("score")),
      status,
      prevGrade: status === "regular" ? text("prevGrade").replace(/\s+/g, "") || null : null,
      prevClass: status === "regular" ? toInt(text("prevClass")) : null,
      prevNumber: status === "regular" ? toInt(text("prevNumber")) : null,
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
  const transferOut = rows.filter((r) => r.status === "transfer_out").length;
  let ok = true;
  let message: string | null = null;
  if (!footer) {
    message = `${page.pageNumber}쪽 아래 인원 요약을 찾지 못했습니다.`;
  } else if (footer.total !== rows.length - transferOut) {
    ok = false;
    message = `${page.pageNumber}쪽: 표에서 읽은 학생 ${rows.length - transferOut}명과 쪽 요약 ${footer.total}명이 다릅니다.`;
  } else {
    // 인원은 맞음. 성별은 참고용 안내만 한다(원본 요약 자체가 틀린 경우가 있음).
    const counted = rows.filter((r) => r.status !== "transfer_out");
    const male = counted.filter((r) => r.gender === "남").length;
    const female = counted.filter((r) => r.gender === "여").length;
    if (footer.male + footer.female !== footer.total) {
      message = `${page.pageNumber}쪽 요약의 남(${footer.male})+여(${footer.female})가 계(${footer.total})와 맞지 않습니다. 표에서 읽은 값: 남 ${male}, 여 ${female}.`;
    } else if (male !== footer.male || female !== footer.female) {
      message = `${page.pageNumber}쪽: 성별 인원(남 ${male}, 여 ${female})이 쪽 요약(남 ${footer.male}, 여 ${footer.female})과 다릅니다.`;
    }
  }
  for (const r of rows) {
    if (Number.isNaN(r.class) || Number.isNaN(r.number) || !r.name) {
      ok = false;
      message = `${page.pageNumber}쪽에 반·번호·성명을 읽지 못한 행이 있습니다.`;
    }
  }
  return {
    rows,
    check: { page: page.pageNumber, rows: rows.length, transferOut, footer, ok, message },
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
