use std::{env, fs};

// The app version has one source: package.json (tauri.conf.json: "version": "../package.json"). A release build passes
// the computed version with `tauri build --config {"version":"X.Y.Z"}`, which the CLI forwards to cargo as the
// TAURI_CONFIG patch. tauri-build writes only the numeric VERSIONINFO (FILEVERSION/PRODUCTVERSION) from it; the
// FileVersion and ProductVersion strings (Explorer > Properties > Details, FileVersionInfo) come from
// CARGO_PKG_VERSION, i.e. Cargo.toml's frozen 0.0.0. Align them here, in this build-script process, before
// tauri_build::build() creates the Windows resource. The release smoke test (scripts/smoke-windows.ps1) checks both.
fn main() {
    println!("cargo:rerun-if-changed=../package.json");
    if let Some(version) = effective_version() {
        env::set_var("CARGO_PKG_VERSION", version);
    }
    tauri_build::build()
}

/// The version tauri-build and generate_context!() see: the TAURI_CONFIG patch, otherwise package.json.
fn effective_version() -> Option<String> {
    if let Ok(raw) = env::var("TAURI_CONFIG") {
        if let Ok(patch) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(version) = patch.get("version").and_then(|value| value.as_str()) {
                if !version.ends_with(".json") {
                    return Some(version.to_owned());
                }
            }
        }
    }
    let manifest: serde_json::Value =
        serde_json::from_str(&fs::read_to_string("../package.json").ok()?).ok()?;
    manifest.get("version")?.as_str().map(str::to_owned)
}
