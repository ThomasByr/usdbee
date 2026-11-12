use std::io::Read;
use std::path::{Path, PathBuf};

mod common;

use usdbee_lib::stage::{request_list_dirty_layers, request_save_layers, LayerSaveRequest};

use common::{
    edit_target, fixture, open_path_via_owner, open_via_owner, owner_with_events, payload,
    request_set_value, TestOwner,
};

#[test]
fn usdz_opened_stage_is_flagged_and_rejects_saves() {
    let (state, _events) = owner_with_events();

    // Package basic.usda into a real usdz archive, then open it directly.
    let dir = tempfile::tempdir().expect("temp dir");
    let usdz = dir.path().join("packed.usdz");
    let layer = openusd::sdf::Layer::open(fixture("basic.usda").to_string_lossy().as_ref())
        .expect("basic.usda opens as a layer");
    layer
        .export(usdz.to_string_lossy().as_ref())
        .expect("usdz export works");

    let info = open_path_via_owner(&state, &usdz);

    let target = edit_target(&state);
    assert!(target.is_usdz_stage, "usdz-opened stages are flagged");
    assert!(
        target.is_session,
        "the session layer stays the default target"
    );
    assert_eq!(info.root_layer, usdz.to_string_lossy().to_string());

    // Saving anything from a usdz-opened stage is refused (Task 7 adds
    // the Save As usdz path).
    let error = request_save_layers(
        &state.sender(),
        &[LayerSaveRequest {
            identifier: info.root_layer.clone(),
            path: dir.path().join("nope.usda").to_string_lossy().to_string(),
        }],
    )
    .expect_err("usdz-opened stages cannot save layers");
    assert!(error.contains("usdz"), "got: {}", error);
}

/// Package basic.usda into a real usdz, extract it into the cache the way
/// `unpack_usdz` lays it out, and open the extracted .usdc carrying the
/// usdz origin flag — the exact shape of the File > Open dialog flow.
fn extract_usdz_like_the_dialog() -> PathBuf {
    use std::io::Write;

    let dir = tempfile::tempdir().expect("temp dir");
    let usdc = dir.path().join("root.usdc");
    let layer = openusd::sdf::Layer::open(fixture("basic.usda").to_string_lossy().as_ref())
        .expect("basic.usda opens as a layer");
    layer
        .export(usdc.to_string_lossy().as_ref())
        .expect("usdc export works");

    let archive_path = dir.path().join("packed.usdz");
    let mut writer =
        zip::ZipWriter::new(std::fs::File::create(&archive_path).expect("usdz create"));
    writer
        .start_file("root.usdc", zip::write::SimpleFileOptions::default())
        .expect("root entry");
    writer
        .write_all(&std::fs::read(&usdc).expect("usdc bytes"))
        .expect("root entry bytes");
    writer.finish().expect("usdz finish");

    let extracted = usdbee_lib::get_usdbee_cache_dir()
        .join("extracted")
        .join(format!("usdz_dialog_pin_{}", std::process::id()));
    std::fs::create_dir_all(&extracted).expect("extracted root");
    let mut archive = zip::ZipArchive::new(std::fs::File::open(&archive_path).expect("usdz opens"))
        .expect("usdz parses");
    let mut entry = archive.by_name("root.usdc").expect("root entry");
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut entry, &mut bytes).expect("entry reads");
    let extracted_root = extracted.join("root.usdc");
    std::fs::write(&extracted_root, bytes).expect("entry extracts");
    extracted_root
}

