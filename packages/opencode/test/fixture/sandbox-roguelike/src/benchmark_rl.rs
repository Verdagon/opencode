use generational_arena;
use generational_arena::Arena;
use rustc_hash::FxHashSet;
use std::thread::sleep;
use std::time::Duration;

use crate::entity::*;
use crate::game::*;
use crate::location::*;
use crate::make_level::*;
use crate::screen::*;

const DEFAULT_SIGHT_RANGE_100: i32 = 800;

// Returns whether we should probably re-display it next turn.
// Will be false if its something static like terrain, or true
// if it's something that moves around like a unit.
pub fn set_screen_cell(
    screen: &mut Screen,
    game: &Game,
    player_visible_locs: &FxHashSet<Location>,
    loc: Location,
) {
    let mut foreground_color = ScreenColor::White;
    let mut background_color = ScreenColor::Black;
    let mut character = " ";

    if let Some(tile) = game.get_current_level().tiles.get(&loc) {
        match tile.display_class.as_str() {
            "dirt" => {
                character = ".";
                foreground_color = ScreenColor::Orange;
            }
            "grass" => {
                character = ".";
                foreground_color = ScreenColor::Green;
            }
            "wall" => {
                character = "#";
                foreground_color = ScreenColor::Gray;
            }
            _ => panic!("unrecognized tile display class"),
        }
    }

    // Check for totems before entities (entities take priority over totems visually)
    for &totem_index in &game.get_current_level().totem_indices {
        if let Some(totem) = game.totems.get(totem_index) {
            if totem.loc == loc {
                character = "T";
                foreground_color = ScreenColor::Orange;
            }
        }
    }

    if let Some(&entity_index) = game.get_current_level().entity_by_location.get(&loc) {
        let entity = &game.entities[entity_index];
        if entity.is_player {
            character = "@";
            foreground_color = ScreenColor::Turquoise;
        } else {
            character = "g";
            foreground_color = ScreenColor::Green;
        }
    }

    if player_visible_locs.contains(&loc) {
        background_color = ScreenColor::DarkGray;
    }

    screen.set_cell(
        loc.x as usize,
        loc.y as usize,
        background_color,
        foreground_color,
        character.to_string(),
    );
}

// Moves the player to the next level.
// Returns true to continue with the game, false to exit the game.
pub fn descend_to_next_level(mut rand: &mut LCGRand, game: &mut Game) -> bool {
    let player_index = game.get_player_index();
    let old_player_loc = game.get_player().loc;
    let old_level_index = game.get_player().level_index;

    // Remove the player from the old level's entity-by-location index and entity_indices.
    game.levels[old_level_index]
        .entity_by_location
        .remove(&old_player_loc);
    game.levels[old_level_index]
        .entity_indices
        .retain(|&idx| idx != player_index);

    let player_mut = &mut game.entities[player_index];

    // Figure out the new level index.
    let player_new_level_index = player_mut.level_index + 1;
    // If we're descending past the last level, end the game.
    if player_new_level_index >= game.levels.len() {
        // End the game.
        return false;
    }

    // Move the player to the new level.
    player_mut.level_index = player_new_level_index;
    // Update the player's location so he's not, for example, embedded in the
    // middle of a wall, stuck helpless for all eternity.
    let new_player_loc =
        game.levels[player_new_level_index].find_random_walkable_unoccuped_location(&mut rand);
    game.entities[player_index].loc = new_player_loc;

    // Add the player to the new level's entity-by-location index and entity_indices.
    game.levels[player_new_level_index]
        .entity_by_location
        .insert(new_player_loc, player_index);
    game.levels[player_new_level_index]
        .entity_indices
        .push(player_index);

    // Continue with the game.
    return true;
}

