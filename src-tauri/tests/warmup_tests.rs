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
    request_warmup_progress, StageRequest, WARMUP_QUIET_MS,
};
use usdbee_lib::values::ValuePayload;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
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

// The warm step assembles the whole frame, not just the attribute composition:
// playback's first pass over a warmed code must find both the packed meshes and
// the encoded frame in the caches, i.e. no tessellation and a frame-cache hit.
#[test]
fn a_warmed_code_serves_its_frame_from_the_cache() {
    let state = common::spawn_stage_owner();
    state.open(&fixture("many_codes.usda"));
    let sender = state.sender();

    // Warming waits for the skeleton the first manifest request builds (a warm
    // step must stay one pose), so ask for the codes first.
    let codes = request_time_codes(&sender).expect("time codes");
    assert_eq!(codes.len(), 240, "the fixture authors one code per frame");

    let (warmed, total) = wait_until_warm(&sender);
    assert_eq!(warmed, total);

    let hits = state.pose_frame_hits();
    let tessellations = state.mesh_tessellations();
    let first = request_animated_pose(&sender, Some(7.0)).expect("pose should reply");
    let again = request_animated_pose(&sender, Some(7.0)).expect("pose should reply");

    assert_eq!(first, again, "a cached frame is byte-identical");
    assert_eq!(
        state.mesh_tessellations(),
        tessellations,
        "the warm step already tessellated this code"
    );
    assert_eq!(
        state.pose_frame_hits(),
        hits + 2,
        "both poses are frame-cache hits, so the warm step assembled the frame"
    );
}

// An edit landing mid-pass drops the queue with the caches. The frame playback
// gets right after the edit must be the post-edit one: a stale frame landing
// after the clear would serve pre-edit geometry for a whole loop.
#[test]
fn an_edit_mid_warmup_lands_no_stale_frame() {
    let state = common::spawn_stage_owner();
    state.open(&fixture("many_codes.usda"));
    let sender = state.sender();

    let before = request_animated_pose(&sender, Some(5.0)).expect("pose should reply");
    // Catch the queue mid-pass: it is only filled on an idle gap, so poll until
    // one has happened and most of the 240 codes are still pending.
    let deadline = Instant::now() + Duration::from_secs(30);
    let midpass = loop {
        let progress = request_warmup_progress(&sender).expect("progress should reply");
        if progress.1 > 0 && progress.0 < progress.1 {
            break progress;
        }
        assert!(
            Instant::now() < deadline,
            "the queue never started: {progress:?}"
        );
    };
    assert!(
        midpass.0 < midpass.1,
        "the queue should still be mid-pass: {midpass:?}"
    );

    request_set_attribute_value(
        &sender,
        "/Scene/Slider",
        "xformOp:translate",
        &payload("vec3d", serde_json::json!([7.0, 0.0, 0.0])),
        Some(5.0),
    )
    .expect("the edit should commit");

    let edited = request_animated_pose(&sender, Some(5.0)).expect("pose should reply");
    assert_ne!(edited, before, "the edit must reach the frame right away");

    let (warmed, total) = wait_until_warm(&sender);
    assert_eq!(warmed, total);
    assert_eq!(
        request_animated_pose(&sender, Some(5.0)).expect("pose should reply"),
        edited,
        "the restarted pass warmed the post-edit bytes"
    );
}

// An edit drops the queue with the caches, and the pass must restart at the
// FIRST code: keeping the cursor would leave every code before it cold for the
// rest of the session. The edit here authors no time samples (a default-time
// visibility write), so the code list survives it and the reset is observable.
#[test]
fn an_edit_restarts_the_queue_at_the_first_code() {
    let state = common::spawn_stage_owner();
    state.open(&fixture("many_codes.usda"));
    let sender = state.sender();

    let codes = request_time_codes(&sender).expect("time codes");
    let first = codes[0];

    // Let the pass get under way: the cursor must be past the first code for
    // the restart to be what puts it back in the caches.
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let progress = request_warmup_progress(&sender).expect("progress should reply");
        if progress.1 > 0 && progress.0 >= 4 && progress.0 < progress.1 {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the queue never started: {progress:?}"
        );
    }

    request_set_attribute_value(
        &sender,
        "/Scene/Slider",
        "visibility",
        &payload("token", serde_json::json!("invisible")),
        None,
    )
    .expect("the edit should commit");

    // The edit dropped the skeleton with the caches; warming waits for the
    // request that rebuilds it (a warm step is one pose, never a build).
    request_time_codes(&sender).expect("time codes");

    let (warmed, total) = wait_until_warm(&sender);
    assert_eq!(warmed, total);
    assert_eq!(total, codes.len(), "the edit kept the code list");

    let hits = state.pose_frame_hits();
    request_animated_pose(&sender, Some(first)).expect("pose should reply");
    assert_eq!(
        state.pose_frame_hits(),
        hits + 1,
        "the restarted pass warmed the first code too"
    );
}

