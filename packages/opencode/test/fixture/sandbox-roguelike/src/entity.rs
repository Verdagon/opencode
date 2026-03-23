use crate::game::*;
use crate::location::*;

const DEFAULT_SIGHT_RANGE_100: i32 = 800;
const AURA_RANGE: i32 = 500;

pub trait IStrengthAffector {
    fn get_strength_boost(&self) -> i32;
}

#[derive(Clone, Copy, PartialEq)]
pub enum EffectorIndex {
    Totem(generational_arena::Index),
    Priest(generational_arena::Index),
}

#[derive(PartialEq, Clone)]
pub enum Allegiance {
    Good,
    Evil,
}

pub struct Squad {
    // TODO: Remove refs to dead entities as we iterate over this list
    pub members: Vec<generational_arena::Index>,
}

impl Squad {
    pub fn new() -> Squad {
        Squad {
            members: Vec::new(),
        }
    }

    pub fn add_member(&mut self, entity_index: generational_arena::Index) {
        self.members.push(entity_index);
    }

    pub fn get_leader(&self, game: &Game) -> Option<generational_arena::Index> {
        for &member_index in &self.members {
            if game.entities.contains(member_index) {
                return Some(member_index);
            }
        }
        None
    }
}

pub struct Totem {
    pub loc: Location,
    pub aura_range: i32,
    pub affected_entity_indices: Vec<generational_arena::Index>,
}

impl IStrengthAffector for Totem {
    fn get_strength_boost(&self) -> i32 {
        5
    }
}

impl Totem {
    pub fn new(loc: Location) -> Totem {
        Totem {
            loc,
            aura_range: 500,
            affected_entity_indices: Vec::new(),
        }
    }

    pub fn update_affected_entities(
        &mut self,
        totem_index: generational_arena::Index,
        game: &mut Game,
    ) {
        // Unregister from all currently affected entities
        for &entity_index in &self.affected_entity_indices {
            if let Some(entity) = game.entities.get_mut(entity_index) {
                entity
                    .effector_indices
                    .retain(|idx| *idx != EffectorIndex::Totem(totem_index));
            }
        }

        // Clear affected entities
        self.affected_entity_indices.clear();

        // Find which level this totem is on
        let mut totem_level_index: Option<usize> = None;
        for (level_index, level) in game.levels.iter().enumerate() {
            if level.totem_indices.contains(&totem_index) {
                totem_level_index = Some(level_index);
                break;
            }
        }

        let Some(level_index) = totem_level_index else {
            return;
        };
        let level = &game.levels[level_index];

        // Get all locations within aura range
        let locations_in_aura = level.get_locations_within_sight(self.loc, true, self.aura_range);

        // Register all evil entities within range
        for location in locations_in_aura {
            if let Some(&entity_index) = level.entity_by_location.get(&location) {
                if let Some(entity) = game.entities.get(entity_index) {
                    if entity.allegiance == Allegiance::Evil {
                        // Add to affected entities
                        self.affected_entity_indices.push(entity_index);
                        // Add self to entity's effectors
                        if let Some(entity_mut) = game.entities.get_mut(entity_index) {
                            entity_mut
                                .effector_indices
                                .push(EffectorIndex::Totem(totem_index));
                        }
                    }
                }
            }
        }
    }
}

#[derive(Clone)]
pub struct Entity {
    pub is_player: bool,
    pub level_index: usize,
    pub loc: Location,
    pub hp: i32,
    pub max_hp: i32,
    pub allegiance: Allegiance,
    pub damage: i32,

    // Used for chase behavior - remembers path to target
    pub chase_target: Option<ChaseTarget>,

    // Squad membership (index into level.squads)
    pub squad: Option<usize>,

    // Priest status (provides strength boost)
    pub is_priest: bool,

    // Effector indices affecting this entity (totems or priests)
    pub effector_indices: Vec<EffectorIndex>,

    // For priests: entities affected by this priest's aura
    pub affected_entities: Vec<generational_arena::Index>,
}

#[derive(Clone)]
pub struct ChaseTarget {
    pub target_index: generational_arena::Index,
    pub path_to_target: Vec<Location>,
}

impl IStrengthAffector for Entity {
    fn get_strength_boost(&self) -> i32 {
        if self.is_priest { 5 } else { 0 }
    }
}

impl Entity {
    pub fn new(
        is_player: bool,
        level_index: usize,
        loc: Location,
        hp: i32,
        max_hp: i32,
        allegiance: Allegiance,
        damage: i32,
        is_priest: bool,
    ) -> Entity {
        Entity {
            is_player,
            level_index,
            loc,
            hp,
            max_hp,
            allegiance,
            damage,
            chase_target: None,
            squad: None,
            is_priest,
            effector_indices: Vec::new(),
            affected_entities: Vec::new(),
        }
    }

