//! UsdLux light introspection (Round 2 F4): every light prim in a composed
//! stage -> `LightInfo` for the viewport. Pure over openusd types — no Tauri
//! types; in the app this runs inside the stage-owner thread (stage.rs
//! `GetLights` arm) once per load.
//!
//! Fail-soft per prim: a prim whose typed reads break drops itself, never the
//! stage. The traversal never returns an error.
//!
//! Authored-only vs schema fallback: every shared light field and every
//! kind-specific size folds the schema fallback, so a bare `def SphereLight`
//! still maps to a sane light. Only `texture_file` (no declared fallback),
//! `shaping` (present only where ShapingAPI is applied) and `enabled` (the
//! prim's computed visibility) carry no fallback.

use crate::parser::display_path;
use crate::values;
use openusd::gf;
use openusd::sdf::{self, AssetPath};
use openusd::usd::{Prim, PrimPredicate, Stage, TimeCode};
use openusd_schemas::geom::{Imageable, ImageableExt, Visibility};
use openusd_schemas::lux::{
    CylinderLight, CylinderLightSchema, DiskLight, DiskLightSchema, DistantLight,
    DistantLightSchema, DomeLight, DomeLightSchema, DomeLight_1, DomeLight_1Schema, LightAPI,
    RectLight, RectLightSchema, ShadowAPI, ShapingAPI, SphereLight, SphereLightSchema,
};
use serde::{Deserialize, Serialize};

/// One stage light, as the frontend's light mapping consumes it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct LightInfo {
    pub path: String,
    /// `"sphere" | "disk" | "rect" | "cylinder" | "distant" | "dome"`.
    pub kind: String,
    pub intensity: f64,
    pub exposure: f64,
    pub color: [f64; 3],
    /// The prim's computed visibility: a light is enabled unless it (or an
    /// imageable ancestor) is `invisible`.
    pub enabled: bool,
    pub normalize: bool,
    pub casts_shadow: bool,
    #[serde(default)]
    pub radius: Option<f64>,
    #[serde(default)]
    pub angle: Option<f64>,
    #[serde(default)]
    pub width: Option<f64>,
    #[serde(default)]
    pub height: Option<f64>,
    #[serde(default)]
    pub length: Option<f64>,
    #[serde(default)]
    pub shaping: Option<Shaping>,
    #[serde(default)]
    pub texture_file: Option<String>,
    /// The light's world transform, row-major 4x4 in the USD row-vector
    /// convention (translation in the last row) — the same shape and the same
    /// helper as `PrimDetails::world_transform`. `None` when the prim's xform
    /// stack cannot be evaluated: the light still answers, without a place.
    #[serde(default)]
    pub world_transform: Option<[f64; 16]>,
}

/// The ShapingAPI cone a light applies. Both fields fold the schema fallback
/// (90 degrees, 0 softness) — an applied ShapingAPI means the light is shaped.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct Shaping {
    pub cone_angle: f64,
    pub cone_softness: f64,
}

fn err(error: impl std::fmt::Display) -> String {
    format!("failed to read light: {}", error)
}

/// Every light prim reachable from the stage root, in traversal order.
///
/// `PortalLight`, `GeometryLight` and `LightFilter` are recorded limits: they
/// map to no `kind`, so they are skipped rather than guessed at.
pub fn stage_lights(stage: &Stage, time: Option<f64>) -> Vec<LightInfo> {
    let mut lights = Vec::new();
    // A traversal error (a broken composition) ends the walk; the lights read
    // before it stand. A per-prim read error drops only that light.
    let _ = stage.traverse(PrimPredicate::DEFAULT, |path| {
        if let Ok(Some(info)) = light_info(stage, path, time) {
            lights.push(info);
        }
    });
    lights
}

