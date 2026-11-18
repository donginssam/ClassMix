mod commands;
mod db;
mod error;
mod names;
mod roster;
mod settings;
mod xlsx_import;

use tauri::{Manager, RunEvent};

use commands::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::create_work_file,
            commands::open_work_file,
            commands::close_work_file,
            commands::get_workspace,
            commands::save_work_file_as,
            commands::save_work_file_copy,
            commands::list_recent_files,
            commands::remove_recent_file,
            commands::import_xlsx,
            commands::list_students,
            commands::list_gaps,
            commands::read_pdf_file,
            commands::apply_pdf_mapping,
            commands::dev_sample_paths,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            // 앱을 끌 때 열림 표시를 지운다.
            handle.state::<AppState>().close();
        }
    });
}
