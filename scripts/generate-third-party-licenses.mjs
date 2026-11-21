// 배포물에 들어가는 서드파티 구성 요소의 라이선스 전문을 모은다.
// - THIRD_PARTY_LICENSES.txt: 배포물(앱 번들, Windows 배포 폴더)과 저장소에 두는 고지 파일
// - src/generated/third-party-licenses.json: 앱 [설정 및 정보] → [오픈소스 라이선스] 화면이 읽는 데이터
//
// - 프런트엔드: vite로 실제 빌드해 번들에 들어간 npm 패키지만 모은다(빌드 도구·개발 의존성 제외).
//   Tailwind가 처리하는 CSS @import 패키지(tailwindcss, 글꼴 등)도 포함한다.
// - 앱 본체: 배포 대상(macOS arm64·x64, Windows x64)에 링크되는 Rust 크레이트를 cargo tree로 모은다.
// - 같은 전문은 한 번만 싣고, 구성 요소 목록에서 [L번호]로 가리킨다.
// - 패키지에 라이선스 파일이 없으면 scripts/license-templates/의 표준 문구로 채운다.
//
// `pnpm build`(= tauri build의 beforeBuildCommand)가 매번 먼저 실행하므로 의존성이 바뀌면 자동으로 갱신된다.
// 따로 실행하려면: pnpm licenses:generate
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { build } from "vite";

const root = path.resolve(import.meta.dirname, "..");
const tauriDir = path.join(root, "src-tauri");
const templatesDir = path.join(import.meta.dirname, "license-templates");
const outFile = path.join(root, "THIRD_PARTY_LICENSES.txt");
const jsonFile = path.join(root, "src/generated/third-party-licenses.json");

const RUST_TARGETS = ["aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-pc-windows-msvc"];
const LICENSE_FILE_RE = /^(licen[cs]e|copying|unlicense|notice)/i;
/** 라이선스 파일이 없을 때 고를 표준 문구(여러 라이선스 중 선택 가능하면 앞쪽 우선) */
const FALLBACK_ORDER = ["MIT", "BSD-3-Clause", "MPL-2.0"];
const RULE = "=".repeat(80);
const THIN = "-".repeat(80);

// ───────────── 프런트엔드(npm) ─────────────

/** 모듈 경로에서 그 모듈이 속한 node_modules 패키지 폴더를 찾는다. */
function packageDirOf(id) {
  const p = id.replace(/^\0/, "").split("?")[0].replaceAll("\\", "/");
  const marker = "/node_modules/";
  const at = p.lastIndexOf(marker);
  if (at < 0) return null;
  const rest = p.slice(at + marker.length).split("/");
  const nameParts = rest[0].startsWith("@") ? 2 : 1;
  if (rest.length < nameParts) return null;
  return p.slice(0, at + marker.length) + rest.slice(0, nameParts).join("/");
}

/** src 아래 CSS의 `@import "패키지"`(Tailwind가 직접 처리해 모듈 그래프에 안 잡힘) */
function cssImportedPackages() {
  const dirs = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".css")) {
        for (const m of fs.readFileSync(full, "utf8").matchAll(/@import\s+["']([^"']+)["']/g)) {
          const spec = m[1];
          if (spec.startsWith(".") || spec.startsWith("/")) continue;
          const parts = spec.split("/");
          const name = parts.slice(0, spec.startsWith("@") ? 2 : 1).join("/");
          dirs.add(fs.realpathSync(path.join(root, "node_modules", name)));
        }
      }
    }
  };
  walk(path.join(root, "src"));
  return dirs;
}

