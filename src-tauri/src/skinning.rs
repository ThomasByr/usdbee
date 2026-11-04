//! UsdSkel skinning (skinning feature, Task 2): evaluate the skeletal
//! binding of one skinned prim at `time` and rewrite its points (and
//! vertex-scoped authored normals) in place, in the prim's own local
//! space — the same space `tessellation::mesh_data` reads points in.
//!
//! The math is entirely the openusd-schemas `skel` toolkit: binding
//! resolution (`BindingAPI`), the skeleton's static data
//! (`SkeletonResolver`), the per-prim influence set (`SkinningResolver`)
//! and the linear-blend-skinning helpers. The one piece this module owns
//! is the space mapping: the crate's `compute_skinned_points` returns
//! points in SKEL space (the SkelRoot's frame), so the results must be
//! mapped back into the mesh's local space through the mesh's
//! local-to-SkelRoot chain `L` (points through `L⁻¹`, normals through the
//! rotation part of `L⁻¹`, renormalized).
//!
//! The crate's resolver methods PANIC on rigid/per-vertex mismatches and
//! on influence stride mismatches; the backend never panics on user data,
//! so every crate call here is preceded by a validation guard and every
//! failure surfaces as a readable `Err` (the tessellation caller then
//! logs and renders the prim unskinned).

use std::collections::HashMap;

use openusd::gf::{Matrix4d, Vec3f};
use openusd::sdf;
use openusd::usd::{Prim, SchemaBase, TimeCode};
use openusd_schemas::skel::{
    skinning, Animation, BindingAPI, SkelAnimQuery, Skeleton, SkeletonResolver, SkinningResolver,
};

use crate::values;

fn err(context: &str, error: impl std::fmt::Display) -> String {
    format!("skinning {context}: {error}")
}

/// The nearest authored target of the `skel:` relationship `name` on
/// `prim` or one of its ancestors (pxr `GetInheritedSkeleton` /
/// `GetInheritedAnimationSource`). Replaces the crate's
/// `BindingAPI::inherited_*`, which in openusd-schemas 0.8.0 answers an
/// `Err` ("the pseudo-root cannot own properties") instead of `None`
/// when the walk reaches the root without a hit.
fn inherited_rel(prim: &Prim, name: &str) -> Result<Option<sdf::Path>, String> {
    let path = prim.path().to_string();
    let stage = prim.stage();
    let mut current = prim.path().clone();
    loop {
        if current.is_abs_root() {
            return Ok(None);
        }
        let rel = current.append_property(name).map_err(|e| err(&path, e))?;
        let targets = stage
            .relationship(rel)
            .map_err(|e| err(&path, e))?
            .targets()
            .map_err(|e| err(&path, e))?;
        if let Some(target) = targets.into_iter().next() {
            return Ok(Some(target));
        }
        let Some(parent) = current.parent() else {
            return Ok(None);
        };
        current = parent;
    }
}

/// The animation source bound to `prim`'s skinning binding, with pxr
/// precedence: a source authored on the SKELETON's chain wins over one
/// inherited from the mesh's own ancestors (OpenUSD#3532). `None` when
/// neither chain authors one (rest-pose fallback).
fn bound_animation_source(prim: &Prim, skeleton: &Skeleton) -> Result<Option<sdf::Path>, String> {
    Ok(inherited_rel(skeleton.prim(), "skel:animationSource")?
        .or(inherited_rel(prim, "skel:animationSource")?))
}

/// Per-walk cache for the manifest's skel motion scan: the
/// time-varying answer for one (skeleton, animation source) pair, shared
/// by every mesh bound to the same pair during one skeleton build.
pub(crate) type SkelAnimMemo = HashMap<(sdf::Path, Option<sdf::Path>), bool>;

/// Whether `prim`'s UsdSkel binding drives its points over time: the
/// bound animation's joint transforms might be time-varying. Resolution
/// reuses the skinning path's helpers (including the pxr precedence
/// above); `Ok(false)` for prims without a skeleton, without an
/// animation source, or with a broken binding — the manifest only flags
/// prims whose geometry playback must refetch, and tessellation reports
/// full binding errors.
pub(crate) fn skel_joint_transforms_vary(
    prim: &Prim,
    memo: &mut SkelAnimMemo,
) -> Result<bool, String> {
    let path = prim.path().to_string();
    let stage = prim.stage();
    let Some(skeleton_path) = inherited_rel(prim, "skel:skeleton")? else {
        return Ok(false);
    };
    let Some(skeleton) = Skeleton::get(stage, skeleton_path.clone()).map_err(|e| err(&path, e))?
    else {
        return Ok(false);
    };
    let anim_source = bound_animation_source(prim, &skeleton)?;
    let key = (skeleton_path, anim_source.clone());
    if let Some(varying) = memo.get(&key) {
        return Ok(*varying);
    }
    let varying = match anim_source {
        None => false,
        Some(anim_path) => {
            let Some(animation) = Animation::get(stage, anim_path).map_err(|e| err(&path, e))?
            else {
                return Ok(false);
            };
            let Some(query) = SkelAnimQuery::new(animation).map_err(|e| err(&path, e))? else {
                return Ok(false);
            };
            query
                .joint_transforms_might_be_time_varying()
                .map_err(|e| err(&path, e))?
        }
    };
    memo.insert(key, varying);
    Ok(varying)
}