    pub fn get_nearest_enemy_in_sight(
        &self,
        game: &Game,
        range: i32,
    ) -> Option<generational_arena::Index> {
        let level = &game.levels[self.level_index];
        let locations_within_sight = level.get_locations_within_sight(self.loc, false, range);

        let mut maybe_nearest_enemy_index: Option<generational_arena::Index> = None;
        let mut nearest_dist_squared = i32::MAX;

        for location_within_sight in locations_within_sight {
            if let Some(&other_entity_index) = level.entity_by_location.get(&location_within_sight)
            {
                let other_entity = &game.entities[other_entity_index];
                if self.allegiance != other_entity.allegiance {
                    let dist_squared = self.loc.dist_squared(other_entity.loc);
                    if dist_squared < nearest_dist_squared {
                        nearest_dist_squared = dist_squared;
                        maybe_nearest_enemy_index = Some(other_entity_index);
                    }
                }
            }
        }

        maybe_nearest_enemy_index
    }

    pub fn get_adjacent_enemy(&self, game: &Game) -> Option<generational_arena::Index> {
        let level = &game.levels[self.level_index];

        for adjacent_loc in get_pattern_adjacent_locations(self.loc, true) {
            if let Some(&entity_index) = level.entity_by_location.get(&adjacent_loc) {
                let entity = &game.entities[entity_index];
                if entity.allegiance != self.allegiance {
                    return Some(entity_index);
                }
            }
        }
        None
    }

    pub fn take_damage(&mut self, damage: i32) {
        self.hp -= damage;
    }

    pub fn find_nearest_enemy_on_level(&self, game: &Game) -> Option<generational_arena::Index> {
        let mut maybe_nearest_enemy_index: Option<generational_arena::Index> = None;
        let mut nearest_dist = i32::MAX;

        let level = &game.levels[self.level_index];
        // Sort for deterministic iteration to match Swift behavior
        let mut sorted_entities: Vec<_> = level.entity_by_location.iter().collect();
        sorted_entities.sort_by(|a, b| match a.0.y.cmp(&b.0.y) {
            std::cmp::Ordering::Equal => a.0.x.cmp(&b.0.x),
            other => other,
        });

        for (&this_loc, &entity_index) in sorted_entities {
            let entity = &game.entities[entity_index];
            if entity.allegiance == self.allegiance {
                continue;
            }

            let dist = self.loc.diagonal_manhattan_distance_100(this_loc);
            if dist < nearest_dist {
                nearest_dist = dist;
                maybe_nearest_enemy_index = Some(entity_index);
            }
        }

        maybe_nearest_enemy_index
    }

    pub fn update_affected_entities(
        &mut self,
        entity_index: generational_arena::Index,
        game: &mut Game,
    ) {
        // Only priests have auras
        if !self.is_priest {
            return;
        }

        // Unregister from all currently affected entities
        for &affected_entity_index in &self.affected_entities {
            if let Some(entity) = game.entities.get_mut(affected_entity_index) {
                entity
                    .effector_indices
                    .retain(|idx| *idx != EffectorIndex::Priest(entity_index));
            }
        }

        // Clear affected entities
        self.affected_entities.clear();

        // Get the level this priest is on
        let level = &game.levels[self.level_index];

        // Get all locations within aura range
        let locations_in_aura = level.get_locations_within_sight(self.loc, true, AURA_RANGE);

        // Register all evil entities within range (excluding self)
        for location in locations_in_aura {
            if let Some(&other_entity_index) = level.entity_by_location.get(&location) {
                if other_entity_index == entity_index {
                    continue; // Skip self
                }
                if let Some(entity) = game.entities.get(other_entity_index) {
                    if entity.allegiance == Allegiance::Evil {
                        // Add to affected entities
                        self.affected_entities.push(other_entity_index);
                        // Add self to entity's effectors
                        if let Some(entity_mut) = game.entities.get_mut(other_entity_index) {
                            entity_mut
                                .effector_indices
                                .push(EffectorIndex::Priest(entity_index));
                        }
                    }
                }
            }
        }
    }
}

