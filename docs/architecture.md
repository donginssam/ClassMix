# 아키텍처

> 나이스(NEIS) 반편성 도우미 · Tauri 2 + React 19 + TypeScript + shadcn/ui + SQLite

ClassMix는 나이스에서 기본 편성을 마친 뒤 내려받은 **진급반편성 XLSX**(필수)와 **반편성내역 PDF**(선택, 기준성적 포함)를 불러와, 반편성을 손으로 조정한 뒤 **원본 XLSX 양식 그대로 진급반코드·진급반번호만 바꿔** 나이스 업로드용 XLSX로 내보내는 데스크톱 앱이다.

관련 문서: [결정 사항](decisions.md) · [기능 명세](features.md)

---

## 1. 전체 흐름

```
[1] 새 반편성 파일 만들기 ── 저장 위치·파일명 선택 → 빈 .mix 파일을 생성   (또는 기존 .mix 열기·더블클릭 → [4])
        │
[2] XLSX 가져오기 (필수) ── 헤더 검증 → 전입·전출 행 건너뜀 → student 테이블 저장
        │                   나이스 기본 편성(진급반코드·번호)이 초기 상태, 원본 파일 BLOB 보관
        │                   동명이인 감지 → 분리 규칙 자동 생성 → 로마자 성명 한글 표기 입력(선택)
        │
[3] PDF 가져오기 (선택) ── pdf.js로 표 추출 → 매핑 → 매핑 검토 화면
        │                   확정 시 기준성적·성별·생년월일을 student에 반영
        │                   생년월일로 쌍둥이 후보 감지 → 교사 확인
        │
[4] 반편성 보드 ── 균형 지표, 바꾸기/이동/드래그, 번호·빈 번호, 분리 규칙, 되돌리기, 이력
        │          모든 변경은 열린 .mix에 즉시 트랜잭션으로 저장
        │
[5] 내보내기 ── 검증(차단/경고/안내) → 원본 XLSX에 셀 값만 기록 → 다시 읽어 왕복 검증
```

PDF 없이 XLSX만으로도 작업할 수 있다. 이때 성적·성별·생년월일 관련 UI는 숨긴다. PDF는 언제든 나중에 추가·교체할 수 있다.

---

## 2. 역할 분담

원칙: **"새 상태 계산"은 프런트엔드 순수 함수, "저장·파일 입출력"은 Rust.**

| 영역                                          | 위치                                           | 라이브러리                                        |
| --------------------------------------------- | ---------------------------------------------- | ------------------------------------------------- |
| 작업 파일(.mix) 생성·열기·마이그레이션·사본   | Rust `db.rs`, `commands.rs`                    | `rusqlite`(bundled)                               |
| 작업 파일 암호화(키 파생·칸 단위 암호화·잠금) | Rust `crypto.rs`                               | `pbkdf2`, `aes-gcm`, `zeroize`, `getrandom`       |
| 변경 적용·되돌리기·다시 실행·이력             | Rust `changes.rs`                              | —                                                 |
| 보드 데이터·분리 규칙·메모                    | Rust `board.rs`, `roster.rs`                   | —                                                 |
| XLSX 읽기(가져오기)                           | Rust `xlsx_import.rs`                          | `umya-spreadsheet`                                |
| XLSX 쓰기(내보내기) + 왕복 검증               | Rust `export.rs`                               | `umya-spreadsheet`                                |
| 설정·최근 파일                                | Rust `settings.rs`                             | `serde_json`                                      |
| WebView2 확인, `.mix` 파일 연결, 실행 인자    | Rust `os_integration.rs`                       | `winreg`(Windows), `tauri-plugin-single-instance` |
| PDF 표 추출                                   | Frontend `domain/pdfExtract.ts`, `pdfTable.ts` | `pdfjs-dist`                                      |
| 매핑·번호 재부여·통계·분리 위반·검증          | Frontend `src/domain/*` (TS 순수 함수, Vitest) | —                                                 |
| 상태 관리                                     | Frontend `store/workspace.ts`                  | `zustand`                                         |
| UI                                            | React + shadcn/ui + Tailwind 4                 | `@dnd-kit/core`, `sonner`, `lucide-react`         |
| 글꼴                                          | Frontend 자산(실행 파일 내장)                  | `@fontsource/ibm-plex-sans-kr`                    |

### 변경 묶음(ChangeSet) 패턴

반편성을 바꾸는 모든 동작(바꾸기·이동·재정렬·번호 수정·빈 번호·한글 표기·초기화)은 같은 경로를 탄다.

