use rustc_hash::FxHashSet;

use generational_arena;
use generational_arena::Arena;

use crate::entity::*;
use crate::level::*;
use crate::location::*;

use std::num::Wrapping;

// From https://stackoverflow.com/a/3062783
pub struct LCGRand {
    pub seed: u32,
    pub call_count: u32,
}
impl LCGRand {
    pub fn next(&mut self) -> u32 {
        let a = 1103515245;
        let c = 12345;
        let m = 0x7FFFFFFF;
        self.seed = ((Wrapping(a) * Wrapping(self.seed) + Wrapping(c)) % Wrapping(m)).0;
        self.call_count += 1;
        return self.seed;
    }
}

#[derive(new)]
pub struct Game {
    pub entities: Arena<Entity>,
    pub levels: Vec<Level>,
    pub player_index: Option<generational_arena::Index>,
    pub totems: Arena<Totem>,
}

impl Game {
    pub fn get_current_level(&self) -> &Level {
        return &self.levels[self.get_player().level_index];
    }

    pub fn get_current_level_mut(&mut self) -> &mut Level {
        let level_index = self.get_player().level_index;
        return &mut self.levels[level_index];
    }

    pub fn get_player_index(&self) -> generational_arena::Index {
        return self.player_index.expect("No player yet!");
    }

    pub fn get_player(&self) -> &Entity {
        return &self.entities[self.get_player_index()];
    }

    pub fn add_entity_to_level(
        &mut self,
        level_index: usize,
        loc: Location,
        is_player: bool,
        hp: i32,
        max_hp: i32,
        allegiance: Allegiance,
        damage: i32,
        is_priest: bool,
    ) -> generational_arena::Index {
        let entity_index = self.entities.insert(Entity::new(
            is_player,
            level_index,
            loc,
            hp,
            max_hp,
            allegiance,
            damage,
            is_priest,
        ));
        self.levels[level_index]
            .entity_by_location
            .insert(loc, entity_index);
        self.levels[level_index].entity_indices.push(entity_index);
        return entity_index;
    }
}

// Get all the locations adjacent to `center`.
pub fn get_pattern_adjacent_locations(
    center: Location,
    consider_corners_adjacent: bool,
) -> Vec<Location> {
    let mut result = Vec::new();
    result.push(Location::new(center.x - 1, center.y));
    result.push(Location::new(center.x, center.y + 1));
    result.push(Location::new(center.x, center.y - 1));
    result.push(Location::new(center.x + 1, center.y));
    if consider_corners_adjacent {
        result.push(Location::new(center.x - 1, center.y - 1));
        result.push(Location::new(center.x - 1, center.y + 1));
        result.push(Location::new(center.x + 1, center.y - 1));
        result.push(Location::new(center.x + 1, center.y + 1));
    }
    return result;
}

pub fn lookup_strength_affector<'a>(
    game: &'a Game,
    effector_id: &EffectorIndex,
) -> Option<&'a dyn IStrengthAffector> {
    match effector_id {
        EffectorIndex::Priest(id) => game.entities.get(*id).map(|e| e as &dyn IStrengthAffector),
        EffectorIndex::Totem(id) => game.totems.get(*id).map(|t| t as &dyn IStrengthAffector),
    }
}

// Get all the locations adjacent to any of the ones in `source_locs`.
pub fn get_pattern_locations_adjacent_to_any(
    source_locs: &FxHashSet<Location>,
    include_source_locs: bool,
    consider_corners_adjacent: bool,
) -> FxHashSet<Location> {
    let mut result = FxHashSet::default();
    // Sort to ensure deterministic iteration
    let mut sorted_source_locs: Vec<Location> = source_locs.iter().cloned().collect();
    sorted_source_locs.sort_by(|a, b| match a.x.cmp(&b.x) {
        std::cmp::Ordering::Equal => a.y.cmp(&b.y),
        other => other,
    });
    for original_location in sorted_source_locs {
        let mut adjacents =
            get_pattern_adjacent_locations(original_location, consider_corners_adjacent);
        if include_source_locs {
            adjacents.push(original_location.clone());
        }
        for adjacent_location in adjacents {
            if !include_source_locs && source_locs.contains(&adjacent_location) {
                continue;
            }
            result.insert(adjacent_location);
        }
    }
    return result;
}