async function npmPackages() {
  // 앱이 이 JSON을 import하므로, 처음 실행이라 없으면 빈 파일을 만들어 빌드가 깨지지 않게 한다.
  if (!fs.existsSync(jsonFile)) {
    fs.mkdirSync(path.dirname(jsonFile), { recursive: true });
    fs.writeFileSync(jsonFile, JSON.stringify({ app: null, sections: [], texts: [] }));
  }
  const dirs = cssImportedPackages();
  await build({
    root,
    logLevel: "silent",
    build: { write: false },
    plugins: [
      {
        name: "collect-bundled-packages",
        generateBundle(_, bundle) {
          const ids = [...this.getModuleIds()];
          for (const out of Object.values(bundle)) {
            if (out.type === "asset") ids.push(...(out.originalFileNames ?? []));
          }
          for (const id of ids) {
            const dir = packageDirOf(id);
            if (dir) dirs.add(fs.realpathSync(dir));
          }
        },
      },
    ],
  });

  const byKey = new Map();
  for (const dir of dirs) {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const license = typeof pkg.license === "string" ? pkg.license : (pkg.license?.type ?? "UNKNOWN");
    const author = typeof pkg.author === "string" ? pkg.author : pkg.author?.name;
    byKey.set(`${pkg.name}@${pkg.version}`, {
      name: pkg.name,
      version: pkg.version,
      license,
      authors: author ? [author] : [],
      dir,
    });
  }
  return [...byKey.values()];
}

// ───────────── 앱 본체(Rust) ─────────────

function cargo(args) {
  return execFileSync("cargo", args, { cwd: tauriDir, encoding: "utf8", maxBuffer: 1 << 29 });
}