1. 프런트엔드가 현재 상태에서 새 상태를 계산한다(`domain/changes.ts`, `domain/numbering.ts`).
2. 결과를 **바꾸기 전·후 값을 모두 담은 변경 묶음**(`ChangeSet`: 학생 좌석, 반별 빈 번호, 반 번호 상태, 한글 표기)으로 만들어 `apply_change`를 호출한다.
3. Rust는 "바꾸기 전" 값이 지금 DB와 같은지 확인한 뒤(어긋나면 거절) 한 트랜잭션으로 적용하고 `change_log`에 JSON으로 남긴다. 같은 좌석에 두 학생이 들어가는 변경도 거절한다.
4. 되돌리기는 전·후를 뒤집은 묶음을 적용하고(`undone = 1`), 다시 실행은 원래 묶음을 다시 적용한다. 새 변경이 들어오면 되돌려 둔 기록은 지운다.

이력이 `.mix` 파일 안에 있으므로 앱을 껐다 켜도 되돌리기·이력이 유지된다. 이력 단계 수 제한은 없다.

---

## 3. 디렉터리 구조

```
ClassMix/
├─ src/                              # React
│  ├─ App.tsx, main.tsx, index.css
│  ├─ app/                           # ErrorBoundary, TitleBar(macOS 숨은 제목 표시줄)
│  ├─ features/
│  │  ├─ workspace/StartScreen       # 새로 만들기 / 열기 / 최근 파일
│  │  ├─ import-xlsx/                # XLSX 가져오기 화면 + 가져오기 요약
│  │  ├─ import-pdf/                 # PDF 매핑 검토
│  │  ├─ board/                      # 편성표(학년 전체 표), 이력, 대화상자, 동작
│  │  ├─ stats/                      # 균형 지표(BalanceMeters), 통계표
│  │  ├─ constraints/                # 분리 규칙, 학생 선택, 쌍둥이 후보 검토
│  │  ├─ security/                   # 잠금 해제 화면, 비밀번호 설정·변경·해제
│  │  ├─ export/                     # 내보내기 검증·저장
│  │  └─ settings/                   # 설정 및 정보, 단축키 목록
│  ├─ domain/                        # 순수 로직(테스트 대상)
│  │  ├─ normalize.ts                # 이름/숫자 정규화, 로마자 감지
│  │  ├─ pdfExtract.ts, pdfTable.ts  # pdf.js 텍스트 → 행/열 복원
│  │  ├─ matching.ts                 # XLSX↔PDF 매핑
│  │  ├─ numbering.ts                # 번호 재부여·빈 번호
│  │  ├─ changes.ts                  # 변경 묶음 생성
│  │  ├─ separation.ts               # 분리 규칙 위반 검사
│  │  ├─ siblings.ts                 # 쌍둥이 후보 감지
│  │  ├─ stats.ts                    # 반별·전체 통계, 경고 기준
│  │  └─ validate.ts                 # 내보내기 전 검증
│  ├─ lib/                           # api.ts(invoke 래퍼), 파일 동작, 드롭/열기 요청 훅
│  ├─ store/workspace.ts             # zustand 스토어
│  └─ components/ui/                 # shadcn
├─ src-tauri/
│  ├─ src/
│  │  ├─ lib.rs                      # 앱 구성, 커맨드 등록, RunEvent 처리
│  │  ├─ commands.rs                 # Tauri 커맨드(AppState: 열린 연결 1개)
│  │  ├─ db.rs, schema_v1.sql        # 작업 파일 형식·마이그레이션
│  │  ├─ crypto.rs                   # 작업 파일 암호화
│  │  ├─ xlsx_import.rs, roster.rs, board.rs, changes.rs, export.rs
│  │  ├─ names.rs                    # 이름 정규화(공백 축약, 동명이인 키)
│  │  ├─ settings.rs, os_integration.rs, error.rs
│  ├─ .cargo/config.toml             # Windows +crt-static
│  ├─ tauri.conf.json, tauri.macos.conf.json
│  └─ icons/                         # app-icon.svg 원본 + 생성된 아이콘
├─ scripts/generate-icons.mjs        # pnpm icons
├─ scripts/generate-third-party-licenses.mjs  # pnpm licenses:generate → THIRD_PARTY_LICENSES.txt
├─ tests/fixtures/                   # 더미 sample.xlsx / sample.pdf / 기대 결과 JSON
└─ .github/workflows/
   ├─ CI.yml                         # 푸시·포크 PR 테스트
   └─ build.yml                      # 새 v* 태그의 배포물 및 Release 초안
```