// Standalone function to update priest auras without reindexing
pub fn update_priest_auras(game: &mut Game, priest_index: generational_arena::Index) {
    if !game.entities.contains(priest_index) || !game.entities[priest_index].is_priest {
        return;
    }

    // Phase 1: Unregister from currently affected entities
    let old_affected = game.entities[priest_index].affected_entities.clone();
    for &affected_entity_index in &old_affected {
        if let Some(entity) = game.entities.get_mut(affected_entity_index) {
            entity
                .effector_indices
                .retain(|idx| *idx != EffectorIndex::Priest(priest_index));
        }
    }

    // Phase 2: Clear and calculate new affected entities
    let priest_loc = game.entities[priest_index].loc;
    let priest_level = game.entities[priest_index].level_index;
    let level = &game.levels[priest_level];
    let locations_in_aura = level.get_locations_within_sight(priest_loc, true, AURA_RANGE);

    let mut new_affected = Vec::new();
    for location in locations_in_aura {
        if let Some(&other_entity_index) = level.entity_by_location.get(&location) {
            if other_entity_index == priest_index {
                continue; // Skip self
            }
            if let Some(entity) = game.entities.get(other_entity_index) {
                if entity.allegiance == Allegiance::Evil {
                    new_affected.push(other_entity_index);
                }
            }
        }
    }

    // Phase 3: Apply updates
    game.entities[priest_index].affected_entities = new_affected.clone();
    for &affected_index in &new_affected {
        if let Some(entity) = game.entities.get_mut(affected_index) {
            entity
                .effector_indices
                .push(EffectorIndex::Priest(priest_index));
        }
    }
}

// Standalone function to update totem auras without reindexing
pub fn update_totem_auras(game: &mut Game, totem_index: generational_arena::Index) {
    if !game.totems.contains(totem_index) {
        return;
    }

    // Phase 1: Unregister from currently affected entities
    let old_affected = game.totems[totem_index].affected_entity_indices.clone();
    for &affected_entity_index in &old_affected {
        if let Some(entity) = game.entities.get_mut(affected_entity_index) {
            entity
                .effector_indices
                .retain(|idx| *idx != EffectorIndex::Totem(totem_index));
        }
    }

    // Phase 2: Clear and calculate new affected entities
    let totem_loc = game.totems[totem_index].loc;
    let totem_aura_range = game.totems[totem_index].aura_range;

    // Find which level this totem is on
    let mut totem_level_index: Option<usize> = None;
    for (level_index, level) in game.levels.iter().enumerate() {
        if level.totem_indices.contains(&totem_index) {
            totem_level_index = Some(level_index);
            break;
        }
    }

    let Some(level_index) = totem_level_index else {
        return;
    };
    let level = &game.levels[level_index];
    let locations_in_aura = level.get_locations_within_sight(totem_loc, true, totem_aura_range);

    let mut new_affected = Vec::new();
    for location in locations_in_aura {
        if let Some(&entity_index) = level.entity_by_location.get(&location) {
            if let Some(entity) = game.entities.get(entity_index) {
                if entity.allegiance == Allegiance::Evil {
                    new_affected.push(entity_index);
                }
            }
        }
    }

    // Phase 3: Apply updates
    game.totems[totem_index].affected_entity_indices = new_affected.clone();
    for &affected_index in &new_affected {
        if let Some(entity) = game.entities.get_mut(affected_index) {
            entity
                .effector_indices
                .push(EffectorIndex::Totem(totem_index));
        }
    }
}

pub const fn get_default_sight_range() -> i32 {
    DEFAULT_SIGHT_RANGE_100
}

pub fn try_chase(
    game: &Game,
    entity_index: generational_arena::Index,
) -> Option<(Location, Option<ChaseTarget>)> {
    let entity = &game.entities[entity_index];
    let level = &game.levels[entity.level_index];
    let sight_range = get_default_sight_range();

    // Check if we have a current chase target
    if let Some(ref chase_target) = entity.chase_target {
        // Is the target still alive?
        if let Some(target_entity) = game.entities.get(chase_target.target_index) {
            // Can we see them?
            if level.can_see(entity.loc, target_entity.loc, sight_range) {
                // Recalculate path to target
                let max_travel_distance = sight_range * 2;
                if let Some((new_path, _)) =
                    level.find_path(entity.loc, target_entity.loc, max_travel_distance, true)
                {
                    if level.loc_is_walkable(new_path[0], true) {
                        let next_step = new_path[0];
                        let mut future_path = new_path;
                        future_path.remove(0);
                        return Some((
                            next_step,
                            Some(ChaseTarget {
                                target_index: chase_target.target_index,
                                path_to_target: future_path,
                            }),
                        ));
                    }
                }
            } else if !chase_target.path_to_target.is_empty() {
                // Can't see them, but follow stored path
                let next_step = chase_target.path_to_target[0];
                if level.loc_is_walkable(next_step, true) {
                    let mut future_path = chase_target.path_to_target.clone();
                    future_path.remove(0);
                    return Some((
                        next_step,
                        Some(ChaseTarget {
                            target_index: chase_target.target_index,
                            path_to_target: future_path,
                        }),
                    ));
                }
            }
        }
    }

    // No current target or couldn't follow it, look for new enemy in sight
    if let Some(enemy_index) = entity.get_nearest_enemy_in_sight(game, sight_range) {
        let enemy = &game.entities[enemy_index];
        let max_travel_distance = sight_range * 2;

        if let Some((new_path, _)) =
            level.find_path(entity.loc, enemy.loc, max_travel_distance, true)
        {
            if level.loc_is_walkable(new_path[0], true) {
                let next_step = new_path[0];
                let mut future_path = new_path;
                future_path.remove(0);
                return Some((
                    next_step,
                    Some(ChaseTarget {
                        target_index: enemy_index,
                        path_to_target: future_path,
                    }),
                ));
            }
        }
    }

    None
}