#[test]
fn usdz_opened_via_extraction_flow_is_flagged_and_rejects_saves() {
    let (state, _events) = owner_with_events();

    // The dialog flow: .usdz extracted to the cache, .usdc opened with the
    // usdz origin flag — the suffix alone must not un-flag the stage.
    let extracted_root = extract_usdz_like_the_dialog();
    let info = state.open_flow(&extracted_root, true, None, None);

    let target = edit_target(&state);
    assert!(
        target.is_usdz_stage,
        "a stage opened from an extracted usdz must be flagged: {}",
        extracted_root.display()
    );
    assert_eq!(
        info.root_layer,
        extracted_root.to_string_lossy().to_string()
    );

    // Saving anything from this stage is refused — the save must never
    // write over the cache extraction while the user's .usdz sits unchanged.
    let error = request_save_layers(
        &state.sender(),
        &[LayerSaveRequest {
            identifier: info.root_layer.clone(),
            path: extracted_root
                .parent()
                .unwrap()
                .join("sneaky.usda")
                .to_string_lossy()
                .to_string(),
        }],
    )
    .expect_err("usdz-origin stages cannot save layers");
    assert!(error.contains("usdz"), "got: {}", error);

    // Direct .usdz opens (suffix derivation) stay flagged too.
    let dir = tempfile::tempdir().expect("temp dir");
    let usdz = dir.path().join("direct.usdz");
    let layer = openusd::sdf::Layer::open(fixture("basic.usda").to_string_lossy().as_ref())
        .expect("basic.usda opens as a layer");
    layer
        .export(usdz.to_string_lossy().as_ref())
        .expect("usdz export works");
    state.open(&usdz);
    assert!(
        edit_target(&state).is_usdz_stage,
        "direct opens derive the flag"
    );

    // And a plain .usda open is not flagged.
    state.open(&fixture("basic.usda"));
    assert!(
        !edit_target(&state).is_usdz_stage,
        "plain opens stay savable"
    );

    std::fs::remove_dir_all(extracted_root.parent().expect("extracted parent"))
        .expect("extracted pin cleanup");
}

/// Package basic.usda into a real usdz archive and open it directly — the
/// reusable fixture shape of the Task 2 usdz tests.
fn open_usdz_via_owner(state: &TestOwner, dir: &Path) -> PathBuf {
    let usdz = dir.join("packed.usdz");
    let layer = openusd::sdf::Layer::open(fixture("basic.usda").to_string_lossy().as_ref())
        .expect("basic.usda opens as a layer");
    layer
        .export(usdz.to_string_lossy().as_ref())
        .expect("usdz export works");
    let _ = open_path_via_owner(state, &usdz);
    usdz
}

#[test]
fn save_stage_as_usdz_repacks_session_edits_into_a_new_archive() {
    let (state, events) = owner_with_events();
    let dir = tempfile::tempdir().expect("temp dir");
    let usdz = open_usdz_via_owner(&state, dir.path());
    assert!(edit_target(&state).is_usdz_stage, "the usdz flag is set");

    // A session edit composes over the packaged stage (the session layer is
    // the default edit target).
    request_set_value(
        &state,
        "/World/Ball",
        "radius",
        payload("float", serde_json::json!(9.5)),
        None,
    )
    .expect("session edit on a usdz stage should succeed");
    let paths = events
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("the edit fires usd-stage-changed");
    assert_eq!(paths, vec!["/World/Ball".to_string()]);

    let before = std::fs::read(&usdz).expect("original archive reads");
    let out = dir.path().join("repacked.usdz");
    usdbee_lib::stage::request_save_stage_as_usdz(&state.sender(), out.to_string_lossy().as_ref())
        .expect("save as usdz should succeed");

    // The original archive is never mutated.
    assert_eq!(
        std::fs::read(&usdz).expect("original archive re-reads"),
        before,
        "save as usdz must not touch the original archive"
    );

    // Not a layer save: no usd-stage-changed fired and the session layer
    // stays dirty (a usdz export never marks layers clean).
    assert!(
        events
            .recv_timeout(std::time::Duration::from_millis(200))
            .is_err(),
        "save as usdz must not emit usd-stage-changed"
    );
    let dirty = request_list_dirty_layers(&state.sender()).expect("dirty layers list");
    assert_eq!(dirty.len(), 1, "the session layer stays dirty: {dirty:?}");

    // Reopening the new archive shows the session edit composed in.
    let reopened =
        openusd::usd::Stage::open(out.to_string_lossy().as_ref()).expect("the repacked usdz opens");
    let value = reopened
        .attribute("/World/Ball.radius")
        .expect("radius attribute")
        .get_at::<openusd::sdf::Value>(openusd::usd::TimeCode::new(0.0))
        .expect("radius value reads");
    assert_eq!(
        value,
        Some(openusd::sdf::Value::Float(9.5)),
        "the session edit must compose into the repacked archive"
    );
}