fn light_info(
    stage: &Stage,
    path: &sdf::Path,
    time: Option<f64>,
) -> Result<Option<LightInfo>, String> {
    let prim = stage.prim(path.clone()).map_err(err)?;
    if !prim.is_valid().map_err(err)? {
        return Ok(None);
    }
    let Some(facts) = kind_facts(&prim)? else {
        return Ok(None);
    };

    // The shared light interface, through the unchecked view: the concrete
    // class views reach it the same way, and this keeps one read per field.
    // Every getter already folds the type's own schema fallback, so the
    // `unwrap_or` below never fires for a light read from a stage with this
    // family registered; it stands in only for one opened without the lux
    // registry.
    let light = LightAPI::from_prim_unchecked(prim.clone());
    let color = light
        .color()
        .map_err(err)?
        .unwrap_or(gf::vec3f(1.0, 1.0, 1.0));

    // shortcut: this crate's UsdLux (openusd-schemas 0.8.0) declares no
    // per-light `inputs:enable`, so the computed visibility is the switch;
    // upgrade if the schema gains an enable input
    let enabled = match Imageable::from_prim(prim.clone()).map_err(err)? {
        Some(imageable) => {
            imageable
                .compute_visibility(time.map(TimeCode::new))
                .map_err(err)?
                != Visibility::Invisible
        }
        None => true,
    };

    // Applied-API views gate on the prim's composed apiSchemas, so `shaping`
    // answers only for a light that applies ShapingAPI.
    let shaping = match ShapingAPI::from_prim(prim.clone()).map_err(err)? {
        Some(api) => Some(Shaping {
            cone_angle: api.shaping_cone_angle().map_err(err)?.unwrap_or(90.0) as f64,
            cone_softness: api.shaping_cone_softness().map_err(err)?.unwrap_or(0.0) as f64,
        }),
        None => None,
    };

    // A light that applies no ShadowAPI is not shadow-disabled: the schema's
    // own `shadow:enable` fallback (true) is what every renderer uses there.
    let casts_shadow = match ShadowAPI::from_prim(prim.clone()).map_err(err)? {
        Some(api) => api.shadow_enable().map_err(err)?.unwrap_or(true),
        None => true,
    };

    Ok(Some(LightInfo {
        path: path.to_string(),
        kind: facts.kind.to_string(),
        // The `unwrap_or` values are not USD's defaults: each type declares
        // its own fallback (DistantLight's `inputs:intensity` is 50000), and
        // the getter already folds it. These stand in only for a stage
        // opened without the lux registry.
        intensity: wide(light.intensity().map_err(err)?).unwrap_or(1.0),
        exposure: wide(light.exposure().map_err(err)?).unwrap_or(0.0),
        color: [color[0] as f64, color[1] as f64, color[2] as f64],
        enabled,
        normalize: light.normalize().map_err(err)?.unwrap_or(false),
        casts_shadow,
        radius: facts.radius,
        angle: facts.angle,
        width: facts.width,
        height: facts.height,
        length: facts.length,
        shaping,
        texture_file: facts.texture_file,
        // Fail-soft: an unevaluable stack drops the transform, never the light.
        world_transform: values::world_transform(&prim, time).ok().flatten(),
    }))
}

/// The kind-specific facts one light arm reads; `None` for a prim that is no
/// supported light kind.
#[derive(Default)]
struct KindFacts {
    kind: &'static str,
    radius: Option<f64>,
    angle: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
    length: Option<f64>,
    texture_file: Option<String>,
}

/// Detect the light kind through the typed class views (which answer through
/// the stage's schema registry, subtypes included) and read that kind's own
/// accessors. Each size folds the schema fallback; `texture_file` is
/// authored-only because the schema declares no fallback for it.
fn kind_facts(prim: &Prim) -> Result<Option<KindFacts>, String> {
    if let Some(light) = SphereLight::from_prim(prim.clone()).map_err(err)? {
        return Ok(Some(KindFacts {
            kind: "sphere",
            radius: wide(light.radius().map_err(err)?),
            ..KindFacts::default()
        }));
    }
    if let Some(light) = DiskLight::from_prim(prim.clone()).map_err(err)? {
        return Ok(Some(KindFacts {
            kind: "disk",
            radius: wide(light.radius().map_err(err)?),
            ..KindFacts::default()
        }));
    }
    if let Some(light) = RectLight::from_prim(prim.clone()).map_err(err)? {
        return Ok(Some(KindFacts {
            kind: "rect",
            width: wide(light.width().map_err(err)?),
            height: wide(light.height().map_err(err)?),
            texture_file: texture_file(light.texture_file().map_err(err)?),
            ..KindFacts::default()
        }));
    }
    if let Some(light) = CylinderLight::from_prim(prim.clone()).map_err(err)? {
        return Ok(Some(KindFacts {
            kind: "cylinder",
            length: wide(light.length().map_err(err)?),
            radius: wide(light.radius().map_err(err)?),
            ..KindFacts::default()
        }));
    }
    if let Some(light) = DistantLight::from_prim(prim.clone()).map_err(err)? {
        return Ok(Some(KindFacts {
            kind: "distant",
            angle: wide(light.angle().map_err(err)?),
            ..KindFacts::default()
        }));
    }
    if let Some(light) = DomeLight::from_prim(prim.clone()).map_err(err)? {
        return Ok(Some(KindFacts {
            kind: "dome",
            texture_file: texture_file(light.texture_file().map_err(err)?),
            ..KindFacts::default()
        }));
    }
    // `DomeLight_1` is its own class here (a `DomeLight` prim is not `is_a`
    // it, and the reverse), so it needs its own arm: without it a legacy
    // asset's dome light vanishes from the payload. Its shared fields read
    // the same way, through LightAPI.
    if let Some(light) = DomeLight_1::from_prim(prim.clone()).map_err(err)? {
        return Ok(Some(KindFacts {
            kind: "dome",
            texture_file: texture_file(light.texture_file().map_err(err)?),
            ..KindFacts::default()
        }));
    }
    Ok(None)
}

/// An f32 schema value widened to the f64 the payload carries.
fn wide(value: Option<f32>) -> Option<f64> {
    value.map(|value| value as f64)
}

/// The texture's file path: the resolved, frontend-fetchable path when the
/// file exists, the authored spelling otherwise (the fetch then fails soft
/// on the frontend side). An authored-but-empty path is no texture.
fn texture_file(value: Option<AssetPath>) -> Option<String> {
    let asset = value?;
    if asset.is_empty() {
        return None;
    }
    Some(match asset.resolved_path() {
        Some(resolved) => display_path(resolved),
        None => asset.authored_path.clone(),
    })
}
