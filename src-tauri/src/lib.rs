mod auth_callback;
mod installer;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_process::init())
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
                log::info!("收到新的桌面应用实例参数: {argv:?}");
                auth_callback::focus_main_window(app);
            }));
    }

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            auth_callback::begin_desktop_auth_callback,
            installer::get_agent_installation_status,
            installer::install_skill,
            installer::package_local_skill,
            installer::record_local_skill_publication,
            installer::sync_local_skill_metadata,
            installer::clear_local_skill_publication,
            installer::scan_local_skills,
            installer::set_local_skill_enabled,
            installer::remove_local_skill,
            installer::remove_local_skill_entries
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
