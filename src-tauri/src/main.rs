// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[no_mangle]
pub static NvOptimusEnablement: i32 = 1;

#[no_mangle]
pub static AmdPowerXpressRequestHighPerformance: i32 = 1;

fn main() {
    usdbee_lib::run()
}