pub fn try_seek(
    game: &Game,
    entity_index: generational_arena::Index,
    _rand: &mut LCGRand,
) -> Option<Location> {
    let entity = &game.entities[entity_index];
    let level = &game.levels[entity.level_index];

    if let Some(enemy_index) = entity.find_nearest_enemy_on_level(game) {
        let enemy = &game.entities[enemy_index];
        // Use unlimited distance for seeking - A* through a 40x30 map should be instant
        let max_seek_distance = i32::MAX;
        let result = level.find_path(entity.loc, enemy.loc, max_seek_distance, true);

        // ASSERTION: Player must be able to path to all enemies on their level
        // If this fails, the level has disconnected regions (bug in level generation)
        if entity.is_player && result.is_none() {
            panic!(
                "Level has disconnected regions! Player at {:?} cannot path to enemy at {:?} on level {}",
                entity.loc, enemy.loc, entity.level_index
            );
        }

        if let Some((new_path, _)) = result {
            if level.loc_is_walkable(new_path[0], true) {
                return Some(new_path[0]);
            }
        }
    }

    None
}

pub fn attack(
    attacker_index: generational_arena::Index,
    target_index: generational_arena::Index,
    game: &mut Game,
) {
    let base_damage = game.entities[attacker_index].damage;
    // Calculate strength boost from effectors (totems and priests)
    let effector_boost: i32 = game.entities[attacker_index]
        .effector_indices
        .iter()
        .filter_map(|effector_id| lookup_strength_affector(game, effector_id))
        .map(|effector| effector.get_strength_boost())
        .sum();
    let total_damage = base_damage + effector_boost;
    game.entities[target_index].take_damage(total_damage);
}