> 계획 단계에서는 Rust를 `db/`, `commands/` 하위 모듈로 나눌 예정이었으나, 모듈이 작아 기능별 평평한 파일로 두었다.

---

## 4. 작업 파일(.mix)

반편성 1건(한 학년의 진급 편성)이 **SQLite 파일 1개**다. 문서 편집기처럼 새로 만들기·열기·다른 이름으로 저장을 한다. Rust `AppState`가 열린 연결 하나만 보관하며, 모든 커맨드는 "열린 파일 없음"을 먼저 확인한다.

| 동작                           | 구현                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| 새로 만들기                    | 위치·파일명 선택 → 빈 DB 생성·스키마 적용 → XLSX 가져오기                                               |
| 열기                           | 대화상자(`*.mix`), 더블클릭, 창에 끌어다 놓기 → 식별·버전 확인 → 필요 시 마이그레이션                   |
| 저장                           | 버튼 없음. 모든 변경은 즉시 트랜잭션으로 기록                                                           |
| 다른 이름으로 저장 / 사본 저장 | `VACUUM INTO` → 일관된 단일 파일 사본. 암호가 걸린 파일이면 사본도 같은 키로 암호화된 채 열린다         |
| 잠금 해제                      | 암호가 걸린 파일은 비밀번호를 넣기 전까지 잠김 상태 — 학생 자료를 읽고 쓰는 커맨드는 모두 `Locked` 오류 |
| 닫기                           | 연결 해제 후 시작 화면. 한 번에 파일 1개                                                                |
| 다른 파일 열기                 | **새 파일을 먼저 연 뒤** 지금 파일을 닫는다 → 열기에 실패하면 지금 파일 유지                            |

파일 설계:

