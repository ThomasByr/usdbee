//! UsdGeom camera introspection (Round 2 F5): every camera prim in a composed
//! stage -> `CameraInfo` for the look-through command. Pure over openusd types
//! — no Tauri types; in the app this runs inside the stage-owner thread
//! (stage.rs `GetCameras` arm) once per load.
//!
//! Fail-soft per prim: a camera whose typed reads break, or whose xform stack
//! cannot be evaluated, drops itself, never the stage. The traversal never
//! returns an error.
//!
//! Authored-only vs schema fallback: `projection`, `focal_length` and both
//! apertures fold the schema fallback (perspective, 50, 20.9550, 15.2908), so a
//! bare `def Camera` still frames a sane view. `clipping_range` stays
//! authored-only: USD's 1..1000000 fallback is scene-scale dependent, and the
//! frontend picks its own near/far instead.

use crate::values;
use openusd::sdf;
use openusd::usd::{PrimPredicate, Stage};
use openusd_schemas::geom::{Camera, CameraSchema};
use serde::{Deserialize, Serialize};

/// One stage camera, as the frontend's look-through consumes it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CameraInfo {
    pub path: String,
    /// The prim's name: the last component of `path`.
    pub name: String,
    /// `"perspective" | "orthographic"`.
    pub projection: String,
    pub focal_length: f64,
    pub horizontal_aperture: f64,
    pub vertical_aperture: f64,
    /// The authored clipping range as `[near, far]`; `None` where unauthored.
    #[serde(default)]
    pub clipping_range: Option<[f64; 2]>,
    /// The camera's world transform, row-major 4x4 in the USD row-vector
    /// convention (translation in the last row, forward = negated row 2) — the
    /// same shape and the same helper as `PrimDetails::world_transform`.
    pub world_transform: [f64; 16],
}

fn err(error: impl std::fmt::Display) -> String {
    format!("failed to read camera: {}", error)
}

/// Every camera prim reachable from the stage root, in traversal order.
pub fn stage_cameras(stage: &Stage, time: Option<f64>) -> Vec<CameraInfo> {
    let mut cameras = Vec::new();
    // A traversal error (a broken composition) ends the walk; the cameras read
    // before it stand. A per-prim read error drops only that camera.
    let _ = stage.traverse(PrimPredicate::DEFAULT, |path| {
        if let Ok(Some(info)) = camera_info(stage, path, time) {
            cameras.push(info);
        }
    });
    cameras
}

fn camera_info(
    stage: &Stage,
    path: &sdf::Path,
    time: Option<f64>,
) -> Result<Option<CameraInfo>, String> {
    let prim = stage.prim(path.clone()).map_err(err)?;
    if !prim.is_valid().map_err(err)? {
        return Ok(None);
    }
    let Some(camera) = Camera::from_prim(prim.clone()).map_err(err)? else {
        return Ok(None);
    };
    // A camera with no place cannot be looked through: drop it, never guess
    // an identity the stage did not author.
    let Some(world_transform) = values::world_transform(&prim, time).map_err(err)? else {
        return Ok(None);
    };

    // The `unwrap_or` values are USD's declared fallbacks; the getter already
    // folds them. These stand in only for a stage opened without the geom
    // registry.
    Ok(Some(CameraInfo {
        path: path.to_string(),
        name: path.name().unwrap_or_default().to_string(),
        projection: camera
            .projection()
            .map_err(err)?
            .unwrap_or_default()
            .as_token()
            .to_string(),
        focal_length: wide(camera.focal_length().map_err(err)?).unwrap_or(50.0),
        horizontal_aperture: wide(camera.horizontal_aperture().map_err(err)?).unwrap_or(20.955),
        vertical_aperture: wide(camera.vertical_aperture().map_err(err)?).unwrap_or(15.2908),
        clipping_range: authored_clipping_range(&camera)?,
        world_transform,
    }))
}

/// The clipping range only where a layer authors it: the schema fallback is a
/// placeholder, not a viewport's near/far.
fn authored_clipping_range(camera: &Camera) -> Result<Option<[f64; 2]>, String> {
    if !camera
        .clipping_range_attr()
        .has_authored_value()
        .map_err(err)?
    {
        return Ok(None);
    }
    Ok(camera
        .clipping_range()
        .map_err(err)?
        .map(|range| [range.x as f64, range.y as f64]))
}

/// An f32 schema value widened to the f64 the payload carries.
fn wide(value: Option<f32>) -> Option<f64> {
    value.map(|value| value as f64)
}
