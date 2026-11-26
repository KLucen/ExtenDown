fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "current_document",
            "new_markdown",
            "new_document_window",
            "open_markdown",
            "recent_markdown",
            "open_recent_markdown",
            "save_markdown",
            "save_markdown_as",
            "reload_markdown",
            "write_markdown_draft",
            "clear_markdown_draft",
            "recover_markdown_drafts",
            "restore_markdown_draft",
            "discard_markdown_draft",
            "read_document_image",
            "open_theme_package",
            "set_default_markdown_app",
            "save_export",
            "installed_components",
        ]),
    ))
    .expect("failed to generate ExtenDown permissions");
}