/// Skin `points` (and, when passed, per-vertex `normals`) of `prim` at
/// `time` through its UsdSkel binding, in place. `Ok(false)` when the prim
/// carries no `SkelBindingAPI` (the common case; the caller skips) or
/// when the binding is rigidly deformed (rendered unskinned by scope
/// decision); `Ok(true)` when the arrays were rewritten; `Err` for a
/// detected-but-broken binding — in which case the inputs are left
/// untouched and the caller renders them unskinned.
///
/// shortcut: rigid (constant-interpolation) bindings render unskinned
/// instead of applying their single 4×4, and blend shapes and
/// dualQuaternion skinning are not evaluated (classic LBS only), when
/// real rig assets need them.
pub fn skin_mesh(
    prim: &Prim,
    time: Option<f64>,
    points: &mut Vec<Vec3f>,
    normals: Option<&mut Vec<Vec3f>>,
) -> Result<bool, String> {
    let path = prim.path().to_string();
    let stage = prim.stage();
    let Some(binding) = BindingAPI::get(stage, prim.path().clone()).map_err(|e| err(&path, e))?
    else {
        return Ok(false);
    };

    let Some(skeleton_path) = inherited_rel(prim, "skel:skeleton")? else {
        return Err(format!("skel binding without skeleton: {path}"));
    };
    let Some(skeleton) = Skeleton::get(stage, skeleton_path.clone()).map_err(|e| err(&path, e))?
    else {
        return Err(format!(
            "skel skeleton target is not a Skeleton: {}",
            skeleton_path
        ));
    };
    let skeleton_resolver =
        SkeletonResolver::from_skeleton(&skeleton).map_err(|e| err(&path, e))?;
    let joint_count = skeleton_resolver.joint_order().len();
    // The crate's compute_skinning_transforms panics on a length mismatch
    // between joints and bind transforms; an unauthored or mismatched
    // bindTransforms array is broken user data, not a panic.
    if skeleton_resolver.inverse_bind_transforms().len() != joint_count {
        return Err(format!(
            "skel skeleton {skeleton_path} has no bindTransforms matching its joints"
        ));
    }

    // Joint-local transforms at `time`, in the skeleton's joint order:
    // the bound animation's, remapped by name (pxr RemapTransforms gives
    // unmapped joints identity); or the skeleton's restTransforms when no
    // animation source is bound (the spec's fallback pose). The animation
    // source authored on the SKELETON's chain wins over the one inherited
    // from the mesh's ancestors (pxr precedence, OpenUSD#3532); both reads
    // are readable errors — a broken source relationship never silently
    // degrades to a rest-pose render.
    let anim_source = bound_animation_source(prim, &skeleton)?;
    let local_xforms = match anim_source {
        Some(anim_path) => {
            let Some(animation) =
                Animation::get(stage, anim_path.clone()).map_err(|e| err(&path, e))?
            else {
                return Err(format!(
                    "skel animation source is not a SkelAnimation: {anim_path}"
                ));
            };
            let Some(query) = SkelAnimQuery::new(animation).map_err(|e| err(&path, e))? else {
                return Err(format!("skel animation source has no joints: {anim_path}"));
            };
            // shortcut: openusd has no default-time sentinel, so a `None`
            // time reads the animation at time 0, when a real stage-level
            // default-time query is needed.
            let anim_locals = query
                .compute_joint_local_transforms(TimeCode::new(time.unwrap_or(0.0)))
                .map_err(|e| err(&path, e))?;
            let mut locals = vec![Matrix4d::IDENTITY; joint_count];
            for (anim_index, target) in skeleton
                .map_anim_joints(query.joint_order())
                .map_err(|e| err(&path, e))?
                .iter()
                .enumerate()
            {
                if let Some(skeleton_index) = target {
                    locals[*skeleton_index] = anim_locals[anim_index];
                }
            }
            locals
        }
        None => {
            let rest = skeleton_resolver.rest_pose_local().to_vec();
            if rest.len() != joint_count {
                return Err(format!(
                    "skel skeleton {skeleton_path} has no restTransforms matching its joints (and no animation source)"
                ));
            }
            rest
        }
    };

    let skel_xforms = skeleton_resolver.joint_local_to_skel_space(&local_xforms);
    // Skinning transforms in skel space: inverse(bind) · joint.
    let skinning_xforms = skinning::compute_skinning_transforms(
        &skel_xforms,
        skeleton_resolver.inverse_bind_transforms(),
    );

    let skinning_resolver =
        SkinningResolver::from_binding(&binding, skeleton_resolver.joint_order())
            .map_err(|e| err(&path, e))?;

    if skinning_resolver.is_rigidly_deformed() {
        return Ok(false);
    }
    if !skinning_resolver.has_joint_influences() {
        return Err(format!("skel binding without joint influences: {path}"));
    }

    // Every guard below mirrors an assert the crate would panic on.
    let indices = binding
        .joint_indices()
        .map_err(|e| err(&path, e))?
        .unwrap_or_default();
    let influences = skinning_resolver.num_influences_per_component();
    let weights_len = match binding
        .joint_weights_attr()
        .get::<sdf::Value>()
        .map_err(|e| err(&path, e))?
    {
        // The resolver widens double-authored weights, so measure the raw
        // value either way (mirrors the crate's own decode).
        Some(sdf::Value::FloatVec(values)) => values.len(),
        Some(sdf::Value::DoubleVec(values)) => values.len(),
        _ => 0,
    };
    if indices.len() != weights_len {
        return Err(format!(
            "skel jointIndices/jointWeights length mismatch on {path}: {} != {}",
            indices.len(),
            weights_len
        ));
    }
    if indices.len() != points.len() * influences {
        return Err(format!(
            "skel jointIndices length {} on {path} does not match {} points x {influences} influences",
            indices.len(),
            points.len()
        ));
    }
    if indices
        .iter()
        .any(|&index| index < 0 || index as usize >= skinning_resolver.joint_order_len())
    {
        return Err(format!("skel jointIndices out of range on {path}"));
    }
    if let Some(normals) = &normals {
        if normals.len() != points.len() {
            return Err(format!(
                "skel normals length {} on {path} does not match {} points",
                normals.len(),
                points.len()
            ));
        }
    }

    // Points out of the crate are in skel space; the mesh renders in its
    // own local space, so map back through the local-to-SkelRoot chain L.
    let skinned_points = skinning_resolver.compute_skinned_points(points, &skinning_xforms);
    let local_to_skel = local_to_skel_root(prim, time)?;
    let Some(skel_to_local) = local_to_skel.inverse() else {
        return Err(format!(
            "skel local-to-SkelRoot transform is not invertible on {path}"
        ));
    };
    *points = skinned_points
        .iter()
        .map(|point| skel_to_local.transform_point(*point))
        .collect();
    if let Some(normals) = normals {
        let skinned_normals = skinning_resolver.compute_skinned_normals(normals, &skinning_xforms);
        // Normals are directions: no translation, renormalize after the
        // mapping (non-uniform scale in the chain would need the
        // inverse-transpose; shortcut: the rotation part suffices for the
        // rigid-bone transforms real rigs use).
        *normals = skinned_normals
            .iter()
            .map(|normal| skel_to_local.transform_vec(*normal).normalize())
            .collect();
    }
    Ok(true)
}