#[test]
fn a_command_is_served_while_the_queue_is_still_pending() {
    let state = common::spawn_stage_owner();
    state.open(&fixture("many_codes.usda"));
    let sender = state.sender();

    // Sent straight after the open reply, so the owner has had only a couple
    // of idle gaps: 240 codes cannot be warm yet, and the pose must not wait
    // for them. The queue is filled on the next idle gap, which the pose reply
    // does not guarantee has happened yet: poll for it (each poll is itself a
    // command, so the pass advances at most one code per poll).
    request_animated_pose(&sender, Some(3.0)).expect("pose should reply");

    let deadline = Instant::now() + Duration::from_secs(30);
    let (warmed, total) = loop {
        let progress = request_warmup_progress(&sender).expect("progress should reply");
        if progress.1 > 0 {
            break progress;
        }
        assert!(
            Instant::now() < deadline,
            "the queue should be filled by now"
        );
    };
    assert!(
        warmed < total,
        "the pose preempted the warmup instead of queueing behind it: {warmed}/{total}"
    );
}

// Playback awareness (residual-stutter C2): a 12-pose batch is 13 owner turns
// with a queue-empty gap between each, and the owner takes such a gap for a
// warm step (~35-50 ms cold in dev), which the next pose then waits behind.
// Pose traffic therefore holds the warmup off until the owner has seen
// WARMUP_QUIET_MS of quiet.
#[test]
fn pose_traffic_keeps_the_idle_owner_from_warming() {
    let state = common::spawn_stage_owner();
    state.open(&fixture("many_codes.usda"));
    let sender = state.sender();

    // The pose is the request that builds the skeleton the queue needs, so no
    // code can have warmed before it: every code is still ahead of the cursor.
    request_animated_pose(&sender, Some(3.0)).expect("pose should reply");
    // Long past the owner's next idle poll, well inside the quiet window: a
    // gap this short belongs to playback, not to the warmup.
    std::thread::sleep(Duration::from_millis(WARMUP_QUIET_MS / 3));

    let progress = request_warmup_progress(&sender).expect("progress should reply");
    assert_eq!(
        progress.0, 0,
        "a warm step ran in the pose gap: {progress:?}"
    );
}

// The gate must not starve the warmup: once the window has elapsed the next
// idle gap warms again. How many codes that gap chain covers is not pinned
// (the owner keeps warming back to back until a command arrives).
#[test]
fn an_idle_gap_after_the_quiet_window_warms() {
    let state = common::spawn_stage_owner();
    state.open(&fixture("many_codes.usda"));
    let sender = state.sender();

    request_animated_pose(&sender, Some(3.0)).expect("pose should reply");
    // WARMUP_QUIET_MS plus slack for the timer and the owner's poll.
    std::thread::sleep(Duration::from_millis(WARMUP_QUIET_MS + 50));

    let deadline = Instant::now() + Duration::from_secs(30);
    let progress = loop {
        let progress = request_warmup_progress(&sender).expect("progress should reply");
        if progress.0 >= 1 {
            break progress;
        }
        assert!(
            Instant::now() < deadline,
            "the quiet window never warmed: {progress:?}"
        );
    };
    assert!(
        progress.1 > 1,
        "the queue is the authored code list: {progress:?}"
    );
}

// The batch's first turn is a GetTimeCodes, so the codes fetch has to stamp the
// timer as well: otherwise the owner warms in the gap between the codes reply
// and the batch's first pose request, which is inside the same batch wall.
#[test]
fn a_codes_fetch_keeps_the_idle_owner_from_warming() {
    let state = common::spawn_stage_owner();
    state.open(&fixture("many_codes.usda"));
    let sender = state.sender();

    // The codes fetch builds the skeleton, so this is the first request after
    // which the queue could fill.
    request_time_codes(&sender).expect("time codes");
    std::thread::sleep(Duration::from_millis(WARMUP_QUIET_MS / 3));

    let progress = request_warmup_progress(&sender).expect("progress should reply");
    assert_eq!(
        progress.0, 0,
        "a warm step ran in the codes gap: {progress:?}"
    );
}

// Load-then-idle is the warmup's headline flow: the load-time codes fetch
// builds the skeleton and stamps the quiet timer, then nothing else is sent
// until the user presses play. The owner must keep waking to warm on its own.
#[test]
fn an_idle_owner_warms_without_a_command_to_wake_it() {
    let state = common::spawn_stage_owner();
    state.open(&fixture("many_codes.usda"));
    let sender = state.sender();

    let codes = request_time_codes(&sender).expect("time codes");
    assert_eq!(codes.len(), 240, "the fixture authors one code per frame");
    // Long enough for the whole quiet window to elapse with no command at all.
    std::thread::sleep(Duration::from_millis(WARMUP_QUIET_MS + 50));

    // One poll, no loop: its reply is sent before the owner takes its next warm
    // step, so anything already warmed happened during the sleep.
    let progress = request_warmup_progress(&sender).expect("progress should reply");
    assert!(
        progress.0 >= 1,
        "the idle owner never warmed on its own: {progress:?}"
    );
}
