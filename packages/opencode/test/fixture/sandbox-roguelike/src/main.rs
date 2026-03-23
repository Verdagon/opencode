#![deny(nonstandard_style, rust_2018_idioms)]
#![cfg_attr(not(test), deny(warnings, unused))]
#![allow(dead_code, unused)]
#![deny(
    future_incompatible,
    clippy::all,
    clippy::restriction,
    clippy::pedantic,
    clippy::nursery,
    clippy::cargo
)]
#![allow(clippy::integer_arithmetic)]
#![allow(clippy::missing_inline_in_public_items)]
#![allow(clippy::multiple_crate_versions)]
#![allow(clippy::implicit_return)]

use atoi::atoi;
use std::env;
use std::time::SystemTime;

#[macro_use]
extern crate derive_new;

mod astar;
mod benchmark_rl;
mod entity;
mod game;
mod level;
mod location;
mod make_level;
mod screen;
mod tile;

fn get_int_arg(args: &Vec<String>, param_str: &str, default: i32) -> i32 {
    match args.iter().position(|x| x == param_str) {
        None => {
            return default;
        }
        Some(pos) => {
            let int_index = pos + 1;
            if int_index >= args.len() {
                panic!(
                    "Must have a number after {}. Use --help for help.",
                    param_str
                );
            }
            let width_str = &args[int_index];
            match atoi(width_str.as_bytes()) {
                None => panic!(
                    "Must have a number after {}.  Use --help for help.",
                    param_str
                ),
                Some(w) => return w,
            }
        }
    };
}

fn main() {
    let args: Vec<String> = env::args().collect();

    match args.iter().position(|x| x == "--help") {
        None => {}
        Some(_) => {
            println!(
                "
--width N       Sets level width.
--height N      Sets level height.
--num_levels N  Sets number of levels until game end.
--seed N        Uses given seed for level generation. If absent, random.
--display N     0 to not display, 1 to display.
--turn_delay N       Sleeps for N ms between each turn.
--only-level         Only generate and display the level, then exit.
--debug-turn N       Print game state after turn N and exit.
--print-final-state  Print game state before exiting.
"
            );
            return;
        }
    }

    let level_width = get_int_arg(&args, "--width", 80);
    let level_height = get_int_arg(&args, "--height", 22);
    let num_levels = get_int_arg(&args, "--num_levels", 2);
    let seed = get_int_arg(
        &args,
        "--seed",
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("No system time!")
            .as_secs() as i32,
    );
    let display = get_int_arg(&args, "--display", 1) != 0;
    let turn_delay = get_int_arg(&args, "--turn_delay", 100);
    let only_level = args.iter().any(|x| x == "--only-level");
    let debug_turn = get_int_arg(&args, "--debug-turn", -1);
    let print_final_state = args.iter().any(|x| x == "--print-final-state");

    benchmark_rl::benchmark_rl(
        seed,
        level_width,
        level_height,
        num_levels,
        display,
        turn_delay,
        only_level,
        debug_turn,
        print_final_state,
    );
}