function rustCrates() {
  const targets = RUST_TARGETS.flatMap((t) => ["--target", t]);
  const wanted = new Set(
    cargo(["tree", "--locked", "-e", "normal", ...targets, "--prefix", "none", "-f", "{p}"])
      .split("\n")
      .map((l) => l.replace(/\s+\(.*$/, "").trim())
      .filter(Boolean),
  );
  const meta = JSON.parse(cargo(["metadata", "--locked", "--format-version", "1"]));
  const rootId = meta.resolve.root;
  return meta.packages
    .filter((p) => p.id !== rootId && wanted.has(`${p.name} v${p.version}`))
    .map((p) => ({
      name: p.name,
      version: p.version,
      license: p.license ?? (p.license_file ? `파일: ${p.license_file}` : "UNKNOWN"),
      authors: p.authors,
      repository: p.repository,
      dir: path.dirname(p.manifest_path),
    }));
}

// ───────────── 전문 모으기 ─────────────

const normalize = (text) =>
  text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();

function licenseTexts(item) {
  const files = fs
    .readdirSync(item.dir)
    .filter((f) => LICENSE_FILE_RE.test(f) && fs.statSync(path.join(item.dir, f)).isFile())
    .sort();
  if (files.length > 0) {
    return { fallback: false, texts: files.map((f) => normalize(fs.readFileSync(path.join(item.dir, f), "utf8"))) };
  }
  const ids = item.license.split(/\s+OR\s+|\s*\/\s*|[()]/).map((s) => s.trim());
  const id = FALLBACK_ORDER.find((l) => ids.includes(l));
  if (!id) {
    throw new Error(
      `${item.name} ${item.version}: 라이선스 파일이 없고 표준 문구도 없습니다(${item.license}). ` +
        `scripts/license-templates/에 추가하세요.`,
    );
  }
  const holders = item.authors.map((a) => a.replace(/\s*<[^>]*>/, "").trim()).filter(Boolean);
  const copyright = holders.length
    ? `Copyright (c) ${holders.join(", ")}`
    : `Copyright (c) The ${item.name} developers${item.repository ? ` (${item.repository})` : ""}`;
  const template = fs.readFileSync(path.join(templatesDir, `${id}.txt`), "utf8");
  return { fallback: true, texts: [normalize(template.replace("{{copyright}}", copyright))] };
}

/** 쉼표로 이은 목록을 너비에 맞춰 줄바꿈한다. */
function wrapList(items, indent, width = 80) {
  const lines = [];
  let line = "";
  for (const [i, item] of items.entries()) {
    const piece = item + (i < items.length - 1 ? "," : "");
    if (line && indent.length + line.length + 1 + piece.length > width) {
      lines.push(line);
      line = piece;
    } else {
      line = line ? `${line} ${piece}` : piece;
    }
  }
  if (line) lines.push(line);
  return lines.map((l, i) => (i === 0 ? l : indent + l)).join("\n");
}

const byName = (a, b) => a.name.localeCompare(b.name, "en") || a.version.localeCompare(b.version, "en");
const sections = [
  { id: "npm", title: "프런트엔드: npm 패키지", items: (await npmPackages()).sort(byName) },
  { id: "cargo", title: "앱 본체: Rust 크레이트", items: rustCrates().sort(byName) },
];

const groups = new Map(); // 전문 → { id, users }
for (const section of sections) {
  for (const item of section.items) {
    const { fallback, texts } = licenseTexts(item);
    item.fallback = fallback;
    item.refs = texts.map((text) => {
      if (!groups.has(text)) groups.set(text, { id: `L${groups.size + 1}`, users: [] });
      const g = groups.get(text);
      g.users.push(`${item.name} ${item.version}`);
      return g.id;
    });
  }
}

// ───────────── 쓰기 ─────────────

const out = [
  "ClassMix 서드파티 라이선스 고지",
  "Third-Party Software Notices and Licenses",
  "",
  "ClassMix는 아래 오픈소스 소프트웨어를 포함해 배포됩니다. 각 구성 요소는 해당 라이선스를",
  "따르며, 라이선스 전문은 이 파일 2장의 [L번호]에 있습니다. 여러 라이선스 중 하나를 고를 수",
  "있는 구성 요소(예: MIT OR Apache-2.0)는 패키지에 들어 있는 라이선스 파일을 모두 실었습니다.",
  "rusqlite가 함께 빌드하는 SQLite는 퍼블릭 도메인입니다.",
  "",
  "이 파일은 `pnpm licenses:generate`로 만듭니다. 직접 고치지 마세요.",
  "",
  RULE,
  "1. 구성 요소 목록",
  RULE,
];
for (const section of sections) {
  out.push("", `[${section.title} ${section.items.length}개]`, "");
  for (const item of section.items) {
    const note = item.fallback ? " (패키지에 라이선스 파일이 없어 표준 문구로 대신함)" : "";
    out.push(`${item.name} ${item.version} — ${item.license} — [${item.refs.join(", ")}]${note}`);
  }
}
out.push("", RULE, "2. 라이선스 전문", RULE);
for (const [text, g] of groups) {
  out.push("", THIN, `[${g.id}] 적용 대상: ${wrapList(g.users, "     ")}`, THIN, "", text);
}
fs.writeFileSync(outFile, `${out.join("\n")}\n`);

// 앱 화면용 JSON: 전문은 texts에 한 번씩만 두고 패키지는 번호로 가리킨다.
const appPkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const json = {
  app: {
    name: "ClassMix",
    license: appPkg.license,
    text: normalize(fs.readFileSync(path.join(root, "LICENSE"), "utf8")),
  },
  sections: sections.map((section) => ({
    id: section.id,
    title: section.title,
    packages: section.items.map((item) => ({
      name: item.name,
      version: item.version,
      license: item.license,
      texts: item.refs.map((ref) => Number(ref.slice(1)) - 1),
      ...(item.fallback ? { fallback: true } : {}),
    })),
  })),
  texts: [...groups.keys()],
};
fs.mkdirSync(path.dirname(jsonFile), { recursive: true });
fs.writeFileSync(jsonFile, `${JSON.stringify(json, null, 1)}\n`);

const total = sections.reduce((n, s) => n + s.items.length, 0);
console.log(`${path.relative(root, outFile)}: 구성 요소 ${total}개, 라이선스 전문 ${groups.size}종`);