/// The prim's local-to-skel-root transform: the product of the local
/// transforms from the prim up to (excluding) its SkelRoot ancestor —
/// the chain skinning results must be mapped back through. Same
/// `!resetXformStack!` rule as `values::world_transform`: a prim that
/// resets the stack does not inherit ancestor transforms, so the chain
/// restarts at it (prims above it contribute nothing). An ancestor op
/// that cannot be evaluated, or a binding with no SkelRoot ancestor at
/// all (UsdSkel requires the enclosing scope), is an error.
fn local_to_skel_root(prim: &Prim, time: Option<f64>) -> Result<Matrix4d, String> {
    let path = prim.path().to_string();
    // Namespace walk (type names only, no xforms) up to the SkelRoot.
    let mut ancestry = Vec::new();
    let mut current = prim.clone();
    loop {
        let is_skel_root = current
            .type_name()
            .map_err(|e| err(&path, e))?
            .is_some_and(|name| name.as_str() == "SkelRoot");
        ancestry.push(current.clone());
        if is_skel_root {
            break;
        }
        let Some(parent) = current.parent() else {
            return Err(format!("skel binding without SkelRoot ancestor: {path}"));
        };
        current = parent;
    }
    // The SkelRoot itself is excluded: skel space is SkelRoot-relative.
    let mut acc = Matrix4d::IDENTITY;
    for ancestor in ancestry.iter().rev().skip(1) {
        if values::resets_xform_stack(ancestor, time)? {
            acc = Matrix4d::IDENTITY;
        }
        if let Some(matrix) = values::local_transform(ancestor, time)? {
            acc = matrix * acc;
        } else {
            return Err(format!(
                "skel xform chain has an unevaluable op on {}",
                ancestor.path()
            ));
        }
    }
    Ok(acc)
}
