-- ClassMix 작업 파일(.mix) 스키마 v1
-- 파일 하나가 반편성 1건이므로 작업 구분 키는 없다.

CREATE TABLE meta (                   -- 항상 1행
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  title         TEXT NOT NULL,
  target_grade  TEXT,                 -- XLSX를 가져오면 채워짐. 예) '2학년'
  class_count   INTEGER,              -- XLSX 진급반코드 최댓값
  app_version   TEXT NOT NULL,
  settings      TEXT NOT NULL DEFAULT '{}',
  opened_by     TEXT,
  opened_at     TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE source_file (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('xlsx','pdf')),
  file_name   TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  content     BLOB NOT NULL,
  imported_at TEXT NOT NULL
);

CREATE TABLE student (
  id              INTEGER PRIMARY KEY,
  row_index       INTEGER NOT NULL,
  student_no      TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  name_norm       TEXT NOT NULL,
  prev_course     TEXT,
  prev_grade      TEXT NOT NULL,
  prev_class      INTEGER NOT NULL,
  prev_number     INTEGER NOT NULL,
  next_course     TEXT,
  next_grade      TEXT,
  orig_class      INTEGER NOT NULL,
  orig_number     INTEGER NOT NULL,
  cur_class       INTEGER NOT NULL,
  cur_number      INTEGER NOT NULL,
  gender          TEXT CHECK (gender IN ('남','여')),
  birth_date      TEXT,
  base_score      INTEGER,            -- 기준성적 ×100 정수(0.01점 단위). 예) 1,073.89 → 107389
  match_method    TEXT,
  memo            TEXT,
  sort_name       TEXT
);
CREATE INDEX idx_student_class ON student(cur_class, cur_number);
CREATE INDEX idx_student_name  ON student(name_norm);

CREATE TABLE pdf_row (
  id          INTEGER PRIMARY KEY,
  page        INTEGER,
  grade       TEXT,
  class       INTEGER,
  number      INTEGER,
  name        TEXT,
  birth_date  TEXT,
  gender      TEXT,
  base_score  INTEGER,                 -- 기준성적 ×100 정수
  prev_grade  TEXT,
  prev_class  INTEGER,
  prev_number INTEGER,
  note        TEXT,
  student_id  INTEGER REFERENCES student(id) ON DELETE SET NULL
);

CREATE TABLE separation_rule (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('group','one_to_many','twin','same_name')),
  origin      TEXT NOT NULL CHECK (origin IN ('manual','auto')),
  enabled     INTEGER NOT NULL DEFAULT 1,
  reason      TEXT,
  created_at  TEXT NOT NULL
);
CREATE TABLE separation_member (
  rule_id     INTEGER NOT NULL REFERENCES separation_rule(id) ON DELETE CASCADE,
  student_id  INTEGER NOT NULL REFERENCES student(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('member','leader')),
  PRIMARY KEY (rule_id, student_id)
);

CREATE TABLE twin_candidate_dismissed (
  student_a   INTEGER NOT NULL REFERENCES student(id) ON DELETE CASCADE,
  student_b   INTEGER NOT NULL REFERENCES student(id) ON DELETE CASCADE,
  PRIMARY KEY (student_a, student_b),
  CHECK (student_a < student_b)
);

CREATE TABLE number_gap (
  id            INTEGER PRIMARY KEY,
  class         INTEGER NOT NULL,
  number        INTEGER NOT NULL,
  anchor_key    TEXT NOT NULL,
  planned_name  TEXT,
  origin        TEXT NOT NULL CHECK (origin IN ('manual','import')),
  created_at    TEXT NOT NULL,
  UNIQUE (class, number)
);

CREATE TABLE class_state (
  class         INTEGER PRIMARY KEY,
  numbering     TEXT NOT NULL CHECK (numbering IN ('original','sorted'))
);

CREATE TABLE change_log (
  id          INTEGER PRIMARY KEY,
  seq         INTEGER NOT NULL,
  action      TEXT NOT NULL,
  payload     TEXT NOT NULL,
  undone      INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