- **단일 파일**: `journal_mode=DELETE`. WAL의 `-wal`/`-shm` 파일이 USB나 메일로 옮길 때 빠지는 것을 막는다.
- **식별**: `PRAGMA application_id = 0x434D4958`('CMIX'). 다른 SQLite 파일은 "ClassMix 파일이 아닙니다"로 거절.
- **버전**: `PRAGMA user_version` = 스키마 버전(현재 1). 이전 버전은 `<이름>.bak.mix` 사본을 만든 뒤 마이그레이션하고, 앱보다 새 버전은 읽기 전용으로 연 뒤 업데이트를 안내한다. 마이그레이션은 `db.rs`의 `MIGRATIONS` 배열로 직접 관리한다(외부 마이그레이션 라이브러리 없음).
- **원본 포함**: 가져온 XLSX·PDF를 `source_file`에 BLOB(+sha256)으로 보관 → `.mix` 하나만 옮겨도 내보내기까지 가능.
- **동시 열기 경고**: 열 때 `meta.opened_by`(호스트 이름)·`opened_at`을 기록하고 닫거나 앱을 끌 때 지운다. 다른 PC 이름이 남아 있으면 경고한다.
- **안전한 쓰기**: 새 작업 파일과 사본(다른 이름으로 저장, 사본 저장)은 같은 폴더의 임시 파일로 만든 뒤 이름을 바꿔서 덮어쓴다 → 실패해도 기존 파일이 지워지지 않는다. 설정 JSON도 임시 파일에 쓴 뒤 이름을 바꿔 저장한다.
- **지운 값 덮어쓰기**: `PRAGMA secure_delete = ON`. 지우거나 바꾼 레코드 자리를 0으로 채워 이전 값이 파일 안에 남지 않게 한다.
- **비밀번호 암호화(선택)**: 아래 [암호화](#암호화) 참고.
- **외부 전송 없음**: 네트워크 기능을 쓰지 않는다. 학생 데이터는 브라우저 저장소에도 넣지 않는다.

### 암호화

`.mix` 파일에는 학생 개인정보가 들어가므로, 파일 메뉴에서 **비밀번호를 걸 수 있다**(기본은 암호화하지 않음). 구현은 `src-tauri/src/crypto.rs`.

| 항목           | 구현                                                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 키 파생        | 비밀번호 → **PBKDF2-HMAC-SHA256**, 반복 600,000회(OWASP 권장값), 16바이트 난수 salt → 256비트 키                                                                |
| 값 암호화      | 민감한 칸을 값마다 **AES-256-GCM**으로 따로 암호화. 값마다 새 96비트 난수 nonce, 저장 형식 `<nonce_b64>:<ciphertext_b64>`(끝에 16바이트 인증 태그 포함)         |
| 위치 묶기      | `표.열#행id`를 추가 인증 데이터(AAD)로 묶는다 → 암호문을 다른 칸으로 옮기거나 다른 학생 행과 맞바꾸면 복호화가 실패한다. 그래서 행을 넣기 전에 id를 먼저 정한다 |
| 비밀번호 확인  | 정해진 문구를 같은 키로 암호화한 확인 토큰(`meta.enc_check`)을 복호화해 본다                                                                                    |
| 키 보관        | 파생한 키는 파일을 연 동안만 메모리에 두고, 닫으면 지운다(`zeroize`). 비밀번호·키는 파일이나 설정에 저장하지 않는다                                             |
| 설정·해제·변경 | 한 트랜잭션에서 모든 대상 칸을 한꺼번에 다시 암호화한다(실패하면 전체 롤백). 변경할 때는 새 salt를 만든다. 이후 `VACUUM`으로 남은 평문 조각을 정리한다          |
| 비밀번호 규칙  | 8자 이상, 공백만으로 된 비밀번호 불가. 변경 시 현재 비밀번호와 달라야 함                                                                                        |

`meta`에 `enc_salt`(base64)·`enc_iterations`·`enc_check`가 있으면 암호가 걸린 파일이고, 모두 NULL이면 평문 파일이다. 반복 횟수를 파일마다 저장하므로 나중에 기본값을 올려도 기존 파일은 그대로 열린다.

**암호화하는 칸**

| 표                | 칸                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `source_file`     | `content`(원본 XLSX·PDF)                                                                          |
| `student`         | 학번, 성명·정규화 성명, 이전·진급 과정/학년, 이전반·이전번호, 생년월일, 기준성적, 메모, 한글 표기 |
| `pdf_row`         | 학년·반·번호, 성명, 생년월일, 기준성적, 이전학적, 특이사항                                        |
| `separation_rule` | `reason`(사유)                                                                                    |
| `number_gap`      | `anchor_key`, `planned_name`(전입 예정 이름)                                                      |
| `change_log`      | `payload`(변경 묶음)                                                                              |

**평문으로 두는 칸**: ID·외래 키, 현재/원래 반·번호 자리, 성별, 규칙 종류·상태 값, 시각, 원본 파일 이름·sha256. 이름만으로는 개인을 알 수 없는 값이고, 번호 중복 검사·정렬을 SQL에서 하기 위해서다.

한계:

- **비밀번호를 잊으면 파일을 다시 열 수 없다.**
- 내보낸 나이스 업로드용 XLSX는 나이스 양식 그대로여야 하므로 **암호화하지 않는다.**
- 파일을 연 동안에는 화면에 복호화된 자료가 표시됩니다. 암호화는 파일이 유출되었을 때를 위한 보호입니다.

### 스키마

전체 정의는 [`src-tauri/src/schema_v1.sql`](../src-tauri/src/schema_v1.sql). 파일 하나가 작업 하나이므로 작업 구분 키는 없다.

| 테이블                                 | 내용                                                                                                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `meta`                                 | 항상 1행. 제목, 대상 학년, 반 수(`class_count`), 앱 버전, 설정 JSON, 열림 표시, 암호화 설정(`enc_salt`·`enc_iterations`·`enc_check`)                                                        |
| `source_file`                          | 원본 XLSX/PDF BLOB(내보내기 템플릿 + 재현성)                                                                                                                                                |
| `student`                              | XLSX 원본 행 번호, 학번(텍스트), 성명·정규화 성명, 이전학적, `orig_*`(나이스 기본 편성), `cur_*`(현재 편성), PDF 값(성별·생년월일·기준성적), 매핑 방법, 메모, 정렬용 한글 표기(`sort_name`) |
| `pdf_row`                              | 파싱된 PDF 원본 행과 매핑 결과(재매핑·검토용)                                                                                                                                               |
| `separation_rule`, `separation_member` | 분리 규칙 4종(`group`/`one_to_many`/`twin`/`same_name`), 자동·수동 출처, 켜기/끄기, 사유                                                                                                    |
| `twin_candidate_dismissed`             | "쌍둥이 아님"으로 넘긴 쌍                                                                                                                                                                   |
| `number_gap`                           | 빈 번호(반, 번호, 위치 기준 키, 전입 예정 이름, 출처)                                                                                                                                       |
| `class_state`                          | 반별 번호 상태: `original`(나이스 번호 그대로) / `sorted`(가나다 재정렬됨)                                                                                                                  |
| `change_log`                           | 변경 묶음 JSON, 순번, 되돌림 여부                                                                                                                                                           |

`base_score`는 **×100 정수**(0.01점 단위, 예: 1,073.89 → 107389)로 저장한다.

---

## 5. 설정과 OS 통합

| 항목             | Windows (우선, 포터블)                                                                                                 | macOS                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 배포물           | `tauri build --no-bundle`(`pnpm build:win`)로 만든 단일 `exe`                                                          | 유니버설 `.dmg`                                                            |
| 런타임           | MSVC C 런타임 정적 링크(`+crt-static`), SQLite 내장                                                                    | 없음                                                                       |
| WebView          | 창을 만들기 전 레지스트리(EdgeUpdate `pv`)로 WebView2 확인, 없으면 안내 상자 + 설치 페이지 열기 후 종료                | WKWebView                                                                  |
| 설정·최근 파일   | exe 옆 `ClassMix.settings.json`, 쓸 수 없으면 앱 데이터 폴더. 경로만 저장(최대 10개)                                   | 앱 데이터 폴더                                                             |
| `.mix` 연결      | [설정 및 정보]에서 `HKCU\Software\Classes`에 등록·해제(관리자 권한 불필요), exe 이동 감지 시 시작 화면에서 재등록 안내 | `.app` 번들 설정으로 자동                                                  |
| 더블클릭 열기    | 실행 인자                                                                                                              | `RunEvent::Opened`                                                         |
| 실행 중 더블클릭 | `tauri-plugin-single-instance`로 기존 창에 경로 전달 → "지금 파일을 닫고 열까요?"                                      | 같음                                                                       |
| 창               | 불투명 창                                                                                                              | 숨은 제목 표시줄 + 각 화면 52px 상단 바 안에 신호등 버튼, 반투명(vibrancy) |

경로 전달 흐름: 실행 인자/`RunEvent::Opened`/single-instance → `AppState.pending_open` 저장 + `open-file-requested` 이벤트 → 화면의 `useOpenRequests`가 `take_launch_file`로 가져가 연다.

---

## 6. 빌드와 CI

`.github/workflows/CI.yml`은 브랜치·태그 푸시와 포크 PR에서 Vitest, Clippy, `cargo test`를 Windows·macOS에서 실행한다. 같은 저장소의 PR 브랜치는 푸시된 커밋을 검사하고, 포크 PR은 GitHub가 만든 병합 커밋을 검사한다. 같은 ref와 이벤트의 새 CI 실행이 들어오면 기존 실행을 취소한다.

`v*` 태그의 푸시는 `.github/workflows/build.yml`에서 CI를 호출한다. 태그가 새로 생성됐고 Windows·macOS 테스트가 모두 통과하면 배포물을 빌드한다. 릴리스 실행은 태그별로 묶고, CI와 다른 그룹 이름을 사용한다.

- **windows portable exe**: 아이콘 생성(`pnpm icons`) → `pnpm build:win` → `dumpbin /dependents`로 VCRUNTIME 의존 여부 검사 → `ClassMix-windows-x64` 아티팩트
- **macos universal dmg**: `ClassMix-macos-universal` 아티팩트
- **github release (draft)**: `v*` 태그에서 Release 초안에 배포물 첨부

코드 서명은 하지 않는다(추후 결정). 서명하지 않은 exe는 SmartScreen 경고가 뜨므로 사용 안내서에 [추가 정보] → [실행] 절차를 적는다.

---

## 7. 테스트

| 종류               | 위치                            | 대상                                                                                                                                                                                                                                        |
| ------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 단위(Vitest)       | `src/domain/*.test.ts`          | 정규화, PDF 행 복원, 매핑 우선순위, 변경 묶음·번호 재부여·빈 번호, 분리 규칙·쌍둥이 후보, 통계                                                                                                                                              |
| 골든               | `src/domain/pdf.golden.test.ts` | `tests/fixtures/sample.pdf` → 기대 결과 JSON 비교, 샘플 쌍둥이 후보                                                                                                                                                                         |
| Rust(`cargo test`) | 각 모듈 `#[cfg(test)]`          | 작업 파일 생성·식별·마이그레이션, `VACUUM INTO`, XLSX 읽기, 변경 이력, 내보내기 왕복, 암호화(테스트 벡터, 잘못된 토큰, `meta` 변조, 행 맞바꾸기 감지, 설정·해제·변경 실패 시 롤백, 암호화 상태의 모든 쓰기 경로, 잠금 확인), 쓰기 실패 주입 |

`tests/fixtures/`의 샘플은 더미 데이터다. 실제 학생 정보가 들어가는 `*.mix`·`*.xlsx`·`*.pdf`는 `.gitignore`로 커밋하지 않는다.