#[test]
fn save_stage_as_usdz_packages_textures_and_session_edits() {
    let (state, _events) = owner_with_events();
    open_via_owner(&state, "textured.usda");
    request_set_value(
        &state,
        "/World/Ball",
        "size",
        payload("double", serde_json::json!(3.5)),
        None,
    )
    .expect("session edit should succeed");
    let dir = tempfile::tempdir().expect("temp dir");
    let out = dir.path().join("textured.usdz");

    usdbee_lib::stage::request_save_stage_as_usdz(&state.sender(), out.to_string_lossy().as_ref())
        .expect("dependency-aware usdz export should succeed");

    fn packaged_texture(bytes: &[u8]) -> Option<Vec<u8>> {
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).ok()?;
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).ok()?;
            let name = entry.name().to_string();
            let mut contents = Vec::new();
            entry.read_to_end(&mut contents).ok()?;
            if name.ends_with("checker.png") {
                return Some(contents);
            }
            if name.ends_with(".usdz") {
                if let Some(texture) = packaged_texture(&contents) {
                    return Some(texture);
                }
            }
        }
        None
    }
    assert_eq!(
        packaged_texture(&std::fs::read(&out).expect("package bytes")).as_deref(),
        Some(
            std::fs::read(fixture("checker.png"))
                .expect("source texture")
                .as_slice()
        ),
        "the external texture is packaged byte-for-byte, including nested packages"
    );

    let reopened =
        openusd::usd::Stage::open(out.to_string_lossy().as_ref()).expect("packaged stage reopens");
    let size = reopened
        .attribute("/World/Ball.size")
        .expect("size attribute")
        .get_at::<f64>(openusd::usd::TimeCode::new(0.0))
        .expect("size reads");
    assert_eq!(size, Some(3.5), "the session opinion survives packaging");
    let texture = reopened
        .attribute("/World/Looks/Textured/Albedo.inputs:file")
        .expect("texture attribute")
        .get_at::<openusd::sdf::Value>(openusd::usd::TimeCode::new(0.0))
        .expect("texture value reads");
    let Some(openusd::sdf::Value::AssetPath(texture)) = texture else {
        panic!("expected an asset path, got {texture:?}");
    };
    assert!(
        texture
            .resolved_path()
            .is_some_and(|path| path.contains("textured.usdz[")),
        "the reopened texture resolves inside the package: {texture:?}"
    );
}

#[test]
fn save_stage_as_usdz_preserves_value_clips() {
    let (state, _events) = owner_with_events();
    open_via_owner(&state, "clips_root.usda");
    let dir = tempfile::tempdir().expect("temp dir");
    let out = dir.path().join("clipped.usdz");

    usdbee_lib::stage::request_save_stage_as_usdz(&state.sender(), out.to_string_lossy().as_ref())
        .expect("clip-preserving usdz export should succeed");

    let reopened =
        openusd::usd::Stage::open(out.to_string_lossy().as_ref()).expect("packaged stage reopens");
    let size = reopened
        .attribute("/Model.size")
        .expect("clip-driven attribute")
        .get_at::<f64>(openusd::usd::TimeCode::new(0.0))
        .expect("clip-driven value reads");
    assert_eq!(size, Some(42.0), "the clip schedule and clip layer survive");
}

