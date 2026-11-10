// Idle-gap warmup (Wave 3 MP-A): the owner pre-evaluates authored time codes
// between commands so the first playback pass hits warm caches. The queue is
// filled from the manifest skeleton, advanced one pose per idle gap, and
// dropped by every invalidation site (open, edit) — these tests pin all three.

mod common;

use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use usdbee_lib::stage::{
    request_animated_pose, request_set_attribute_value, request_time_codes,
    request_warmup_progress, StageRequest,
};
use usdbee_lib::values::ValuePayload;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn payload(r#type: &str, data: serde_json::Value) -> ValuePayload {
    ValuePayload {
        r#type: r#type.to_string(),
        data,
        truncated: None,
        count: None,
    }
}

/// Poll the warmup until the whole code list is done. Every poll is itself a
/// command, so the owner serves it first and then spends the next idle gap on
/// one warm pose: the loop advances at least one code per iteration.
fn wait_until_warm(sender: &mpsc::Sender<StageRequest>) -> (usize, usize) {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let progress = request_warmup_progress(sender).expect("progress should reply");
        if progress.1 > 0 && progress.0 >= progress.1 {
            return progress;
        }
        assert!(
            Instant::now() < deadline,
            "warmup stalled at {}/{}",
            progress.0,
            progress.1
        );
    }
}

#[test]
fn idle_warmup_evaluates_every_authored_code() {
    let state = common::spawn_stage_owner();
    state.open(&fixture("many_codes.usda"));
    let sender = state.sender();

    let codes = request_time_codes(&sender).expect("time codes");
    assert_eq!(codes.len(), 240, "the fixture authors one code per frame");

    let (warmed, total) = wait_until_warm(&sender);
    assert_eq!(total, codes.len(), "the queue is the authored code list");
    assert_eq!(warmed, total);

    // The warm pass paid for the tessellation, so the playback that follows
    // is pure cache: no new mesh is built for any code it already warmed.
    let tessellations = state.mesh_tessellations();
    for code in [0.0, 120.0, 239.0] {
        request_animated_pose(&sender, Some(code)).expect("pose should reply");
    }
    assert_eq!(
        state.mesh_tessellations(),
        tessellations,
        "a warmed code must not tessellate again"
    );
}

#[test]
fn warmed_frames_are_the_poses_playback_gets_after_an_edit() {
    let state = common::spawn_stage_owner();
    state.open(&fixture("many_codes.usda"));
    let sender = state.sender();

    let before = request_animated_pose(&sender, Some(5.0)).expect("pose should reply");
    wait_until_warm(&sender);
    assert_eq!(
        request_animated_pose(&sender, Some(5.0)).expect("pose should reply"),
        before,
        "a warmed frame is byte-identical to the pose it was warmed from"
    );

    // A sampled write drops the queue with the caches, so the re-warm that
    // follows must read the post-edit stage, never the pre-edit one.
    request_set_attribute_value(
        &sender,
        "/Scene/Slider",
        "xformOp:translate",
        &payload("vec3d", serde_json::json!([7.0, 0.0, 0.0])),
        Some(5.0),
    )
    .expect("the edit should commit");

    let after = request_animated_pose(&sender, Some(5.0)).expect("pose should reply");
    assert_ne!(after, before, "the edit must reach the frame");

    let (warmed, total) = wait_until_warm(&sender);
    assert_eq!(warmed, total);
    assert_eq!(
        request_animated_pose(&sender, Some(5.0)).expect("pose should reply"),
        after,
        "the queue restarted after the edit and warmed the renamed bytes"
    );
}

#[test]
fn a_command_is_served_while_the_queue_is_still_pending() {
    let state = common::spawn_stage_owner();
    state.open(&fixture("many_codes.usda"));
    let sender = state.sender();

    // Sent straight after the open reply, so the owner has had only a couple
    // of idle gaps: 240 codes cannot be warm yet, and the pose must not wait
    // for them.
    request_animated_pose(&sender, Some(3.0)).expect("pose should reply");

    let (warmed, total) = request_warmup_progress(&sender).expect("progress should reply");
    assert!(total > 0, "the queue should be filled by now");
    assert!(
        warmed < total,
        "the pose preempted the warmup instead of queueing behind it: {warmed}/{total}"
    );
}
