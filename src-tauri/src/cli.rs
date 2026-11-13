use serde::Serialize;

pub const USAGE: &str = "usage: usdbee [-h] [-p x,y,z | --camera-position x,y,z] [-t x,y,z | --camera-target x,y,z] [FILE...]";

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct LaunchOptions {
    pub files: Vec<String>,
    pub camera_position: Option<[f64; 3]>,
    pub camera_target: Option<[f64; 3]>,
}

/// The IPC payload: same shape as the parsed options, snake_case fields.
pub type LaunchOptionsJson = LaunchOptions;

#[tauri::command]
pub fn get_launch_options(
    options: tauri::State<'_, LaunchOptions>,
) -> Result<LaunchOptionsJson, String> {
    Ok(options.inner().clone())
}

pub fn wants_help(args: &[String]) -> bool {
    args.iter().any(|arg| arg == "-h" || arg == "--help")
}

fn usage_error(message: &str) -> String {
    format!("usdbee: {message}\n{USAGE}")
}

// A coordinate tuple is either one comma-separated token ("1,2,3") or three
// tokens ("1 2 3"); both consume exactly what they read from the front.
fn parse_triple(rest: &[String]) -> Result<([f64; 3], usize), String> {
    let mut parts: Vec<&str> = rest
        .first()
        .ok_or_else(|| usage_error("missing camera coordinates"))?
        .split(',')
        .map(str::trim)
        .collect();
    let mut consumed = 1;
    while parts.len() < 3 {
        let token = rest
            .get(consumed)
            .ok_or_else(|| usage_error("camera coordinates need 3 values"))?;
        parts.extend(token.split(',').map(str::trim));
        consumed += 1;
    }
    if parts.len() != 3 {
        return Err(usage_error("camera coordinates need exactly 3 values"));
    }
    let mut values = [0.0; 3];
    for (slot, part) in values.iter_mut().zip(&parts) {
        *slot = part
            .parse::<f64>()
            .ok()
            .filter(|v| v.is_finite())
            .ok_or_else(|| usage_error(&format!("bad camera coordinate: {part}")))?;
    }
    Ok((values, consumed))
}

pub fn parse_launch_args(args: &[String]) -> Result<LaunchOptions, String> {
    let mut options = LaunchOptions::default();
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        index += 1;
        let slot = match arg {
            "-h" | "--help" => continue,
            "-p" | "--camera-position" => &mut options.camera_position,
            "-t" | "--camera-target" => &mut options.camera_target,
            _ if arg.starts_with('-') && arg != "-" => {
                return Err(usage_error(&format!("unknown option: {arg}")))
            }
            _ => {
                options.files.push(arg.to_string());
                continue;
            }
        };
        let (values, consumed) = parse_triple(&args[index..])?;
        index += consumed;
        *slot = Some(values);
    }
    Ok(options)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parse_launch_empty_argv_is_empty_options() {
        let options = parse_launch_args(&[]).unwrap();
        assert!(options.files.is_empty());
        assert_eq!(options.camera_position, None);
        assert_eq!(options.camera_target, None);
    }

    #[test]
    fn parse_launch_positionals_are_collected() {
        let options = parse_launch_args(&args(&["a.usd", "b usd/c.usda"])).unwrap();
        assert_eq!(options.files, args(&["a.usd", "b usd/c.usda"]));
    }

    #[test]
    fn parse_launch_camera_position_comma_separated() {
        let options = parse_launch_args(&args(&["-p", "1,2,3", "a.usd"])).unwrap();
        assert_eq!(options.camera_position, Some([1.0, 2.0, 3.0]));
        assert_eq!(options.files, args(&["a.usd"]));
    }

    #[test]
    fn parse_launch_camera_position_long_flag_comma_separated() {
        let options = parse_launch_args(&args(&["--camera-position", "1.5,-2,3e2"])).unwrap();
        assert_eq!(options.camera_position, Some([1.5, -2.0, 300.0]));
    }

    #[test]
    fn parse_launch_camera_target_space_separated() {
        let options = parse_launch_args(&args(&["-t", "4", "5", "6", "a.usd"])).unwrap();
        assert_eq!(options.camera_target, Some([4.0, 5.0, 6.0]));
        assert_eq!(options.files, args(&["a.usd"]));
    }

    #[test]
    fn parse_launch_camera_target_long_flag_space_separated() {
        let options = parse_launch_args(&args(&["--camera-target", "4", "5", "6"])).unwrap();
        assert_eq!(options.camera_target, Some([4.0, 5.0, 6.0]));
    }

    #[test]
    fn parse_launch_mixed_order_works() {
        let options = parse_launch_args(&args(&[
            "a.usd",
            "-p",
            "1,2,3",
            "b.usd",
            "--camera-target",
            "0",
            "0",
            "0",
            "c.usd",
        ]))
        .unwrap();
        assert_eq!(options.files, args(&["a.usd", "b.usd", "c.usd"]));
        assert_eq!(options.camera_position, Some([1.0, 2.0, 3.0]));
        assert_eq!(options.camera_target, Some([0.0, 0.0, 0.0]));
    }

    #[test]
    fn parse_launch_wants_help_on_both_flags() {
        assert!(wants_help(&args(&["-h"])));
        assert!(wants_help(&args(&["a.usd", "--help"])));
        assert!(!wants_help(&args(&["--camera-position", "1,2,3"])));
    }

    #[test]
    fn parse_launch_bad_triple_is_an_error_with_usage() {
        for bad in [
            &["-p", "1,2"][..],
            &["-p", "1,2,3,4"][..],
            &["-p", "1,2,x"][..],
            &["-p", "1,2,inf"][..],
            &["--camera-target"][..],
        ] {
            let error = parse_launch_args(&args(bad)).expect_err("bad triple must fail");
            assert!(
                error.contains(USAGE),
                "{:?} error must show usage: {error}",
                bad
            );
        }
    }

    #[test]
    fn parse_launch_unknown_flag_is_an_error_with_usage() {
        let error =
            parse_launch_args(&args(&["--nope", "a.usd"])).expect_err("unknown flag must fail");
        assert!(error.contains(USAGE));
    }
}