/// Nested usdz-inside-usdz (Task 13): the root layer references a layer
/// packaged inside ANOTHER usdz; Save As repackages that usdz as a file
/// inside the new archive. Reopening the result must still compose through
/// the nested package.
#[test]
fn save_stage_as_usdz_survives_nested_usdz_dependencies() {
    let (state, _events) = owner_with_events();
    let dir = tempfile::tempdir().expect("temp dir");

    // inner.usdz packages one text layer defining /Pinned (defaultPrim set so
    // the bare reference resolves, per the fixture gotchas).
    let packaged = "#usda 1.0\n(\n    defaultPrim = \"Pinned\"\n)\n\ndef Xform \"Pinned\"\n{\n    custom double depth = 7.5\n}\n";
    let mut archive_bytes = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut archive_bytes);
    let mut writer = openusd::usdz::ArchiveWriter::new(&mut cursor);
    writer
        .add_layer("packaged.usda", packaged.as_bytes())
        .expect("layer packages into the archive");
    writer.finish().expect("archive finalizes");
    std::fs::write(dir.path().join("inner.usdz"), &archive_bytes).expect("inner archive writes");

    let root = dir.path().join("root.usda");
    std::fs::write(
        &root,
        "#usda 1.0\ndef \"R\" (references = @./inner.usdz[packaged.usda]@)\n{\n}\n",
    )
    .expect("root layer writes");

    let info = state.open(&root);
    assert_eq!(info.composition_errors, Vec::<String>::new());
    let out = dir.path().join("nested-out.usdz");
    usdbee_lib::stage::request_save_stage_as_usdz(&state.sender(), out.to_string_lossy().as_ref())
        .expect("save as usdz with a nested usdz dependency should succeed");

    // The saved package really contains the inner archive as a file —
    // nested through the two-pass flow's intermediate package.
    fn contains_entry_with_suffix(bytes: &[u8], suffix: &str) -> bool {
        let Ok(mut zip) = zip::ZipArchive::new(std::io::Cursor::new(bytes)) else {
            return false;
        };
        for index in 0..zip.len() {
            let Ok(mut entry) = zip.by_index(index) else {
                continue;
            };
            let name = entry.name().to_string();
            if name.ends_with(suffix) {
                return true;
            }
            if name.ends_with(".usdz") {
                let mut contents = Vec::new();
                if entry.read_to_end(&mut contents).is_ok()
                    && contains_entry_with_suffix(&contents, suffix)
                {
                    return true;
                }
            }
        }
        false
    }
    let saved = std::fs::read(&out).expect("package reads");
    assert!(
        contains_entry_with_suffix(&saved, "inner.usdz"),
        "the nested archive must be packaged inside the result"
    );

    // Reopen: composition through the nested package must still resolve.
    let reopened = openusd::usd::Stage::open(out.to_string_lossy().as_ref())
        .expect("the repacked archive reopens");
    reopened
        .traverse(openusd::usd::PrimPredicate::ALL, |_| {})
        .expect("reopened stage composes");
    let errors = reopened.composition_errors();
    assert!(
        errors.is_empty(),
        "composition through the nested package must be clean: {errors:?}"
    );
    // The bare reference maps the packaged /Pinned prim ONTO /R (explicit
    // prim paths and defaultPrim both compose onto the referencing prim).
    let depth = reopened
        .attribute("/R.depth")
        .expect("depth attribute")
        .get_at::<f64>(openusd::usd::TimeCode::new(0.0))
        .expect("depth reads");
    assert_eq!(depth, Some(7.5), "the nested layer's opinion survives");
}

#[test]
fn save_stage_as_usdz_rejects_the_original_archive() {
    let (state, _events) = owner_with_events();
    let dir = tempfile::tempdir().expect("temp dir");
    let original = open_usdz_via_owner(&state, dir.path());
    let before = std::fs::read(&original).expect("original bytes");

    let error = usdbee_lib::stage::request_save_stage_as_usdz(
        &state.sender(),
        original.to_string_lossy().as_ref(),
    )
    .expect_err("the original archive must not be overwritten");

    assert!(error.contains("original"), "got: {error}");
    assert_eq!(std::fs::read(&original).expect("original re-read"), before);
}

#[test]
fn save_stage_as_usdz_rejects_extraction_flow_original_archive() {
    let (state, _events) = owner_with_events();
    let dir = tempfile::tempdir().expect("temp dir");
    let original = dir.path().join("original.usdz");
    openusd::sdf::Layer::open(fixture("basic.usda").to_string_lossy().as_ref())
        .expect("basic layer")
        .export(original.to_string_lossy().as_ref())
        .expect("original archive");
    let extracted = dir.path().join("extracted.usda");
    std::fs::copy(fixture("basic.usda"), &extracted).expect("extracted root");
    state.open_flow(&extracted, true, Some(&original), None);
    let before = std::fs::read(&original).expect("original bytes");

    usdbee_lib::stage::request_save_stage_as_usdz(
        &state.sender(),
        original.to_string_lossy().as_ref(),
    )
    .expect_err("the extraction-flow original is protected too");

    assert_eq!(std::fs::read(&original).expect("original re-read"), before);
}

#[test]
fn save_stage_as_usdz_rejects_non_usdz_extensions() {
    let (state, _events) = owner_with_events();
    let dir = tempfile::tempdir().expect("temp dir");
    open_usdz_via_owner(&state, dir.path());

    for path in ["out.usda", "out.usdc", "out.txt"] {
        let error = usdbee_lib::stage::request_save_stage_as_usdz(&state.sender(), path)
            .expect_err("only .usdz destinations are writable");
        assert!(error.contains("usdz"), "got: {}", error);
    }
    let error = usdbee_lib::stage::request_save_stage_as_usdz(&state.sender(), "noextension")
        .expect_err("an extension-less destination is refused");
    assert!(error.contains("usdz"), "got: {}", error);
    assert_eq!(
        std::fs::read_dir(dir.path())
            .expect("temp dir lists")
            .count(),
        1,
        "only the packed.usdz fixture exists — no partial writes"
    );
}
