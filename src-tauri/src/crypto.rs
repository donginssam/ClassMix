//! 작업 파일(.mix) 암호화.
//!
//! - 키: 비밀번호에서 PBKDF2-HMAC-SHA256(반복 600,000회)으로 256비트 키를 만든다.
//!   salt·반복 횟수는 `meta`에 두고, 만든 키는 파일을 연 동안만 메모리(`Cipher`)에 둔다(닫으면 지움).
//! - 값: 학생을 알아볼 수 있는 칸을 AES-256-GCM으로 값마다 따로 암호화해
//!   `<nonce_b64>:<ciphertext_b64>`(암호문 끝에 인증 태그 16바이트 포함)로 저장한다.
//!   nonce는 값마다 새로 뽑은 96비트 난수이고, `표.열#행id`를 추가 인증 데이터(AAD)로 묶어
//!   암호문을 다른 칸으로 옮기거나 다른 학생(행)과 맞바꾸면 복호화가 실패한다.
//! - 평문으로 두는 것: ID·연결(외래 키), 반·번호 자리, 성별, 종류·상태 값, 시각. 이름이 없으면
//!   개인을 알 수 없는 값이고, 중복 번호 검사·정렬을 SQL에서 하기 위해서다.
//! - 설정/해제: 한 트랜잭션에서 모든 대상 칸을 한꺼번에 바꾼 뒤 VACUUM 해 지워진 평문 조각이
//!   파일에 남지 않게 한다.

use aes_gcm::Aes256Gcm;
use aes_gcm::aead::{Aead, KeyInit, Nonce, Payload};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use rusqlite::types::Value;
use rusqlite::{Connection, params};
use zeroize::Zeroizing;

use crate::error::{AppError, AppResult};

/// PBKDF2 반복 횟수(OWASP 권장값). 파일마다 meta에 저장하므로 나중에 올려도 기존 파일은 그대로 열린다.
pub const PBKDF2_ROUNDS: u32 = 600_000;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
/// 비밀번호 최소 길이
pub const MIN_PASSWORD_LEN: usize = 8;

const CHECK_AAD: &str = "meta.enc_check";
const CHECK_TEXT: &[u8] = b"ClassMix key check v1";

fn random(buf: &mut [u8]) -> AppResult<()> {
    getrandom::fill(buf).map_err(|e| AppError::Crypto(format!("난수를 만들 수 없습니다: {e}")))
}

/// PBKDF2-HMAC-SHA256 → 256비트 키
fn derive_key(password: &str, salt: &[u8], rounds: u32) -> Zeroizing<[u8; 32]> {
    let mut key = Zeroizing::new([0u8; 32]);
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(password.as_bytes(), salt, rounds, key.as_mut());
    key
}

/// 파일을 연 동안 메모리에 두는 파생 키. 버릴 때 키 내용을 지운다(aes-gcm `zeroize`).
pub struct Cipher {
    aead: Aes256Gcm,
}

impl Cipher {
    /// PBKDF2-HMAC-SHA256으로 키를 만든다.
    pub fn derive(password: &str, salt: &[u8], rounds: u32) -> AppResult<Self> {
        if password.is_empty() {
            return Err(AppError::InvalidInput("비밀번호를 입력해 주세요.".into()));
        }
        let key = derive_key(password, salt, rounds);
        let aead = Aes256Gcm::new_from_slice(key.as_ref())
            .map_err(|e| AppError::Crypto(format!("키 길이 오류: {e}")))?;
        Ok(Self { aead })
    }

    /// `<nonce_b64>:<ciphertext_b64>`
    pub fn encrypt(&self, aad: &str, plain: &[u8]) -> AppResult<String> {
        let mut nonce = [0u8; NONCE_LEN];
        random(&mut nonce)?;
        let ct = self
            .aead
            .encrypt(
                &Nonce::<Aes256Gcm>::from(nonce),
                Payload {
                    msg: plain,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| AppError::Crypto("암호화하지 못했습니다.".into()))?;
        Ok(format!("{}:{}", B64.encode(nonce), B64.encode(ct)))
    }

    pub fn decrypt(&self, aad: &str, token: &str) -> AppResult<Zeroizing<Vec<u8>>> {
        let bad = || {
            AppError::Crypto(format!(
                "{aad} 값을 복호화할 수 없습니다(손상되었거나 다른 키)."
            ))
        };
        let (n, c) = token.split_once(':').ok_or_else(bad)?;
        let nonce: [u8; NONCE_LEN] = B64
            .decode(n)
            .map_err(|_| bad())?
            .try_into()
            .map_err(|_| bad())?;
        let ct = B64.decode(c).map_err(|_| bad())?;
        let plain = self
            .aead
            .decrypt(
                &Nonce::<Aes256Gcm>::from(nonce),
                Payload {
                    msg: &ct,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| bad())?;
        Ok(Zeroizing::new(plain))
    }

    /// 비밀번호 확인용 토큰(meta.enc_check)
    fn check_token(&self) -> AppResult<String> {
        self.encrypt(CHECK_AAD, CHECK_TEXT)
    }

    fn verify(&self, token: &str) -> bool {
        self.decrypt(CHECK_AAD, token)
            .map(|p| p.as_slice() == CHECK_TEXT)
            .unwrap_or(false)
    }
}

// ───────────── 칸 단위 부호화 ─────────────

/// 민감한 칸을 읽고 쓸 때 거치는 부호기. 암호화하지 않은 파일이면 값을 그대로 둔다.
#[derive(Clone, Copy)]
pub struct Codec<'a>(pub Option<&'a Cipher>);

pub const PLAIN: Codec<'static> = Codec(None);

fn type_err(aad: &str) -> AppError {
    AppError::Crypto(format!("{aad} 값의 형식이 예상과 다릅니다."))
}

/// 칸 하나의 AAD: `표.열#행id`. 행 id까지 묶어 같은 칸끼리 다른 행과 맞바꾸는 것도 막는다.
pub fn aad(col: &str, id: i64) -> String {
    format!("{col}#{id}")
}

impl Codec<'_> {
    pub fn text(&self, col: &str, id: i64, v: &str) -> AppResult<Value> {
        match self.0 {
            Some(c) => Ok(Value::Text(c.encrypt(&aad(col, id), v.as_bytes())?)),
            None => Ok(Value::Text(v.to_string())),
        }
    }

    pub fn opt_text(&self, col: &str, id: i64, v: Option<&str>) -> AppResult<Value> {
        v.map_or(Ok(Value::Null), |v| self.text(col, id, v))
    }

    pub fn int(&self, col: &str, id: i64, v: i64) -> AppResult<Value> {
        match self.0 {
            Some(c) => Ok(Value::Text(
                c.encrypt(&aad(col, id), v.to_string().as_bytes())?,
            )),
            None => Ok(Value::Integer(v)),
        }
    }

    pub fn opt_int(&self, col: &str, id: i64, v: Option<i64>) -> AppResult<Value> {
        v.map_or(Ok(Value::Null), |v| self.int(col, id, v))
    }

    pub fn blob(&self, col: &str, id: i64, v: &[u8]) -> AppResult<Value> {
        match self.0 {
            Some(c) => Ok(Value::Text(c.encrypt(&aad(col, id), v)?)),
            None => Ok(Value::Blob(v.to_vec())),
        }
    }

    /// 암호화된 값이면 풀어서 바이트로. NULL이면 None.
    fn open(&self, col: &str, id: i64, v: Value) -> AppResult<Option<Opened>> {
        match (self.0, v) {
            (_, Value::Null) => Ok(None),
            (Some(c), Value::Text(t)) => Ok(Some(Opened::Bytes(c.decrypt(&aad(col, id), &t)?))),
            (Some(_), _) => Err(type_err(col)),
            (None, v) => Ok(Some(Opened::Plain(v))),
        }
    }

    pub fn get_opt_text(&self, col: &str, id: i64, v: Value) -> AppResult<Option<String>> {
        match self.open(col, id, v)? {
            None => Ok(None),
            Some(Opened::Bytes(b)) => String::from_utf8(b.to_vec())
                .map(Some)
                .map_err(|_| type_err(col)),
            Some(Opened::Plain(Value::Text(t))) => Ok(Some(t)),
            Some(Opened::Plain(_)) => Err(type_err(col)),
        }
    }

    pub fn get_text(&self, col: &str, id: i64, v: Value) -> AppResult<String> {
        self.get_opt_text(col, id, v)?.ok_or_else(|| type_err(col))
    }

    pub fn get_opt_int(&self, col: &str, id: i64, v: Value) -> AppResult<Option<i64>> {
        match self.open(col, id, v)? {
            None => Ok(None),
            Some(Opened::Bytes(b)) => std::str::from_utf8(&b)
                .ok()
                .and_then(|s| s.parse().ok())
                .map(Some)
                .ok_or_else(|| type_err(col)),
            Some(Opened::Plain(Value::Integer(i))) => Ok(Some(i)),
            Some(Opened::Plain(_)) => Err(type_err(col)),
        }
    }

