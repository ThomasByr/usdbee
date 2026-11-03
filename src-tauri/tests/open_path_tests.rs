// Task 12: the path-based open command (drag-drop, recent files) must run
// the same orchestration as the dialog flow — usdz extraction, dependency
// scan, stage open — and return the opened stage's info.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::{Listener, Manager};
use usdbee_lib::get_usdbee_cache_dir;
use usdbee_lib::{open_usd_file_path, AppState, LoadGate, OPEN_IN_FLIGHT_MESSAGE};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app should build");
    app.manage(usdbee_lib::stage::StageState::new(
        usdbee_lib::stage::noop_sink(),
    ));
    app.manage(LoadGate::default());
    app.manage(AppState {
        omniverse_server: Mutex::new("http://localhost:34080".into()),
    });
    app
}

#[test]
fn opens_plain_usda_fixture_via_path_command() {
    let app = mock_app();
    let path = fixture("basic.usda");

    let info = tauri::async_runtime::block_on(open_usd_file_path(
        app.handle().clone(),
        path.to_string_lossy().into_owned(),
    ))
    .expect("basic.usda should open through the path command");

    assert!(info.stage_id > 0, "the command must mint a stage id");
    assert_eq!(info.root_layer, path.to_string_lossy());
    assert!(info.composition_errors.is_empty());
}

#[test]
fn extracts_and_opens_usdz_via_path_command() {
    let dir = tempfile::tempdir().expect("temp dir should be created");
    let source = fixture("basic.usda");
    let layer = openusd::sdf::Layer::open(source.to_str().expect("fixture path is UTF-8"))
        .expect("source layer should open");
    let usdz = dir.path().join("basic.usdz");
    layer
        .export(usdz.to_str().expect("temp path is UTF-8"))
        .expect("usdz stage should be generated");

    let app = mock_app();

    let info = tauri::async_runtime::block_on(open_usd_file_path(
        app.handle().clone(),
        usdz.to_string_lossy().into_owned(),
    ))
    .expect("basic.usdz should extract and open through the path command");

    assert!(info.stage_id > 0);
    assert!(
        PathBuf::from(&info.root_layer).starts_with(get_usdbee_cache_dir().join("extracted")),
        "the usdz root layer must point into the extraction cache, got {}",
        info.root_layer
    );
    assert!(info.composition_errors.is_empty());
}

#[test]
fn missing_path_is_a_readable_error() {
    let app = mock_app();
    let missing = app
        .path()
        .temp_dir()
        .expect("mock app should expose a temp dir")
        .join(format!("no_such_file_{}.usda", std::process::id()));

    let result = tauri::async_runtime::block_on(open_usd_file_path(
        app.handle().clone(),
        missing.to_string_lossy().into_owned(),
    ));

    let err = result.expect_err("a missing file must fail the open");
    assert!(!err.is_empty(), "the error must be readable");
    assert!(
        err.to_lowercase().contains("exist"),
        "the error must name the problem, got: {}",
        err
    );
}

#[test]
fn gate_refusal_surfaces_through_the_refused_channel_only() {
    let app = mock_app();
    let gate = app.state::<LoadGate>();
    let _claim = gate.claim().expect("the test must hold the gate");

    let seen: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
    for name in ["usd-load-start", "usd-load-error", "usd-load-refused"] {
        let sink = seen.clone();
        app.listen(name, move |event| {
            sink.lock()
                .unwrap()
                .push((name.to_string(), event.payload().to_string()));
        });
    }

    let err = tauri::async_runtime::block_on(open_usd_file_path(
        app.handle().clone(),
        fixture("basic.usda").to_string_lossy().into_owned(),
    ))
    .expect_err("an open while the gate is held must be refused");

    assert_eq!(err, OPEN_IN_FLIGHT_MESSAGE, "the refusal must be readable");
    let seen = seen.lock().unwrap();
    assert_eq!(
        seen.iter()
            .filter(|(name, _)| name == "usd-load-refused")
            .count(),
        1,
        "the refusal must be surfaced exactly once"
    );
    assert!(
        seen.iter().any(
            |(name, payload)| name == "usd-load-refused" && payload.contains("already opening")
        ),
        "the refusal must carry the readable message"
    );
    assert!(
        !seen.iter().any(|(name, _)| name == "usd-load-error"),
        "a refusal must never ride the failure channel"
    );
    assert!(
        !seen.iter().any(|(name, _)| name == "usd-load-start"),
        "a refused open must not start a load stream"
    );
}