pub fn setup(mut rand: &mut LCGRand, max_width: i32, max_height: i32, num_levels: i32) -> Game {
    let mut game = Game::new(Arena::new(), Vec::new(), None, Arena::new());

    for _level_num in 0..num_levels {
        let level_index = game.levels.len();
        game.levels
            .push(make_level(max_width, max_height, &mut rand));

        // Add one goblin for every 10 walkable spaces in the level.
        let num_walkable_locations = game.levels[level_index].get_walkable_locations().len();
        for goblin_index in 0..(num_walkable_locations / 10) {
            let new_entity_loc =
                game.levels[level_index].find_random_walkable_unoccuped_location(&mut rand);

            // Every 10th goblin at index 4, 14, 24, etc. is a priest
            let is_priest = (goblin_index + 1) % 10 == 5;

            let entity_index = game.add_entity_to_level(
                level_index,
                new_entity_loc,
                false,            // is_player
                10,               // hp
                10,               // max_hp
                Allegiance::Evil, // allegiance
                1,                // damage (goblin claws)
                is_priest,        // is_priest
            );

            // Every 10th goblin (0-indexed, so 9, 19, 29, etc.) forms a squad with 2 squadmates
            if (goblin_index + 1) % 10 == 0 {
                // Create a new squad in the level's squads vector
                let squad_index = game.levels[level_index].squads.len();
                game.levels[level_index]
                    .squads
                    .push(crate::entity::Squad::new());
                game.levels[level_index].squads[squad_index].add_member(entity_index);
                game.entities[entity_index].squad = Some(squad_index);

                // Add up to two more squadmates adjacent to the leader
                let adjacent = crate::game::get_pattern_adjacent_locations(new_entity_loc, true);
                let mut available_spots: Vec<Location> = Vec::new();
                for loc in adjacent {
                    if game.levels[level_index].loc_is_walkable(loc, true) {
                        available_spots.push(loc);
                    }
                }

                // Only create squadmates if there are adjacent spots available
                let num_squadmates = std::cmp::min(2, available_spots.len());
                for i in 0..num_squadmates {
                    let squadmate_loc = available_spots[i];

                    let squadmate_index = game.add_entity_to_level(
                        level_index,
                        squadmate_loc,
                        false,            // is_player
                        10,               // hp
                        10,               // max_hp
                        Allegiance::Evil, // allegiance
                        1,                // damage (goblin claws)
                        false,            // is_priest
                    );
                    game.entities[squadmate_index].squad = Some(squad_index);
                    game.levels[level_index].squads[squad_index].add_member(squadmate_index);
                }
            }
        }

        // Spawn 10 totems per level
        for _ in 0..10 {
            let totem_loc =
                game.levels[level_index].find_random_walkable_unoccuped_location(&mut rand);
            let totem = Totem::new(totem_loc);
            let totem_index = game.totems.insert(totem);
            game.levels[level_index].totem_indices.push(totem_index);
        }
    }

    let player_loc = game.levels[0].find_random_walkable_unoccuped_location(&mut rand);
    let player_index = game.add_entity_to_level(
        0,
        player_loc,
        true,             // is_player
        2000,             // hp
        2000,             // max_hp
        Allegiance::Good, // allegiance
        9,                // damage (sword: 700 initial + 200 add = 900 / 100 = 9)
        false,            // is_priest
    );
    game.player_index = Some(player_index);

    return game;
}

// Advance the game by 1 turn for all entities.
pub fn turn(rand: &mut LCGRand, game: &mut Game, _debug_output: bool) {
    // Update all totems' affected entities before processing entity turns
    let player_level_index = game.get_player().level_index;
    let totem_indices: Vec<generational_arena::Index> =
        game.levels[player_level_index].totem_indices.clone();

    for totem_index in totem_indices {
        if game.totems.contains(totem_index) {
            update_totem_auras(game, totem_index);
        }
    }

    // Update all priests' affected entities
    let entity_indices = game.levels[player_level_index].entity_indices.clone();

    for entity_index in entity_indices {
        if game.entities.contains(entity_index) && game.entities[entity_index].is_priest {
            update_priest_auras(game, entity_index);
        }
    }

    // Get a list of entity indices to iterate over, so that entity
    // spawning/removal doesn't modify the entities array while we're iterating.
    let entity_indices = game.get_current_level().entity_indices.clone();

    // Now iterate over them, only considering ones that are still alive.
    for &entity_index in entity_indices.iter() {
        if !game.entities.contains(entity_index) {
            continue;
        }

        process_entity_turn(entity_index, rand, game);
    }

    // Cleanup phase: remove dead entities (corpse blocking during turn)
    let current_level_index = game.get_player().level_index;
    let dead_entities: Vec<(generational_arena::Index, Location)> = game.levels
        [current_level_index]
        .entity_indices
        .iter()
        .filter(|&&index| game.entities.contains(index) && game.entities[index].hp <= 0)
        .map(|&index| (index, game.entities[index].loc))
        .collect();

    for (entity_index, loc) in dead_entities {
        game.levels[current_level_index]
            .entity_by_location
            .remove(&loc);
        game.levels[current_level_index]
            .entity_indices
            .retain(|&idx| idx != entity_index);
        game.entities.remove(entity_index);
    }
}

pub fn display(seed: i32, maybe_screen: &mut Option<Screen>, game: &Game) {
    let maybe_player_loc = game.entities.get(game.get_player_index()).map(|p| p.loc);
    let player_visible_locs = match maybe_player_loc {
        None => FxHashSet::default(),
        Some(player_loc) => game
            .get_current_level()
            .get_locations_within_sight(player_loc, true, DEFAULT_SIGHT_RANGE_100)
            .into_iter()
            .collect(),
    };

    if let Some(mut screen) = maybe_screen.as_mut() {
        for x in 0..game.get_current_level().max_width {
            for y in 0..game.get_current_level().max_height {
                let loc = Location::new(x, y);
                set_screen_cell(&mut screen, &game, &player_visible_locs, loc);
            }
        }
        if let Some(player) = game.entities.get(game.get_player_index()) {
            screen.set_status_line(format!("Seed {}   Level {}   HP: {} / {}\nTo benchmark: --seed 1337 --width 40 --height 30 --num_levels 5 --turn_delay 0 --display 0", seed, player.level_index, player.hp, player.max_hp));
        } else {
            screen.set_status_line("Dead!                                      ".to_string());
        }
        screen.paint_screen();
    }
}