    pub fn get_int(&self, col: &str, id: i64, v: Value) -> AppResult<i64> {
        self.get_opt_int(col, id, v)?.ok_or_else(|| type_err(col))
    }

    pub fn get_blob(&self, col: &str, id: i64, v: Value) -> AppResult<Vec<u8>> {
        match self.open(col, id, v)? {
            Some(Opened::Bytes(b)) => Ok(b.to_vec()),
            Some(Opened::Plain(Value::Blob(b))) => Ok(b),
            _ => Err(type_err(col)),
        }
    }
}

enum Opened {
    Bytes(Zeroizing<Vec<u8>>),
    Plain(Value),
}

// ───────────── 암호화 대상 칸 ─────────────

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Text,
    Int,
    Blob,
}

/// 암호화하는 칸(표, [(열, 종류)]). AAD는 `표.열#행id`. 모든 표에 `id` 기본 키가 있다.
const ENCRYPTED: &[(&str, &[(&str, Kind)])] = &[
    ("source_file", &[("content", Kind::Blob)]),
    (
        "student",
        &[
            ("student_no", Kind::Text),
            ("name", Kind::Text),
            ("name_norm", Kind::Text),
            ("prev_course", Kind::Text),
            ("prev_grade", Kind::Text),
            ("prev_class", Kind::Int),
            ("prev_number", Kind::Int),
            ("next_course", Kind::Text),
            ("next_grade", Kind::Text),
            ("birth_date", Kind::Text),
            ("base_score", Kind::Int),
            ("memo", Kind::Text),
            ("sort_name", Kind::Text),
        ],
    ),
    (
        "pdf_row",
        &[
            ("grade", Kind::Text),
            ("class", Kind::Int),
            ("number", Kind::Int),
            ("name", Kind::Text),
            ("birth_date", Kind::Text),
            ("base_score", Kind::Int),
            ("prev_grade", Kind::Text),
            ("prev_class", Kind::Int),
            ("prev_number", Kind::Int),
            ("note", Kind::Text),
        ],
    ),
    ("separation_rule", &[("reason", Kind::Text)]),
    (
        "number_gap",
        &[("anchor_key", Kind::Text), ("planned_name", Kind::Text)],
    ),
    ("change_log", &[("payload", Kind::Text)]),
];

/// 표의 모든 대상 칸을 `from` 부호에서 `to` 부호로 바꿔 쓴다.
fn recode_all(conn: &Connection, from: Codec, to: Codec) -> AppResult<()> {
    for (table, cols) in ENCRYPTED {
        let names: Vec<&str> = cols.iter().map(|(c, _)| *c).collect();
        let select = format!("SELECT id, {} FROM {table}", names.join(", "));
        let mut rows_data: Vec<(i64, Vec<Value>)> = Vec::new();
        {
            let mut stmt = conn.prepare(&select)?;
            let mut rows = stmt.query([])?;
            while let Some(r) = rows.next()? {
                let id: i64 = r.get(0)?;
                let vals = (0..cols.len())
                    .map(|i| r.get::<_, Value>(i + 1))
                    .collect::<Result<Vec<_>, _>>()?;
                rows_data.push((id, vals));
            }
        }
        let sets: Vec<String> = names
            .iter()
            .enumerate()
            .map(|(i, c)| format!("{c} = ?{}", i + 1))
            .collect();
        let update = format!(
            "UPDATE {table} SET {} WHERE id = ?{}",
            sets.join(", "),
            cols.len() + 1
        );
        let mut stmt = conn.prepare(&update)?;
        for (id, vals) in rows_data {
            let mut out: Vec<Value> = Vec::with_capacity(cols.len() + 1);
            for ((col, kind), v) in cols.iter().zip(vals) {
                let c = format!("{table}.{col}");
                out.push(match kind {
                    Kind::Text => to.opt_text(&c, id, from.get_opt_text(&c, id, v)?.as_deref())?,
                    Kind::Int => to.opt_int(&c, id, from.get_opt_int(&c, id, v)?)?,
                    Kind::Blob => match v {
                        Value::Null => Value::Null,
                        v => to.blob(&c, id, &from.get_blob(&c, id, v)?)?,
                    },
                });
            }
            out.push(Value::Integer(id));
            stmt.execute(rusqlite::params_from_iter(out))?;
        }
    }
    Ok(())
}

// ───────────── 파일 단위 동작 ─────────────

/// meta에 저장된 암호화 설정. 암호화하지 않은 파일이면 None.
pub struct Header {
    salt: Vec<u8>,
    rounds: u32,
    check: String,
}

pub fn header(conn: &Connection) -> AppResult<Option<Header>> {
    let (salt, rounds, check): (Option<String>, Option<i64>, Option<String>) = conn.query_row(
        "SELECT enc_salt, enc_iterations, enc_check FROM meta WHERE id = 1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    match (salt, rounds, check) {
        (None, None, None) => Ok(None),
        (Some(s), Some(n), Some(c)) => Ok(Some(Header {
            salt: B64
                .decode(s)
                .map_err(|_| AppError::Crypto("salt 형식 오류".into()))?,
            rounds: u32::try_from(n)
                .ok()
                .filter(|n| *n > 0)
                .ok_or_else(|| AppError::Crypto("반복 횟수 오류".into()))?,
            check: c,
        })),
        _ => Err(AppError::Crypto("암호화 설정이 손상되었습니다.".into())),
    }
}

/// 비밀번호로 키를 만들고 확인한다. 키 계산은 수백 밀리초가 걸리므로 DB 잠금 밖에서 부른다.
pub fn unlock(header: &Header, password: &str) -> AppResult<Cipher> {
    let cipher = Cipher::derive(password, &header.salt, header.rounds)?;
    if cipher.verify(&header.check) {
        Ok(cipher)
    } else {
        Err(AppError::WrongPassword)
    }
}

/// 새 salt로 키를 만든다(암호화 켜기 전, DB 잠금 밖에서).
pub fn prepare_new_key(password: &str) -> AppResult<(Vec<u8>, Cipher)> {
    if password.chars().count() < MIN_PASSWORD_LEN {
        return Err(AppError::InvalidInput(format!(
            "비밀번호는 {MIN_PASSWORD_LEN}자 이상이어야 합니다."
        )));
    }
    if password.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "공백만으로 된 비밀번호는 쓸 수 없습니다.".into(),
        ));
    }
    let mut salt = vec![0u8; SALT_LEN];
    random(&mut salt)?;
    let cipher = Cipher::derive(password, &salt, PBKDF2_ROUNDS)?;
    Ok((salt, cipher))
}

/// 커밋을 마친 뒤 파일을 다시 써서(VACUUM) 지워진 옛 값 조각을 없앤다.
/// 자료는 이미 커밋되어 일관된 상태이고 `secure_delete`로 덮어쓴 자리도 0으로 채워졌으므로,
/// 여기서 실패해도(예: 디스크 공간 부족) 동작 자체는 성공으로 본다. 실패를 오류로 돌려주면
/// 파일은 바뀌었는데 화면 쪽 상태(암호 여부·키)는 그대로 남아 서로 어긋난다.
fn vacuum_after_commit(conn: &Connection) {
    #[cfg(test)]
    if tests::FAIL_VACUUM.with(|f| f.get()) {
        eprintln!("[ClassMix] VACUUM 실패(시험용으로 일부러 실패시킴, 자료는 이미 저장됨)");
        return;
    }
    if let Err(e) = conn.execute_batch("VACUUM") {
        eprintln!("[ClassMix] VACUUM 실패(자료는 이미 저장됨): {e}");
    }
}

/// 암호화 켜기: 모든 대상 칸을 한꺼번에 암호화하고 salt·확인 토큰을 meta에 남긴 뒤 VACUUM.
pub fn enable(conn: &mut Connection, salt: &[u8], cipher: &Cipher) -> AppResult<()> {
    if header(conn)?.is_some() {
        return Err(AppError::InvalidInput("이미 암호가 걸려 있습니다.".into()));
    }
    let tx = conn.transaction()?;
    recode_all(&tx, PLAIN, Codec(Some(cipher)))?;
    tx.execute(
        "UPDATE meta SET enc_salt = ?1, enc_iterations = ?2, enc_check = ?3 WHERE id = 1",
        params![B64.encode(salt), PBKDF2_ROUNDS, cipher.check_token()?],
    )?;
    tx.commit()?;
    vacuum_after_commit(conn);
    Ok(())
}

/// 암호화 끄기: 모든 대상 칸을 한꺼번에 풀고 meta의 암호 설정을 지운다.
pub fn disable(conn: &mut Connection, cipher: &Cipher) -> AppResult<()> {
    let Some(h) = header(conn)? else {
        return Err(AppError::InvalidInput("암호가 걸려 있지 않습니다.".into()));
    };
    if !cipher.verify(&h.check) {
        return Err(AppError::WrongPassword);
    }
    let tx = conn.transaction()?;
    recode_all(&tx, Codec(Some(cipher)), PLAIN)?;
    tx.execute(
        "UPDATE meta SET enc_salt = NULL, enc_iterations = NULL, enc_check = NULL WHERE id = 1",
        [],
    )?;
    tx.commit()?;
    vacuum_after_commit(conn);
    Ok(())
}

