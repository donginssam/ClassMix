//! 성명 정규화 규칙.

/// 연속된 공백·줄바꿈을 한 칸으로 줄이고 앞뒤 공백을 지운다. (`student.name_norm`)
pub fn collapse_spaces(name: &str) -> String {
    name.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 동명이인 비교 키: 공백을 모두 지우고 대문자로 바꾼다.
/// 한국 국적 학생의 한글 성명은 그대로이고, 외국 국적 학생의 로마자 이름은
/// 띄어쓰기·대소문자 차이가 사라진다.
pub fn same_name_key(name: &str) -> String {
    name.chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(char::to_uppercase)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collapses_whitespace() {
        assert_eq!(collapse_spaces("  앙꼬 "), "앙꼬");
        assert_eq!(collapse_spaces("Ayu Lestari\nTom"), "Ayu Lestari Tom");
    }

    #[test]
    fn same_name_key_ignores_spaces_and_case() {
        assert_eq!(
            same_name_key("NGUYEN VAN AN"),
            same_name_key("NguyenVan An")
        );
        assert_eq!(same_name_key("바쿠 "), "바쿠");
    }
}