fn print_game_state(game: &Game) {
    println!("Entities:");
    let mut entity_indices: Vec<generational_arena::Index> = Vec::new();
    for level in &game.levels {
        entity_indices.extend(&level.entity_indices);
    }
    entity_indices.sort();
    for &entity_index in entity_indices.iter() {
        if let Some(entity) = game.entities.get(entity_index) {
            let squad_info = if let Some(squad_index) = entity.squad {
                let living_members = game.levels[entity.level_index].squads[squad_index]
                    .members
                    .iter()
                    .filter(|&&member_index| game.entities.contains(member_index))
                    .count();
                format!(", squad_size={}", living_members)
            } else {
                String::new()
            };
            println!(
                "  Entity {:?}: is_player={}, hp={}/{}, loc={:?}, level={}{}",
                entity_index,
                entity.is_player,
                entity.hp,
                entity.max_hp,
                entity.loc,
                entity.level_index,
                squad_info
            );
        }
    }
}

pub fn benchmark_rl(
    seed: i32,
    level_width: i32,
    level_height: i32,
    num_levels: i32,
    should_display: bool,
    turn_delay: i32,
    only_level: bool,
    debug_turn: i32,
    print_final_state: bool,
) {
    let mut rand = LCGRand {
        seed: seed as u32,
        call_count: 0,
    };
    let mut game = setup(&mut rand, level_width, level_height, num_levels);

    let mut maybe_screen = if should_display || only_level {
        Some(Screen::new(
            game.get_current_level().max_width as usize,
            game.get_current_level().max_height as usize,
        ))
    } else {
        None
    };

    if only_level {
        println!("Level generated with seed {}:", seed);
        println!();

        // Display as ASCII
        for y in 0..game.get_current_level().max_height {
            let mut line = String::new();
            for x in 0..game.get_current_level().max_width {
                let loc = Location::new(x, y);
                let mut ch = ' ';

                if let Some(tile) = game.get_current_level().tiles.get(&loc) {
                    match tile.display_class.as_str() {
                        "dirt" | "grass" => ch = '.',
                        "wall" => ch = '#',
                        _ => ch = '?',
                    }
                }

                // Check for totems
                for &totem_index in &game.get_current_level().totem_indices {
                    if let Some(totem) = game.totems.get(totem_index) {
                        if totem.loc == loc {
                            ch = 'T';
                        }
                    }
                }

                if let Some(&entity_index) = game.get_current_level().entity_by_location.get(&loc) {
                    let entity = &game.entities[entity_index];
                    if entity.is_player {
                        ch = '@';
                    } else {
                        ch = 'g';
                    }
                }

                line.push(ch);
            }
            println!("{}", line);
        }
        println!();
        println!("Legend: # = wall, . = floor, g = goblin, @ = player, T = totem");
        println!("Press Ctrl+C to exit.");
        sleep(Duration::new(3600, 0)); // Wait an hour so user can see it
        return;
    }

    println!(
        "Starting benchmark with seed {}, {}x{}, {} levels",
        seed, level_width, level_height, num_levels
    );

    let mut turn_count = 0;
    loop {
        if debug_turn >= 0 && turn_count == debug_turn {
            println!("=== Game State After Turn {} ===", turn_count);
            print_game_state(&game);
            return;
        }

        let should_debug = debug_turn >= 0 && turn_count == debug_turn - 1;
        if should_debug {
            println!("=== Turn {} Debug ===", turn_count + 1);
        }
        turn(&mut rand, &mut game, should_debug);
        turn_count += 1;

        // Check if player is still alive
        if !game.entities.contains(game.get_player_index()) {
            println!("Player died after {} turns", turn_count);
            if print_final_state {
                println!();
                println!("=== Final Game State ===");
                print_game_state(&game);
            }
            break;
        }

        display(seed, &mut maybe_screen, &game);

        let player_level_index = game.get_player().level_index;
        let num_entities = game.levels[player_level_index]
            .entity_by_location
            .keys()
            .len();

        if num_entities == 1 {
            let keep_running = descend_to_next_level(&mut rand, &mut game);
            if !keep_running {
                println!(
                    "Completed all {} levels in {} turns!",
                    num_levels, turn_count
                );
                if print_final_state {
                    println!();
                    println!("=== Final Game State ===");
                    print_game_state(&game);
                }
                return;
            }
        }

        if turn_delay > 0 {
            sleep(Duration::new(
                turn_delay as u64 / 1000,
                turn_delay as u32 % 1000 * 1000000,
            ));
        }
    }
}