/// 암호 변경: 지금 키를 확인한 뒤, 새 salt로 만든 새 키로 모든 대상 칸을 한꺼번에 다시 암호화하고
/// meta의 salt·반복 횟수·확인 토큰을 바꾼다. 실패하면 아무것도 바뀌지 않는다.
pub fn change_password(
    conn: &mut Connection,
    current: &Cipher,
    new_salt: &[u8],
    new_cipher: &Cipher,
) -> AppResult<()> {
    let Some(h) = header(conn)? else {
        return Err(AppError::InvalidInput("암호가 걸려 있지 않습니다.".into()));
    };
    if !current.verify(&h.check) {
        return Err(AppError::WrongPassword);
    }
    let tx = conn.transaction()?;
    recode_all(&tx, Codec(Some(current)), Codec(Some(new_cipher)))?;
    tx.execute(
        "UPDATE meta SET enc_salt = ?1, enc_iterations = ?2, enc_check = ?3 WHERE id = 1",
        params![
            B64.encode(new_salt),
            PBKDF2_ROUNDS,
            new_cipher.check_token()?
        ],
    )?;
    tx.commit()?;
    vacuum_after_commit(conn);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    thread_local! {
        /// 시험용: 커밋 뒤 VACUUM 단계가 실패한 것처럼 만든다(이 스레드에서만).
        pub(super) static FAIL_VACUUM: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    }
    use crate::board::{self, NewRule, RuleMember};
    use crate::changes::{
        self, ChangeSet, ClassGaps, GapRow, NumberingChange, ReadingChange, Seat, StudentMove,
    };
    use crate::export;
    use crate::roster::{self, PdfLink, PdfRowInput};
    use crate::xlsx_import::{apply_import, parse_roster, plan_import};
    use std::path::{Path, PathBuf};

    const PASSWORD: &str = "교무실-비밀번호-2026";

    fn fixture() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/sample.xlsx")
    }

    fn is_token(s: &str) -> bool {
        let Some((n, c)) = s.split_once(':') else {
            return false;
        };
        matches!(B64.decode(n), Ok(v) if v.len() == NONCE_LEN)
            && matches!(B64.decode(c), Ok(v) if v.len() >= 16)
    }

    // ───── 암호 기본 동작 ─────

    #[test]
    fn pbkdf2_matches_published_vectors() {
        // PBKDF2-HMAC-SHA256 공개 테스트 벡터(P="password", S="salt", dkLen=32)
        let hex = |k: &[u8; 32]| k.iter().map(|b| format!("{b:02x}")).collect::<String>();
        assert_eq!(
            hex(&derive_key("password", b"salt", 1)),
            "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b"
        );
        assert_eq!(
            hex(&derive_key("password", b"salt", 4096)),
            "c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a"
        );
    }

    #[test]
    fn token_format_round_trip_and_fresh_nonce() {
        let c = Cipher::derive(PASSWORD, b"0123456789abcdef", 1000).unwrap();
        let plain = "갈매기".as_bytes();
        let t1 = c.encrypt("student.name", plain).unwrap();
        let t2 = c.encrypt("student.name", plain).unwrap();
        // <nonce_b64>:<ciphertext_b64>, 암호문 = 평문 + 태그 16바이트
        assert!(is_token(&t1));
        let (n, ct) = t1.split_once(':').unwrap();
        assert_eq!(B64.decode(n).unwrap().len(), 12);
        assert_eq!(B64.decode(ct).unwrap().len(), plain.len() + 16);
        assert_ne!(t1, t2, "값마다 새 nonce를 써야 한다");
        assert_eq!(c.decrypt("student.name", &t1).unwrap().as_slice(), plain);
        assert_eq!(c.decrypt("student.name", &t2).unwrap().as_slice(), plain);
    }

    #[test]
    fn rejects_wrong_key_tampering_column_swap_and_garbage() {
        let salt = b"0123456789abcdef";
        let c = Cipher::derive(PASSWORD, salt, 1000).unwrap();
        let other = Cipher::derive("다른-비밀번호", salt, 1000).unwrap();
        let t = c.encrypt("student.name", b"GRACE BRIAR").unwrap();
        assert!(other.decrypt("student.name", &t).is_err(), "다른 키");
        assert!(c.decrypt("student.memo", &t).is_err(), "다른 칸(AAD)");
        let (n, ct) = t.split_once(':').unwrap();
        let mut bytes = B64.decode(ct).unwrap();
        bytes[0] ^= 1;
        let tampered = format!("{n}:{}", B64.encode(bytes));
        assert!(c.decrypt("student.name", &tampered).is_err(), "변조");
        for bad in ["", "abc", "a:b", ":", "갈매기"] {
            assert!(c.decrypt("student.name", bad).is_err(), "{bad}");
        }
        // 비밀번호 확인 토큰
        let check = c.check_token().unwrap();
        assert!(c.verify(&check));
        assert!(!other.verify(&check));
    }

    #[test]
    fn new_key_requires_minimum_length() {
        assert!(prepare_new_key("짧은비번").is_err());
        assert!(Cipher::derive("", b"salt", 1).is_err());
    }

    // ───── 작업 파일 전체 ─────

    /// 샘플 XLSX를 가져오고 암호화 대상 칸을 모두 채운 작업 파일
    fn populated_file() -> (tempfile::TempDir, PathBuf, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("암호 테스트.mix");
        let mut conn = crate::db::create_new(&path, "t").unwrap();
        let plan = plan_import("sample.xlsx", parse_roster(&fixture()).unwrap()).unwrap();
        apply_import(
            &mut conn,
            PLAIN,
            "sample.xlsx",
            &std::fs::read(fixture()).unwrap(),
            &plan,
        )
        .unwrap();
        let students = roster::list_students(&conn, PLAIN).unwrap();
        let grace = students.iter().find(|s| s.name == "GRACE BRIAR").unwrap();
        let first = &students[0];

        // PDF 반영(성별·생년월일·기준성적 + pdf_row + 원본 PDF)
        let rows = vec![PdfRowInput {
            page: 1,
            grade: "2학년".into(),
            class: first.cur_class,
            number: first.cur_number,
            name: first.name.clone(),
            birth_date: Some("2012-01-31".into()),
            gender: Some("여".into()),
            base_score: Some(107_389),
            prev_grade: Some("1학년".into()),
            prev_class: Some(first.prev_class),
            prev_number: Some(first.prev_number),
            note: Some("특이사항 메모".into()),
        }];
        let links = vec![PdfLink {
            row_index: 0,
            student_id: first.id,
            method: "next_seat+name".into(),
        }];
        roster::apply_pdf(
            &mut conn,
            PLAIN,
            "sample.pdf",
            b"%PDF-1.6 sample",
            &rows,
            &links,
        )
        .unwrap();
        // 메모, 분리 규칙 사유, 한글 표기 + 빈 번호(예정 이름) + 이동 → 변경 이력
        board::set_memo(&conn, PLAIN, first.id, Some("상담 기록 있음".into())).unwrap();
        board::create_rule(
            &mut conn,
            PLAIN,
            &NewRule {
                kind: "group".into(),
                reason: Some("학부모 요청".into()),
                members: vec![
                    RuleMember {
                        student_id: students[1].id,
                        role: "member".into(),
                    },
                    RuleMember {
                        student_id: students[2].id,
                        role: "member".into(),
                    },
                ],
            },
        )
        .unwrap();
        changes::apply_change(
            &mut conn,
            PLAIN,
            &ChangeSet {
                action: "set_reading".into(),
                label: "GRACE BRIAR 한글 표기".into(),
                students: vec![],
                gaps: vec![],
                numbering: vec![],
                readings: vec![ReadingChange {
                    student_id: grace.id,
                    from: None,
                    to: Some("그레이스브라이어".into()),
                }],
            },
        )
        .unwrap();
        let last = students
            .iter()
            .filter(|s| s.cur_class == 1)
            .max_by_key(|s| s.cur_number)
            .unwrap();
        changes::apply_change(
            &mut conn,
            PLAIN,
            &ChangeSet {
                action: "gap_add".into(),
                label: format!("1반 {} 뒤 빈 번호", last.name_norm),
                students: vec![],
                gaps: vec![ClassGaps {
                    class: 1,
                    before: vec![],
                    after: vec![GapRow {
                        number: last.cur_number + 1,
                        anchor_key: last.name_norm.clone(),
                        planned_name: Some("전입예정이".into()),
                        origin: "manual".into(),
                        created_at: None,
                    }],
                }],
                numbering: vec![],
                readings: vec![],
            },
        )
        .unwrap();
        (dir, path, conn)
    }

    fn move_change(conn: &Connection, codec: Codec) -> ChangeSet {
        let s = roster::list_students(conn, codec).unwrap();
        let st = s.iter().find(|x| x.cur_class == 2).unwrap();
        ChangeSet {
            action: "move".into(),
            label: format!("{} 2반 → 3반", st.name_norm),
            students: vec![StudentMove {
                student_id: st.id,
                from: Seat {
                    c: 2,
                    n: st.cur_number,
                },
                to: Seat { c: 3, n: 99 },
            }],
            gaps: vec![],
            numbering: vec![NumberingChange {
                class: 3,
                from: "original".into(),
                to: "sorted".into(),
            }],
            readings: vec![],
        }
    }

    fn snapshot(conn: &Connection, codec: Codec) -> serde_json::Value {
        serde_json::to_value(board::board_data(conn, codec).unwrap()).unwrap()
    }

    /// 암호화 대상 칸에 평문이 하나도 없는지(NULL이 아닌 값은 모두 토큰)
    fn assert_all_tokens(conn: &Connection) {
        for (table, cols) in ENCRYPTED {
            for (col, _) in *cols {
                let mut stmt = conn
                    .prepare(&format!(
                        "SELECT {col} FROM {table} WHERE {col} IS NOT NULL"
                    ))
                    .unwrap();
                let vals: Vec<Value> = stmt
                    .query_map([], |r| r.get(0))
                    .unwrap()
                    .collect::<Result<_, _>>()
                    .unwrap();
                assert!(
                    !vals.is_empty() || *table == "pdf_row",
                    "{table}.{col} 비어 있음"
                );
                for v in vals {
                    assert!(
                        matches!(&v, Value::Text(t) if is_token(t)),
                        "{table}.{col}: {v:?}"
                    );
                }
            }
        }
    }

    fn file_contains(path: &Path, needle: &[u8]) -> bool {
        let bytes = std::fs::read(path).unwrap();
        bytes.windows(needle.len()).any(|w| w == needle)
    }

    #[test]
    fn enable_encrypts_everything_and_disable_restores_it() {
        let (_d, path, mut conn) = populated_file();
        let before = snapshot(&conn, PLAIN);
        // 평문 상태에서는 파일 안에 이름이 보인다(비교 기준)
        assert!(file_contains(&path, "GRACE BRIAR".as_bytes()));
        assert!(file_contains(&path, "상담 기록 있음".as_bytes()));

        let (salt, cipher) = prepare_new_key(PASSWORD).unwrap();
        enable(&mut conn, &salt, &cipher).unwrap();

        // 1) 모든 대상 칸이 <nonce_b64>:<ciphertext_b64>
        assert_all_tokens(&conn);
        // 2) 파일 바이트 어디에도 평문 개인정보가 남지 않는다(VACUUM·secure_delete)
        let first = before["students"][0].clone();
        for needle in [
            "GRACE BRIAR",
            "그레이스브라이어",
            "상담 기록 있음",
            "학부모 요청",
            "전입예정이",
            "특이사항 메모",
            first["name"].as_str().unwrap(),
            first["studentNo"].as_str().unwrap(),
            "2012-01-31",
            "[Content_Types].xml", // 원본 XLSX(zip) 안의 파일 이름
            "%PDF-1.6",
        ] {
            assert!(
                !file_contains(&path, needle.as_bytes()),
                "파일에 평문이 남음: {needle}"
            );
        }
        // 3) 자리·ID는 평문 그대로(중복 검사·정렬용)
        let seat: (i64, i64) = conn
            .query_row(
                "SELECT cur_class, cur_number FROM student ORDER BY id LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(seat.0 >= 1 && seat.1 >= 1);
        // 성별도 평문(통계용, 암호화 대상 아님)
        let genders: Vec<String> = conn
            .prepare("SELECT gender FROM student WHERE gender IS NOT NULL UNION SELECT gender FROM pdf_row WHERE gender IS NOT NULL")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(genders, vec!["여".to_string()]);
        // 4) salt·반복 횟수·확인 토큰이 meta에
        let h = header(&conn).unwrap().unwrap();
        assert_eq!((h.salt.len(), h.rounds), (SALT_LEN, PBKDF2_ROUNDS));
        assert_eq!(h.salt, salt);
        assert!(is_token(&h.check));
        // 5) 키로 읽으면 암호화 전과 완전히 같다. 키 없이는 읽을 수 없다.
        assert_eq!(snapshot(&conn, Codec(Some(&cipher))), before);
        assert!(board::board_data(&conn, PLAIN).is_err());

        // 6) 끄기 → 평문 복원, meta 정리, 결과 동일
        disable(&mut conn, &cipher).unwrap();
        assert!(header(&conn).unwrap().is_none());
        assert_eq!(snapshot(&conn, PLAIN), before);
        let name: String = conn
            .query_row(
                "SELECT name FROM student WHERE name = 'GRACE BRIAR'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(name, "GRACE BRIAR");
        let blob: Vec<u8> = conn
            .query_row(
                "SELECT content FROM source_file WHERE kind = 'xlsx'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(blob, std::fs::read(fixture()).unwrap());
    }

    #[test]
    fn work_continues_while_encrypted_and_reopens_with_password() {
        let (_d, path, mut conn) = populated_file();
        let (salt, cipher) = prepare_new_key(PASSWORD).unwrap();
        enable(&mut conn, &salt, &cipher).unwrap();
        let codec = Codec(Some(&cipher));

        // 암호화된 상태에서 이동·되돌리기·다시 실행·이력·메모·내보내기
        let cs = move_change(&conn, codec);
        changes::apply_change(&mut conn, codec, &cs).unwrap();
        assert_eq!(
            changes::undo(&mut conn, codec).unwrap().as_deref(),
            Some(cs.label.as_str())
        );
        assert_eq!(
            changes::redo(&mut conn, codec).unwrap().as_deref(),
            Some(cs.label.as_str())
        );
        board::set_memo(&conn, codec, 1, Some("암호화 뒤 메모".into())).unwrap();
        let hist = changes::history(&conn, codec, 10).unwrap();
        assert_eq!(hist[0].label, cs.label);
        assert_all_tokens(&conn);
        let after_ops = snapshot(&conn, codec);
        let out_enc = _d.path().join("enc.xlsx");
        export::export_xlsx(&conn, codec, &out_enc).unwrap();
        drop(conn);

        // 다시 열기: 잘못된 비밀번호는 거절, 맞으면 같은 내용
        let (conn, _) = crate::db::open_existing(&path).unwrap();
        let h = header(&conn).unwrap().unwrap();
        assert!(matches!(
            unlock(&h, "틀린-비밀번호-입니다"),
            Err(AppError::WrongPassword)
        ));
        let reopened = unlock(&h, PASSWORD).unwrap();
        assert_eq!(snapshot(&conn, Codec(Some(&reopened))), after_ops);

        // 암호를 풀고 내보낸 결과와 암호화 상태에서 내보낸 결과가 같다
        let mut conn = conn;
        disable(&mut conn, &reopened).unwrap();
        let out_plain = _d.path().join("plain.xlsx");
        export::export_xlsx(&conn, PLAIN, &out_plain).unwrap();
        let rows = |p: &Path| {
            parse_roster(p)
                .unwrap()
                .into_iter()
                .map(|r| (r.student_no, r.name, r.next_class, r.next_number))
                .collect::<Vec<_>>()
        };
        assert_eq!(rows(&out_enc), rows(&out_plain));
    }

    #[test]
    fn refuses_double_enable_wrong_password_disable_and_plain_disable() {
        let (_d, _p, mut conn) = populated_file();
        let plain_cipher = Cipher::derive(PASSWORD, b"0123456789abcdef", 1000).unwrap();
        assert!(
            disable(&mut conn, &plain_cipher).is_err(),
            "암호가 없는 파일"
        );

        let (salt, cipher) = prepare_new_key(PASSWORD).unwrap();
        enable(&mut conn, &salt, &cipher).unwrap();
        assert!(enable(&mut conn, &salt, &cipher).is_err(), "두 번 켜기");
        let wrong = Cipher::derive("다른-비밀번호-입니다", &salt, PBKDF2_ROUNDS).unwrap();
        assert!(matches!(
            disable(&mut conn, &wrong),
            Err(AppError::WrongPassword)
        ));
        // 실패한 끄기는 아무것도 바꾸지 않는다
        assert_all_tokens(&conn);
        assert!(header(&conn).unwrap().is_some());
    }

    #[test]
    fn change_password_reencrypts_everything_with_a_new_key() {
        const NEW: &str = "새-비밀번호-2027";
        let (_d, path, mut conn) = populated_file();
        let before = snapshot(&conn, PLAIN);
        let (salt, old) = prepare_new_key(PASSWORD).unwrap();
        enable(&mut conn, &salt, &old).unwrap();
        let old_name: String = conn
            .query_row("SELECT name FROM student ORDER BY id LIMIT 1", [], |r| {
                r.get(0)
            })
            .unwrap();

        let (new_salt, new) = prepare_new_key(NEW).unwrap();
        change_password(&mut conn, &old, &new_salt, &new).unwrap();

        // 새 salt, 모든 칸이 새 키의 토큰, 내용은 그대로
        let h = header(&conn).unwrap().unwrap();
        assert_eq!(h.salt, new_salt);
        assert_ne!(h.salt, salt);
        assert_all_tokens(&conn);
        assert_eq!(snapshot(&conn, Codec(Some(&new))), before);
        // 옛 키로는 아무것도 풀 수 없고, 옛 암호문도 남아 있지 않다
        assert!(board::board_data(&conn, Codec(Some(&old))).is_err());
        let new_name: String = conn
            .query_row("SELECT name FROM student ORDER BY id LIMIT 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_ne!(new_name, old_name);
        assert!(!file_contains(&path, old_name.as_bytes()));
        assert!(!file_contains(&path, "GRACE BRIAR".as_bytes()));

        // 다시 열면 옛 비밀번호는 거절, 새 비밀번호로 열린다
        drop(conn);
        let (conn, _) = crate::db::open_existing(&path).unwrap();
        let h = header(&conn).unwrap().unwrap();
        assert!(matches!(unlock(&h, PASSWORD), Err(AppError::WrongPassword)));
        let reopened = unlock(&h, NEW).unwrap();
        assert_eq!(snapshot(&conn, Codec(Some(&reopened))), before);
    }

    #[test]
    fn history_cache_never_outlives_an_encryption_change() {
        let (_d, _path, mut conn) = populated_file();
        let cs = move_change(&conn, PLAIN);
        changes::apply_change(&mut conn, PLAIN, &cs).unwrap();
        let mut cache = changes::HistoryCache::default();
        let plain = changes::history_cached(&conn, PLAIN, 300, &mut cache).unwrap();
        assert!(!plain.is_empty());
        let json = |h: &[changes::HistoryEntry]| serde_json::to_value(h).unwrap();

        let (salt, old) = prepare_new_key(PASSWORD).unwrap();
        enable(&mut conn, &salt, &old).unwrap();
        // 평문 때 채운 캐시가 남아 있어도, 저장된 값이 바뀌었으므로 다시 풀어서 같은 내용을 낸다
        let enc = changes::history_cached(&conn, Codec(Some(&old)), 300, &mut cache).unwrap();
        assert_eq!(json(&enc), json(&plain));

        let (new_salt, new) = prepare_new_key("새-비밀번호-2027").unwrap();
        change_password(&mut conn, &old, &new_salt, &new).unwrap();
        // 옛 키로는 캐시가 있어도 읽을 수 없다(캐시가 복호화 검사를 건너뛰지 않음)
        assert!(changes::history_cached(&conn, Codec(Some(&old)), 300, &mut cache).is_err());
        let mut cache = changes::HistoryCache::default();
        let first = changes::history_cached(&conn, Codec(Some(&new)), 300, &mut cache).unwrap();
        let again = changes::history_cached(&conn, Codec(Some(&new)), 300, &mut cache).unwrap();
        assert_eq!(json(&first), json(&plain));
        assert_eq!(json(&again), json(&plain));
    }

    #[test]
    fn change_password_refuses_wrong_current_or_plain_file() {
        let (_d, _p, mut conn) = populated_file();
        let (new_salt, new) = prepare_new_key("새-비밀번호-2027").unwrap();
        let any = Cipher::derive(PASSWORD, b"0123456789abcdef", 1000).unwrap();
        assert!(
            change_password(&mut conn, &any, &new_salt, &new).is_err(),
            "암호 없는 파일"
        );

        let (salt, cipher) = prepare_new_key(PASSWORD).unwrap();
        enable(&mut conn, &salt, &cipher).unwrap();
        let before = snapshot(&conn, Codec(Some(&cipher)));
        let wrong = Cipher::derive("틀린-비밀번호-입니다", &salt, PBKDF2_ROUNDS).unwrap();
        assert!(matches!(
            change_password(&mut conn, &wrong, &new_salt, &new),
            Err(AppError::WrongPassword)
        ));
        // 아무것도 바뀌지 않았다: 옛 키 그대로 열리고 salt도 그대로
        assert_eq!(header(&conn).unwrap().unwrap().salt, salt);
        assert_eq!(snapshot(&conn, Codec(Some(&cipher))), before);
    }

    #[test]
    fn import_into_an_already_encrypted_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        let plain_file = dir.path().join("plain.mix");
        let enc_file = dir.path().join("enc.mix");
        let bytes = std::fs::read(fixture()).unwrap();
        let plan = || plan_import("sample.xlsx", parse_roster(&fixture()).unwrap()).unwrap();

        let mut a = crate::db::create_new(&plain_file, "a").unwrap();
        apply_import(&mut a, PLAIN, "sample.xlsx", &bytes, &plan()).unwrap();

        let mut b = crate::db::create_new(&enc_file, "b").unwrap();
        let (salt, cipher) = prepare_new_key(PASSWORD).unwrap();
        enable(&mut b, &salt, &cipher).unwrap();
        apply_import(&mut b, Codec(Some(&cipher)), "sample.xlsx", &bytes, &plan()).unwrap();

        assert_all_tokens_except_empty(&b);
        assert_eq!(
            serde_json::to_value(roster::list_students(&b, Codec(Some(&cipher))).unwrap()).unwrap(),
            serde_json::to_value(roster::list_students(&a, PLAIN).unwrap()).unwrap()
        );
        assert!(!file_contains(&enc_file, "GRACE BRIAR".as_bytes()));
    }

    fn assert_all_tokens_except_empty(conn: &Connection) {
        for (table, cols) in ENCRYPTED {
            for (col, _) in *cols {
                let n: i64 = conn
                    .query_row(
                        &format!(
                            "SELECT COUNT(*) FROM {table} WHERE {col} IS NOT NULL AND ({col} NOT LIKE '%:%' OR typeof({col}) != 'text')"
                        ),
                        [],
                        |r| r.get(0),
                    )
                    .unwrap();
                assert_eq!(n, 0, "{table}.{col}");
            }
        }
    }

    // ═════════════ 종합 케이스 ═════════════

    fn cipher_fast(pw: &str) -> Cipher {
        Cipher::derive(pw, b"0123456789abcdef", 1000).unwrap()
    }

    fn raw(conn: &Connection, sql: &str) -> Value {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    // ───── 1. 값 단위 ─────

    #[test]
    fn values_empty_large_binary_and_unicode_round_trip() {
        let c = cipher_fast(PASSWORD);
        let big: Vec<u8> = (0..8 * 1024 * 1024).map(|i| (i * 31 % 251) as u8).collect();
        let cases: Vec<Vec<u8>> = vec![
            vec![],                                              // 빈 값
            b"\0\0nul\0bytes".to_vec(),                          // NUL 포함
            "한글 이름 😀 emoji · 中文 · Ñ".as_bytes().to_vec(), // 다양한 문자
            big,                                                 // 8MB(원본 파일 크기 이상)
        ];
        for plain in cases {
            let t = c.encrypt("source_file.content", &plain).unwrap();
            assert!(is_token(&t));
            let (_, ct) = t.split_once(':').unwrap();
            assert_eq!(B64.decode(ct).unwrap().len(), plain.len() + 16);
            assert_eq!(
                c.decrypt("source_file.content", &t).unwrap().as_slice(),
                plain.as_slice()
            );
        }
        // 부호기: 빈 문자열과 NULL을 구분해 보존한다
        let codec = Codec(Some(&c));
        let empty = codec.opt_text("student.memo", 1, Some("")).unwrap();
        assert!(matches!(&empty, Value::Text(t) if is_token(t)));
        assert_eq!(
            codec
                .get_opt_text("student.memo", 1, empty)
                .unwrap()
                .as_deref(),
            Some("")
        );
        assert_eq!(
            codec.opt_text("student.memo", 1, None).unwrap(),
            Value::Null
        );
        assert_eq!(
            codec.get_opt_text("student.memo", 1, Value::Null).unwrap(),
            None
        );
        // 정수: 음수·0·큰 값
        for n in [0i64, -1, 107_389, i64::MAX, i64::MIN] {
            let v = codec.int("student.base_score", 1, n).unwrap();
            assert_eq!(codec.get_int("student.base_score", 1, v).unwrap(), n);
        }
    }

    #[test]
    fn nonces_never_repeat_over_many_values() {
        let c = cipher_fast(PASSWORD);
        let mut seen = std::collections::HashSet::new();
        for _ in 0..20_000 {
            let t = c.encrypt("student.name", b"x").unwrap();
            assert!(
                seen.insert(t.split_once(':').unwrap().0.to_string()),
                "nonce 중복"
            );
        }
    }

    #[test]
    fn malformed_tokens_fail_cleanly_without_panic() {
        let c = cipher_fast(PASSWORD);
        let good = c.encrypt("student.name", b"GRACE BRIAR").unwrap();
        let (n, ct) = good.split_once(':').unwrap();
        let nonce11 = B64.encode([0u8; 11]);
        let nonce13 = B64.encode([0u8; 13]);
        let short_ct = B64.encode([0u8; 15]); // 태그(16바이트)보다 짧음
        let cases = [
            format!("{nonce11}:{ct}"),
            format!("{nonce13}:{ct}"),
            format!("{n}:{short_ct}"),
            format!("{n}:{ct}:extra"),
            format!("{n}:"),
            format!(":{ct}"),
            format!(" {n}:{ct}"),
            format!("{n}:{}", &ct[..ct.len() - 4]),
            format!("{n}:!!!!"),
            ct.to_string(),
        ];
        for bad in &cases {
            assert!(c.decrypt("student.name", bad).is_err(), "{bad}");
        }
        // 부호기: 암호화된 칸에 평문·다른 형식이 들어 있으면 오류(평문으로 오인하지 않음)
        let codec = Codec(Some(&c));
        assert!(
            codec
                .get_text("student.name", 1, Value::Text("GRACE BRIAR".into()))
                .is_err()
        );
        assert!(
            codec
                .get_int("student.prev_class", 1, Value::Integer(3))
                .is_err()
        );
        assert!(
            codec
                .get_blob("source_file.content", 1, Value::Blob(vec![1, 2]))
                .is_err()
        );
    }

    // ───── 2. 비밀번호 ─────

    #[test]
    fn password_variants() {
        let salt = b"0123456789abcdef";
        // 한글·긴 비밀번호, 앞뒤 공백은 그대로(잘라 내지 않음), 대소문자 구분
        let korean = Cipher::derive("교무실비밀번호입니다", salt, 1000).unwrap();
        let t = korean.check_token().unwrap();
        assert!(korean.verify(&t));
        let long: String = "가나다라마바사아자차".repeat(100);
        let lc = Cipher::derive(&long, salt, 1000).unwrap();
        assert!(lc.verify(&lc.check_token().unwrap()));
        let a = Cipher::derive("classmix-test", salt, 1000).unwrap();
        let token = a.check_token().unwrap();
        for other in [
            "classmix-test ",
            " classmix-test",
            "Classmix-test",
            "classmix-tes",
        ] {
            assert!(
                !Cipher::derive(other, salt, 1000).unwrap().verify(&token),
                "{other:?}"
            );
        }
        // 같은 비밀번호라도 salt가 다르면 다른 키
        let b = Cipher::derive("classmix-test", b"fedcba9876543210", 1000).unwrap();
        assert!(!b.verify(&token));
        // 길이 제한은 글자 수 기준(한글 8자는 통과)
        assert!(prepare_new_key("한글여덟글자이다").is_ok());
        assert!(prepare_new_key("한글일곱글자다").is_err());
    }

    #[test]
    fn unlock_uses_rounds_stored_in_the_file() {
        // 반복 횟수를 나중에 바꿔도 예전 파일은 저장된 횟수로 열린다
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::create_new(&dir.path().join("r.mix"), "r").unwrap();
        let salt = b"0123456789abcdef";
        let c = Cipher::derive(PASSWORD, salt, 1000).unwrap();
        conn.execute(
            "UPDATE meta SET enc_salt = ?1, enc_iterations = 1000, enc_check = ?2",
            params![B64.encode(salt), c.check_token().unwrap()],
        )
        .unwrap();
        let h = header(&conn).unwrap().unwrap();
        assert_eq!(h.rounds, 1000);
        assert!(unlock(&h, PASSWORD).is_ok());
        assert!(matches!(
            unlock(&h, "다른-비밀번호-입니다"),
            Err(AppError::WrongPassword)
        ));
    }

    // ───── 3. meta 변조·손상 ─────

    #[test]
    fn tampered_or_broken_meta_is_refused() {
        let (_d, _p, mut conn) = populated_file();
        let (salt, cipher) = prepare_new_key(PASSWORD).unwrap();
        enable(&mut conn, &salt, &cipher).unwrap();
        let backup: (String, i64, String) = conn
            .query_row(
                "SELECT enc_salt, enc_iterations, enc_check FROM meta",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        let restore = |conn: &Connection| {
            conn.execute(
                "UPDATE meta SET enc_salt = ?1, enc_iterations = ?2, enc_check = ?3",
                params![backup.0, backup.1, backup.2],
            )
            .unwrap();
        };

        // 반복 횟수를 줄이는 공격(1회) → 키가 달라져 거절
        conn.execute("UPDATE meta SET enc_iterations = 1", [])
            .unwrap();
        assert!(matches!(
            unlock(&header(&conn).unwrap().unwrap(), PASSWORD),
            Err(AppError::WrongPassword)
        ));
        restore(&conn);
        // salt 변조 → 거절
        conn.execute(
            "UPDATE meta SET enc_salt = ?1",
            params![B64.encode([7u8; 16])],
        )
        .unwrap();
        assert!(matches!(
            unlock(&header(&conn).unwrap().unwrap(), PASSWORD),
            Err(AppError::WrongPassword)
        ));
        restore(&conn);
        // 확인 토큰 변조 → 거절
        conn.execute(
            "UPDATE meta SET enc_check = ?1",
            params![cipher_fast("x").check_token().unwrap()],
        )
        .unwrap();
        assert!(matches!(
            unlock(&header(&conn).unwrap().unwrap(), PASSWORD),
            Err(AppError::WrongPassword)
        ));
        restore(&conn);
        // 일부만 지워진 설정은 "암호 없음"으로 보지 않고 오류(평문으로 열리지 않게)
        for sql in [
            "UPDATE meta SET enc_iterations = NULL",
            "UPDATE meta SET enc_check = NULL",
            "UPDATE meta SET enc_salt = NULL",
            "UPDATE meta SET enc_iterations = 0",
            "UPDATE meta SET enc_iterations = -5",
            "UPDATE meta SET enc_salt = '!!!not-base64'",
        ] {
            conn.execute(sql, []).unwrap();
            assert!(header(&conn).is_err(), "{sql}");
            restore(&conn);
        }
        // 원래대로 돌리면 정상
        assert!(unlock(&header(&conn).unwrap().unwrap(), PASSWORD).is_ok());
    }

    #[test]
    fn a_corrupted_value_gives_a_clear_error_naming_the_column() {
        let (_d, _p, mut conn) = populated_file();
        let (salt, cipher) = prepare_new_key(PASSWORD).unwrap();
        enable(&mut conn, &salt, &cipher).unwrap();
        // 다른 칸의 암호문을 옮겨 붙임(AAD 불일치)
        conn.execute(
            "UPDATE student SET name = (SELECT memo FROM student WHERE memo IS NOT NULL) WHERE id = 2",
            [],
        )
        .unwrap();
        let err = board::board_data(&conn, Codec(Some(&cipher)))
            .unwrap_err()
            .to_string();
        assert!(err.contains("student.name"), "{err}");
        // 평문을 직접 써 넣은 경우도 거절
        conn.execute("UPDATE student SET name = 'GRACE BRIAR' WHERE id = 2", [])
            .unwrap();
        assert!(board::board_data(&conn, Codec(Some(&cipher))).is_err());
    }

    // ───── 4. 모두 되거나 하나도 안 되거나 ─────

    #[test]
    fn failed_enable_rolls_back_completely() {
        let (_d, _p, mut conn) = populated_file();
        let before_blob = raw(&conn, "SELECT content FROM source_file WHERE kind = 'xlsx'");
        // 마지막 학생의 정수 칸을 깨 둔다 → 원본 파일(앞 표)은 이미 암호화된 뒤 학생 표에서 실패
        conn.execute(
            "UPDATE student SET prev_class = 'x' WHERE id = (SELECT MAX(id) FROM student)",
            [],
        )
        .unwrap();
        let (salt, cipher) = prepare_new_key(PASSWORD).unwrap();
        assert!(enable(&mut conn, &salt, &cipher).is_err());
        assert!(header(&conn).unwrap().is_none(), "meta가 바뀌면 안 됨");
        assert_eq!(
            raw(&conn, "SELECT content FROM source_file WHERE kind = 'xlsx'"),
            before_blob
        );
        let first: String = conn
            .query_row("SELECT name FROM student WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert!(!is_token(&first));
        // 고치면 정상적으로 켜진다
        conn.execute(
            "UPDATE student SET prev_class = 1 WHERE id = (SELECT MAX(id) FROM student)",
            [],
        )
        .unwrap();
        enable(&mut conn, &salt, &cipher).unwrap();
        assert_all_tokens(&conn);
    }

    #[test]
    fn failed_disable_and_failed_change_roll_back_completely() {
        let (_d, path, mut conn) = populated_file();
        let (salt, cipher) = prepare_new_key(PASSWORD).unwrap();
        enable(&mut conn, &salt, &cipher).unwrap();
        // 마지막 표(change_log)의 값 하나를 망가뜨린다
        conn.execute(
            "UPDATE change_log SET payload = 'AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBBBB' WHERE id = (SELECT MAX(id) FROM change_log)",
            [],
        )
        .unwrap();
        let snapshot_rows = |conn: &Connection| -> Vec<String> {
            let mut st = conn
                .prepare("SELECT name FROM student ORDER BY id")
                .unwrap();
            st.query_map([], |r| r.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        let before = snapshot_rows(&conn);

        assert!(disable(&mut conn, &cipher).is_err());
        assert!(header(&conn).unwrap().is_some());
        assert_eq!(
            snapshot_rows(&conn),
            before,
            "학생 칸이 풀린 채 남으면 안 됨"
        );

        let (new_salt, new) = prepare_new_key("새-비밀번호-2027").unwrap();
        assert!(change_password(&mut conn, &cipher, &new_salt, &new).is_err());
        assert_eq!(header(&conn).unwrap().unwrap().salt, salt);
        assert_eq!(snapshot_rows(&conn), before);
        // 원래 비밀번호로 그대로 열린다
        drop(conn);
        let (conn, _) = crate::db::open_existing(&path).unwrap();
        assert!(unlock(&header(&conn).unwrap().unwrap(), PASSWORD).is_ok());
        assert!(!file_contains(&path, "GRACE BRIAR".as_bytes()));
    }

    #[test]
    fn read_only_connection_cannot_enable() {
        let (_d, path, conn) = populated_file();
        drop(conn);
        let before = std::fs::read(&path).unwrap();
        let mut ro =
            Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let (salt, cipher) = prepare_new_key(PASSWORD).unwrap();
        assert!(enable(&mut ro, &salt, &cipher).is_err());
        drop(ro);
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    // ───── 5. 상태별 동작 ─────

    #[test]
    fn empty_file_enable_change_disable() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::create_new(&dir.path().join("e.mix"), "e").unwrap();
        let (salt, c1) = prepare_new_key(PASSWORD).unwrap();
        enable(&mut conn, &salt, &c1).unwrap();
        let (s2, c2) = prepare_new_key("새-비밀번호-2027").unwrap();
        change_password(&mut conn, &c1, &s2, &c2).unwrap();
        disable(&mut conn, &c2).unwrap();
        assert!(header(&conn).unwrap().is_none());
    }

    #[test]
    fn every_write_path_while_encrypted_keeps_all_values_encrypted() {
        let (_d, path, mut conn) = populated_file();
        let (salt, cipher) = prepare_new_key(PASSWORD).unwrap();
        enable(&mut conn, &salt, &cipher).unwrap();
        let codec = Codec(Some(&cipher));
        let students = roster::list_students(&conn, codec).unwrap();
        let s0 = &students[0];

        // PDF 다시 가져오기(지우고 새로 씀)
        let rows = vec![PdfRowInput {
            page: 2,
            grade: "2학년".into(),
            class: s0.cur_class,
            number: s0.cur_number,
            name: s0.name.clone(),
            birth_date: Some("2012-05-05".into()),
            gender: Some("남".into()),
            base_score: Some(99_999),
            prev_grade: Some("1학년".into()),
            prev_class: Some(s0.prev_class),
            prev_number: Some(s0.prev_number),
            note: Some("다시 가져온 특이사항".into()),
        }];
        let links = vec![PdfLink {
            row_index: 0,
            student_id: s0.id,
            method: "manual".into(),
        }];
        roster::apply_pdf(&mut conn, codec, "again.pdf", b"%PDF-again", &rows, &links).unwrap();
        // 메모, 규칙(만들기·사유 바꾸기·쌍둥이 등록), 빈 번호 예정 이름, 한글 표기, 이동·되돌리기·다시 실행
        board::set_memo(&conn, codec, s0.id, Some("암호화 중 메모".into())).unwrap();
        let rid = board::create_rule(
            &mut conn,
            codec,
            &NewRule {
                kind: "one_to_many".into(),
                reason: Some("교우 관계".into()),
                members: vec![
                    RuleMember {
                        student_id: students[3].id,
                        role: "leader".into(),
                    },
                    RuleMember {
                        student_id: students[4].id,
                        role: "member".into(),
                    },
                ],
            },
        )
        .unwrap();
        board::update_rule(&conn, codec, rid, false, Some("학부모 요청으로 끔".into())).unwrap();
        board::resolve_twin_candidates(
            &mut conn,
            codec,
            &[vec![students[5].id, students[6].id]],
            &[vec![students[7].id, students[8].id]],
        )
        .unwrap();
        let gaps = roster::list_gaps(&conn, codec).unwrap();
        let g = gaps.iter().find(|g| g.class == 1).unwrap();
        let row = |planned: Option<&str>| GapRow {
            number: g.number,
            anchor_key: g.anchor_key.clone(),
            planned_name: planned.map(Into::into),
            origin: g.origin.clone(),
            created_at: Some(g.created_at.clone()),
        };
        changes::apply_change(
            &mut conn,
            codec,
            &ChangeSet {
                action: "gap_edit".into(),
                label: "예정 이름 바꾸기".into(),
                students: vec![],
                gaps: vec![ClassGaps {
                    class: 1,
                    before: vec![row(g.planned_name.as_deref())],
                    after: vec![row(Some("새전입생"))],
                }],
                numbering: vec![],
                readings: vec![],
            },
        )
        .unwrap();
        let cs = move_change(&conn, codec);
        changes::apply_change(&mut conn, codec, &cs).unwrap();
        changes::undo(&mut conn, codec).unwrap();
        changes::redo(&mut conn, codec).unwrap();

        assert_all_tokens(&conn);
        for needle in [
            "다시 가져온 특이사항",
            "암호화 중 메모",
            "교우 관계",
            "학부모 요청으로 끔",
            "새전입생",
            "%PDF-again",
            "쌍둥이",
        ] {
            assert!(!file_contains(&path, needle.as_bytes()), "{needle}");
        }
        // 모두 읽히고, 끄면 그대로 평문으로 돌아온다
        let enc_view = snapshot(&conn, codec);
        disable(&mut conn, &cipher).unwrap();
        assert_eq!(snapshot(&conn, PLAIN), enc_view);
    }

    #[test]
    fn undo_redo_across_enable_disable_and_change() {
        let (_d, _p, mut conn) = populated_file();
        // 평문일 때 한 변경 → 암호를 건 뒤 되돌리기
        let cs = move_change(&conn, PLAIN);
        changes::apply_change(&mut conn, PLAIN, &cs).unwrap();
        let (salt, c1) = prepare_new_key(PASSWORD).unwrap();
        enable(&mut conn, &salt, &c1).unwrap();
        assert_eq!(
            changes::undo(&mut conn, Codec(Some(&c1)))
                .unwrap()
                .as_deref(),
            Some(cs.label.as_str())
        );
        // 비밀번호를 바꾼 뒤 다시 실행
        let (s2, c2) = prepare_new_key("새-비밀번호-2027").unwrap();
        change_password(&mut conn, &c1, &s2, &c2).unwrap();
        assert_eq!(
            changes::redo(&mut conn, Codec(Some(&c2)))
                .unwrap()
                .as_deref(),
            Some(cs.label.as_str())
        );
        // 암호화 중 한 변경 → 암호를 푼 뒤 되돌리기
        changes::undo(&mut conn, Codec(Some(&c2))).unwrap();
        let cs2 = move_change(&conn, Codec(Some(&c2)));
        changes::apply_change(&mut conn, Codec(Some(&c2)), &cs2).unwrap();
        disable(&mut conn, &c2).unwrap();
        assert_eq!(
            changes::undo(&mut conn, PLAIN).unwrap().as_deref(),
            Some(cs2.label.as_str())
        );
        assert_eq!(
            changes::history(&conn, PLAIN, 10).unwrap()[0].label,
            cs2.label
        );
    }

    #[test]
    fn password_can_change_repeatedly_and_back_to_the_original() {
        let (_d, path, mut conn) = populated_file();
        let before = snapshot(&conn, PLAIN);
        let (s, mut cur) = prepare_new_key(PASSWORD).unwrap();
        enable(&mut conn, &s, &cur).unwrap();
        let mut salts = vec![s];
        for pw in ["둘째-비밀번호-2027", "셋째-비밀번호-2028", PASSWORD] {
            let (ns, nc) = prepare_new_key(pw).unwrap();
            change_password(&mut conn, &cur, &ns, &nc).unwrap();
            assert!(!salts.contains(&ns), "매번 새 salt");
            salts.push(ns);
            cur = nc;
        }
        drop(conn);
        let (conn, _) = crate::db::open_existing(&path).unwrap();
        let h = header(&conn).unwrap().unwrap();
        for old in ["둘째-비밀번호-2027", "셋째-비밀번호-2028"] {
            assert!(matches!(unlock(&h, old), Err(AppError::WrongPassword)));
        }
        let c = unlock(&h, PASSWORD).unwrap();
        assert_eq!(snapshot(&conn, Codec(Some(&c))), before);
    }

    #[test]
    fn copies_made_while_encrypted_stay_encrypted() {
        // 다른 이름으로 저장·사본 저장은 VACUUM INTO로 만든다
        let (dir, _p, mut conn) = populated_file();
        let before = snapshot(&conn, PLAIN);
        let (salt, cipher) = prepare_new_key(PASSWORD).unwrap();
        enable(&mut conn, &salt, &cipher).unwrap();
        let copy = dir.path().join("사본 (백업).mix");
        crate::db::vacuum_into(&conn, &copy).unwrap();
        assert!(!file_contains(&copy, "GRACE BRIAR".as_bytes()));
        let (c2, _) = crate::db::open_existing(&copy).unwrap();
        let h = header(&c2).unwrap().unwrap();
        assert!(matches!(
            unlock(&h, "틀린-비밀번호-입니다"),
            Err(AppError::WrongPassword)
        ));
        let k = unlock(&h, PASSWORD).unwrap();
        assert_eq!(snapshot(&c2, Codec(Some(&k))), before);
    }

    #[test]
    fn no_journal_or_side_files_are_left_after_bulk_operations() {
        let (dir, path, mut conn) = populated_file();
        let (salt, cipher) = prepare_new_key(PASSWORD).unwrap();
        enable(&mut conn, &salt, &cipher).unwrap();
        let (s2, c2) = prepare_new_key("새-비밀번호-2027").unwrap();
        change_password(&mut conn, &cipher, &s2, &c2).unwrap();
        disable(&mut conn, &c2).unwrap();
        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(
            names,
            vec![path.file_name().unwrap().to_string_lossy().to_string()],
            "{names:?}"
        );
    }

    // ───── 행 묶음·공백 비밀번호(종합 테스트에서 찾은 약점의 수정) ─────

    #[test]
    fn swapping_a_value_between_two_students_is_detected() {
        let (_d, _p, mut conn) = populated_file();
        let (salt, cipher) = prepare_new_key(PASSWORD).unwrap();
        enable(&mut conn, &salt, &cipher).unwrap();
        let codec = Codec(Some(&cipher));
        let students = roster::list_students(&conn, codec).unwrap();
        let (a, b) = (students[0].id, students[1].id);
        // 같은 칸(이름·기준성적·학번·생년월일)을 두 학생 사이에서 맞바꾸면 복호화가 실패한다
        for col in ["name", "base_score", "student_no", "birth_date"] {
            let get = |id: i64| -> Value {
                conn.query_row(
                    &format!("SELECT {col} FROM student WHERE id = ?1"),
                    [id],
                    |r| r.get(0),
                )
                .unwrap()
            };
            let (va, vb) = (get(a), get(b));
            if va == Value::Null || vb == Value::Null {
                continue;
            }
            // 임시 값을 거쳐 맞바꾼다(학번은 UNIQUE라 같은 값이 잠시라도 둘이면 안 됨)
            let set = |id: i64, v: &Value| {
                conn.execute(
                    &format!("UPDATE student SET {col} = ?1 WHERE id = ?2"),
                    params![v, id],
                )
                .unwrap();
            };
            let tmp = Value::Text("swap-tmp".into());
            set(a, &tmp);
            set(b, &va);
            set(a, &vb);
            let err = roster::list_students(&conn, codec).unwrap_err().to_string();
            assert!(err.contains(&format!("student.{col}")), "{col}: {err}");
            // 되돌리면 다시 읽힌다
            set(a, &tmp);
            set(b, &vb);
            set(a, &va);
            assert!(roster::list_students(&conn, codec).is_ok());
        }
        // 원본 파일·이력·빈 번호도 행에 묶여 있다: 다른 행의 암호문을 복사해 넣으면 실패
        conn.execute(
            "UPDATE source_file SET content = (SELECT content FROM source_file WHERE kind = 'pdf') WHERE kind = 'xlsx'",
            [],
        )
        .unwrap();
        assert!(export::export_xlsx(&conn, codec, &_d.path().join("x.xlsx")).is_err());
    }

    #[test]
    fn row_ids_are_preserved_through_every_rewrite() {
        // 켜기·바꾸기·끄기·VACUUM·사본 뒤에도 각 값이 자기 행 id로 풀린다(id가 바뀌지 않음)
        let (dir, _p, mut conn) = populated_file();
        let ids = |conn: &Connection, t: &str| -> Vec<i64> {
            let mut st = conn
                .prepare(&format!("SELECT id FROM {t} ORDER BY id"))
                .unwrap();
            st.query_map([], |r| r.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        let before: Vec<Vec<i64>> = ENCRYPTED.iter().map(|(t, _)| ids(&conn, t)).collect();
        let (salt, c1) = prepare_new_key(PASSWORD).unwrap();
        enable(&mut conn, &salt, &c1).unwrap();
        let (s2, c2) = prepare_new_key("새-비밀번호-2027").unwrap();
        change_password(&mut conn, &c1, &s2, &c2).unwrap();
        let copy = dir.path().join("copy.mix");
        crate::db::vacuum_into(&conn, &copy).unwrap();
        let (cc, _) = crate::db::open_existing(&copy).unwrap();
        let after: Vec<Vec<i64>> = ENCRYPTED.iter().map(|(t, _)| ids(&cc, t)).collect();
        assert_eq!(before, after);
        assert!(board::board_data(&cc, Codec(Some(&c2))).is_ok());
    }

    #[test]
    fn blank_passwords_are_rejected() {
        for pw in [
            "        ",
            "\t\t\t\t\t\t\t\t",
            "　　　　　　　　",
            " \n \t \r   ",
        ] {
            let err = prepare_new_key(pw)
                .err()
                .map(|e| e.to_string())
                .unwrap_or_default();
            assert!(err.contains("공백"), "{pw:?}: {err}");
        }
        // 공백이 섞인 비밀번호는 허용(공백 자체는 그대로 키에 반영)
        assert!(prepare_new_key("  class mix  ").is_ok());
    }

    // ───── 원자성 검토 뒤 보강 ─────

    #[test]
    fn a_failed_vacuum_after_commit_does_not_fail_the_operation() {
        // 자료는 이미 커밋되었으므로 성공으로 돌려줘야 화면 상태(암호 여부·키)가 파일과 어긋나지 않는다
        let (_d, _p, mut conn) = populated_file();
        let before = snapshot(&conn, PLAIN);
        FAIL_VACUUM.with(|f| f.set(true));
        let (salt, c1) = prepare_new_key(PASSWORD).unwrap();
        assert!(enable(&mut conn, &salt, &c1).is_ok());
        assert!(header(&conn).unwrap().is_some());
        assert_all_tokens(&conn);
        let (s2, c2) = prepare_new_key("새-비밀번호-2027").unwrap();
        assert!(change_password(&mut conn, &c1, &s2, &c2).is_ok());
        assert_eq!(snapshot(&conn, Codec(Some(&c2))), before);
        assert!(disable(&mut conn, &c2).is_ok());
        FAIL_VACUUM.with(|f| f.set(false));
        assert!(header(&conn).unwrap().is_none());
        assert_eq!(snapshot(&conn, PLAIN), before);
    }

    #[test]
    fn memo_and_rule_edits_are_all_or_nothing() {
        let (_d, _p, mut conn) = populated_file();
        let students = roster::list_students(&conn, PLAIN).unwrap();
        let rid = board::create_rule(
            &mut conn,
            PLAIN,
            &NewRule {
                kind: "group".into(),
                reason: Some("처음 사유".into()),
                members: vec![
                    RuleMember {
                        student_id: students[10].id,
                        role: "member".into(),
                    },
                    RuleMember {
                        student_id: students[11].id,
                        role: "member".into(),
                    },
                ],
            },
        )
        .unwrap();
        let memo_of = |conn: &Connection, id: i64| -> Option<String> {
            conn.query_row("SELECT memo FROM student WHERE id = ?1", [id], |r| r.get(0))
                .unwrap()
        };
        let rule_of = |conn: &Connection| -> Option<(bool, Option<String>)> {
            conn.query_row(
                "SELECT enabled, reason FROM separation_rule WHERE id = ?1",
                [rid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok()
        };
        let memo_before = memo_of(&conn, students[0].id);
        let rule_before = rule_of(&conn);
        // 두 번째 문장(수정 시각 기록)이 실패하게 만든다
        conn.execute_batch(
            "CREATE TRIGGER fail_meta BEFORE UPDATE OF updated_at ON meta BEGIN SELECT RAISE(ABORT, '주입한 실패'); END;",
        )
        .unwrap();
        assert!(board::set_memo(&conn, PLAIN, students[0].id, Some("새 메모".into())).is_err());
        assert!(board::update_rule(&conn, PLAIN, rid, false, Some("바뀐 사유".into())).is_err());
        assert!(board::delete_rule(&conn, rid).is_err());
        // 첫 문장도 함께 되돌아갔다
        assert_eq!(memo_of(&conn, students[0].id), memo_before);
        assert_eq!(rule_of(&conn), rule_before);
        // 실패 원인을 없애면 정상
        conn.execute_batch("DROP TRIGGER fail_meta").unwrap();
        board::set_memo(&conn, PLAIN, students[0].id, Some("새 메모".into())).unwrap();
        assert_eq!(memo_of(&conn, students[0].id).as_deref(), Some("새 메모"));
        board::delete_rule(&conn, rid).unwrap();
        assert_eq!(rule_of(&conn), None);
    }
}
