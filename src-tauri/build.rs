use std::{fs, path::Path};

fn main() {
    // 앱 버전은 package.json 한 곳에서 정한다(tauri.conf.json의 version도 같은 파일을 가리킨다).
    // 러스트 코드에서는 env!("APP_VERSION")으로 읽는다.
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("../package.json");
    println!("cargo:rerun-if-changed={}", manifest.display());
    let text = fs::read_to_string(&manifest).expect("package.json을 읽지 못했습니다");
    let json: serde_json::Value = serde_json::from_str(&text).expect("package.json 형식 오류");
    let version = json["version"]
        .as_str()
        .expect("package.json에 version이 없습니다");
    println!("cargo:rustc-env=APP_VERSION={version}");

    tauri_build::build()
}