pub fn process_entity_turn(
    entity_index: generational_arena::Index,
    rand: &mut LCGRand,
    game: &mut Game,
) {
    // Priority 1: Attack if enemy is adjacent
    if let Some(target_index) = game.entities[entity_index].get_adjacent_enemy(game) {
        game.entities[entity_index].chase_target = None;

        // Squad attack: if this entity has a squad, all squad members attack together
        if let Some(squad_index) = game.entities[entity_index].squad {
            let entity_level = game.entities[entity_index].level_index;
            let living_members: Vec<generational_arena::Index> = game.levels[entity_level].squads
                [squad_index]
                .members
                .iter()
                .filter(|&&member_index| game.entities.contains(member_index))
                .copied()
                .collect();

            for member_index in living_members {
                attack(member_index, target_index, game);
            }
        } else {
            // Solo attack
            attack(entity_index, target_index, game);
        }
        return;
    }

    // Priority 2: Chase if enemy is in sight (range 800)
    if let Some(new_loc_and_chase) = try_chase(game, entity_index) {
        let (new_loc, new_chase_target) = new_loc_and_chase;
        let current_loc = game.entities[entity_index].loc;
        let current_level = game.entities[entity_index].level_index;
        let is_player = game.entities[entity_index].is_player;

        game.entities[entity_index].chase_target = new_chase_target;
        game.levels[current_level]
            .entity_by_location
            .remove(&current_loc);
        game.entities[entity_index].loc = new_loc;
        game.levels[current_level]
            .entity_by_location
            .insert(new_loc, entity_index);

        // Player destroys totems by walking on them
        if is_player {
            let totem_to_remove =
                game.levels[current_level]
                    .totem_indices
                    .iter()
                    .position(|&totem_index| {
                        game.totems
                            .get(totem_index)
                            .map(|t| t.loc == new_loc)
                            .unwrap_or(false)
                    });
            if let Some(pos) = totem_to_remove {
                let totem_index = game.levels[current_level].totem_indices.remove(pos);
                game.totems.remove(totem_index);
            }
        }
        return;
    }

    // Priority 3: Seek (player only) - find nearest enemy on level and path to them
    if game.entities[entity_index].is_player {
        if let Some(new_loc) = try_seek(game, entity_index, rand) {
            let current_loc = game.entities[entity_index].loc;
            let current_level = game.entities[entity_index].level_index;

            game.entities[entity_index].chase_target = None;
            game.levels[current_level]
                .entity_by_location
                .remove(&current_loc);
            game.entities[entity_index].loc = new_loc;
            game.levels[current_level]
                .entity_by_location
                .insert(new_loc, entity_index);

            // Player destroys totems by walking on them
            let totem_to_remove =
                game.levels[current_level]
                    .totem_indices
                    .iter()
                    .position(|&totem_index| {
                        game.totems
                            .get(totem_index)
                            .map(|t| t.loc == new_loc)
                            .unwrap_or(false)
                    });
            if let Some(pos) = totem_to_remove {
                let totem_index = game.levels[current_level].totem_indices.remove(pos);
                game.totems.remove(totem_index);
            }
            return;
        }
    }

    // Priority 4: Wander
    // Non-leaders wander towards their leader if they have a squad
    if let Some(squad_index) = game.entities[entity_index].squad {
        let entity_level = game.entities[entity_index].level_index;
        if let Some(leader_index) = game.levels[entity_level].squads[squad_index].get_leader(game) {
            if leader_index != entity_index {
                let leader = &game.entities[leader_index];
                let entity = &game.entities[entity_index];
                if leader.level_index == entity.level_index && leader.loc != entity.loc {
                    let entity_loc = entity.loc;
                    let leader_loc = leader.loc;
                    let entity_level_index = entity.level_index;

                    // Try to path towards the leader (with reasonable distance limit)
                    let max_wander_distance = 3000; // About 30 tiles
                    if let Some((new_path, _)) = game.levels[entity_level_index].find_path(
                        entity_loc,
                        leader_loc,
                        max_wander_distance,
                        true,
                    ) {
                        if game.levels[entity_level_index].loc_is_walkable(new_path[0], true) {
                            let new_loc = new_path[0];
                            let current_loc = game.entities[entity_index].loc;
                            let current_level = game.entities[entity_index].level_index;

                            game.entities[entity_index].chase_target = None;
                            game.levels[current_level]
                                .entity_by_location
                                .remove(&current_loc);
                            game.entities[entity_index].loc = new_loc;
                            game.levels[current_level]
                                .entity_by_location
                                .insert(new_loc, entity_index);
                            return;
                        }
                    }
                }
            }
        }
    }

    // Default wander - pick random adjacent location
    let adjacent = get_pattern_adjacent_locations(game.entities[entity_index].loc, true);
    let current_level = &game.levels[game.entities[entity_index].level_index];
    let mut walkable_adjacent = Vec::new();

    for loc in adjacent {
        if current_level.loc_is_walkable(loc, true) {
            walkable_adjacent.push(loc);
        }
    }

    if !walkable_adjacent.is_empty() {
        let index = (rand.next() as usize) % walkable_adjacent.len();
        let new_loc = walkable_adjacent[index];
        let current_loc = game.entities[entity_index].loc;
        let current_level = game.entities[entity_index].level_index;
        let is_player = game.entities[entity_index].is_player;

        game.entities[entity_index].chase_target = None;
        game.levels[current_level]
            .entity_by_location
            .remove(&current_loc);
        game.entities[entity_index].loc = new_loc;
        game.levels[current_level]
            .entity_by_location
            .insert(new_loc, entity_index);

        // Player destroys totems by walking on them
        if is_player {
            let totem_to_remove =
                game.levels[current_level]
                    .totem_indices
                    .iter()
                    .position(|&totem_index| {
                        game.totems
                            .get(totem_index)
                            .map(|t| t.loc == new_loc)
                            .unwrap_or(false)
                    });
            if let Some(pos) = totem_to_remove {
                let totem_index = game.levels[current_level].totem_indices.remove(pos);
                game.totems.remove(totem_index);
            }
        }
    }
}

impl PartialOrd for Entity {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Entity {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.loc.cmp(&other.loc)
    }
}

impl PartialEq for Entity {
    fn eq(&self, other: &Self) -> bool {
        self.loc == other.loc
    }
}

impl Eq for Entity {}
