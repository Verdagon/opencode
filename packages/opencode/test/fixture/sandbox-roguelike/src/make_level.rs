use std::cmp;
use std::iter::FromIterator;

use rustc_hash::FxHashMap;
use rustc_hash::FxHashSet;

use crate::game::*;
use crate::level::*;
use crate::location::*;
use crate::tile::*;

pub fn make_level(max_width: i32, max_height: i32, mut rand: &mut LCGRand) -> Level {
    let mut level = Level {
        max_width: max_width as i32,
        max_height: max_height as i32,
        tiles: FxHashMap::default(),
        entity_by_location: FxHashMap::default(),
        entity_indices: Vec::new(),
        acting_tile_locations: FxHashMap::default(),
        squads: Vec::new(),
        totem_indices: Vec::new(),
    };

    // This is a 2D array of booleans which represent our walkable and
    // non-walkable locations.
    // All `true` tiles will become floors.
    // All `false` tiles will become walls or open space, depending on whether
    // they're next to a floor.
    let mut walkabilities = Vec::with_capacity(max_width as usize);
    for x in 0..max_width {
        walkabilities.push(Vec::with_capacity(max_height as usize));
        for y in 0..max_height {
            // This logic will make us start with an ellipse that fills up
            // max_width and max_height.
            // Note that while we may *start* with an ellipse here, later
            // cellular automata and tunnel digging will probably distort
            // the edges of the ellipse.
            let half_max_width = max_width / 2;
            let half_max_height = max_height / 2;
            let inside_ellipse = (x - half_max_width)
                * (x - half_max_width)
                * (half_max_height * half_max_height)
                + (y - half_max_height) * (y - half_max_height) * (half_max_width * half_max_width)
                < (half_max_width * half_max_width) * (half_max_height * half_max_height);

            // Randomly determine whether something inside the ellipse is walkable or not.
            let walkable = rand.next() % 2 == 0;

            walkabilities[x as usize].push(inside_ellipse && walkable);
        }
    }
    // We should now have a randomly-noisy-semi-filled ellipse, like an ellipse of static
    // on an otherwise black TV screen.

    // Do a couple generations of cellular automata to smooth out the noisiness to get some
    // caverns and rooms forming.
    smooth_level(max_width, max_height, &mut walkabilities);
    smooth_level(max_width, max_height, &mut walkabilities);

    // The caverns and rooms from the above process are probably disjoint and we can't get
    // from one to the other. Here, we dig tunnels between them until they're connected.
    connect_all_rooms(&mut rand, &mut walkabilities, false);

    // Now, assemble the above walkabilities 2D bool array into a legit 2D tile array.
    for x in 0..max_width {
        for y in 0..max_height {
            let loc = Location::new(x as i32, y as i32);
            let walkable = walkabilities[x as usize][y as usize];
            let on_edge = x == 0 || y == 0 || x == max_width - 1 || y == max_height - 1;
            if walkable && !on_edge {
                let display_class = if rand.next() % 2 == 0 {
                    "dirt"
                } else {
                    "grass"
                };
                level.tiles.insert(
                    loc,
                    Tile {
                        walkable: true,
                        display_class: display_class.to_string(),
                    },
                );
            } else {
                let mut next_to_walkable = false;
                for neighbor_x in cmp::max(0, x - 1)..cmp::min(max_width - 1, x + 1 + 1) {
                    for neighbor_y in cmp::max(0, y - 1)..cmp::min(max_height - 1, y + 1 + 1) {
                        let neighbor_walkable =
                            walkabilities[neighbor_x as usize][neighbor_y as usize];
                        if neighbor_walkable {
                            next_to_walkable = true;
                        }
                    }
                }
                if next_to_walkable {
                    level.tiles.insert(
                        loc,
                        Tile {
                            walkable: false,
                            display_class: "wall".to_string(),
                        },
                    );
                }
            }
        }
    }

    return level;
}

// Does cellular automata on the 2D walkabilities array.
fn smooth_level(max_width: i32, max_height: i32, walkabilities: &mut Vec<Vec<bool>>) {
    let mut new_walkabilities = Vec::with_capacity(max_width as usize);
    for x in 0..max_width {
        new_walkabilities.push(Vec::with_capacity(max_height as usize));
        for _y in 0..max_height {
            new_walkabilities[x as usize].push(false);
        }
    }

    for x in 0..max_width {
        for y in 0..max_height {
            let mut num_walkable_neighbors = 0;

            for neighbor_x in cmp::max(0, x - 1)..cmp::min(max_width, x + 1 + 1) {
                for neighbor_y in cmp::max(0, y - 1)..cmp::min(max_height, y + 1 + 1) {
                    if walkabilities[neighbor_x as usize][neighbor_y as usize] {
                        num_walkable_neighbors = num_walkable_neighbors + 1;
                    }
                }
            }

            new_walkabilities[x as usize][y as usize] = num_walkable_neighbors >= 5;
        }
    }

    // swap method here?
    *walkabilities = new_walkabilities;
}

fn connect_all_rooms(
    rand: &mut LCGRand,
    walkabilities: &mut Vec<Vec<bool>>,
    consider_corners_adjacent: bool,
) {
    let mut rooms = identify_rooms(walkabilities, consider_corners_adjacent);
    connect_rooms(rand, &mut rooms);
    for i in 0..rooms.len() {
        let new_room = &rooms[i];
        // Sort to ensure deterministic iteration
        let mut sorted_locs: Vec<Location> = new_room.iter().cloned().collect();
        sorted_locs.sort_by(|a, b| match a.x.cmp(&b.x) {
            std::cmp::Ordering::Equal => a.y.cmp(&b.y),
            other => other,
        });
        for loc in sorted_locs {
            walkabilities[loc.x as usize][loc.y as usize] = true;
        }
    }
}

pub fn identify_rooms(
    walkabilities: &mut Vec<Vec<bool>>,
    consider_corners_adjacent: bool,
) -> Vec<FxHashSet<Location>> {
    let mut room_index_by_location = FxHashMap::default();
    let mut rooms = Vec::new();

    for x in 0..walkabilities.len() {
        for y in 0..walkabilities[x].len() {
            if walkabilities[x][y] {
                let spark_location = Location::new(x as i32, y as i32);
                if room_index_by_location.contains_key(&spark_location) {
                    continue;
                }
                let connected_locations = find_all_connected_locations(
                    &walkabilities,
                    consider_corners_adjacent,
                    spark_location,
                );
                let new_room_index = rooms.len();
                rooms.push(connected_locations.clone());
                // Sort to ensure deterministic iteration
                let mut sorted_connected_locs: Vec<Location> =
                    connected_locations.iter().cloned().collect();
                sorted_connected_locs.sort_by(|a, b| match a.x.cmp(&b.x) {
                    std::cmp::Ordering::Equal => a.y.cmp(&b.y),
                    other => other,
                });
                for connected_location in sorted_connected_locs {
                    assert!(!room_index_by_location.contains_key(&connected_location));
                    room_index_by_location.insert(connected_location, new_room_index);
                }
            }
        }
    }
    return rooms;
}

pub fn find_all_connected_locations(
    walkabilities: &Vec<Vec<bool>>,
    consider_corners_adjacent: bool,
    start_location: Location,
) -> FxHashSet<Location> {
    let mut connected_with_unexplored_neighbors = FxHashSet::default();
    let mut connected_with_explored_neighbors = FxHashSet::<Location>::default();

    connected_with_unexplored_neighbors.insert(start_location);

    while connected_with_unexplored_neighbors.len() > 0 {
        // Sort to ensure deterministic selection
        let mut neighbors_vec: Vec<Location> = connected_with_unexplored_neighbors
            .iter()
            .cloned()
            .collect();
        neighbors_vec.sort_by(|a, b| match a.x.cmp(&b.x) {
            std::cmp::Ordering::Equal => a.y.cmp(&b.y),
            other => other,
        });
        let current = neighbors_vec[0];
        assert!(!connected_with_explored_neighbors.contains(&current));

        connected_with_unexplored_neighbors.remove(&current);
        connected_with_explored_neighbors.insert(current);

        for neighbor in
            get_adjacent_walkable_locations(walkabilities, current, consider_corners_adjacent)
        {
            if connected_with_explored_neighbors.contains(&neighbor) {
                continue;
            }
            if connected_with_unexplored_neighbors.contains(&neighbor) {
                continue;
            }
            connected_with_unexplored_neighbors.insert(neighbor);
        }
    }

    return connected_with_explored_neighbors;
}

pub fn connect_rooms(rand: &mut LCGRand, rooms: &mut Vec<FxHashSet<Location>>) {
    // This function will be adding the corridors to `rooms`.

    let mut room_index_by_location = FxHashMap::<Location, usize>::default();

    for room_index in 0..rooms.len() {
        let room = &rooms[room_index];
        // Sort to ensure deterministic iteration
        let mut sorted_room_locs: Vec<Location> = room.iter().cloned().collect();
        sorted_room_locs.sort_by(|a, b| match a.x.cmp(&b.x) {
            std::cmp::Ordering::Equal => a.y.cmp(&b.y),
            other => other,
        });
        for room_floor_loc in sorted_room_locs {
            room_index_by_location.insert(room_floor_loc, room_index);
        }
    }

    let mut regions = FxHashSet::default();

    let mut region_by_room_index = FxHashMap::default();
    let mut room_indices_by_region_num = FxHashMap::default();

    for room_index in 0..rooms.len() {
        let region = room_index;
        region_by_room_index.insert(room_index, region);
        let mut room_indices_in_region = FxHashSet::default();
        room_indices_in_region.insert(room_index);
        room_indices_by_region_num.insert(region, room_indices_in_region);
        regions.insert(region);
    }

    loop {
        let distinct_regions =
            FxHashSet::<usize>::from_iter(region_by_room_index.values().cloned());
        if distinct_regions.len() < 2 {
            break;
        }
        // Sort to ensure deterministic order
        let mut sorted_regions: Vec<usize> = distinct_regions.iter().cloned().collect();
        sorted_regions.sort();
        let region_a = sorted_regions[0];
        let region_b = sorted_regions[1];

        // Sort room indices to ensure deterministic selection
        let mut region_a_room_indices: Vec<usize> = room_indices_by_region_num[&region_a]
            .iter()
            .cloned()
            .collect();
        region_a_room_indices.sort();
        let region_a_room_index =
            region_a_room_indices[(rand.next() as usize) % region_a_room_indices.len()];

        let region_a_room = &rooms[region_a_room_index];
        let mut region_a_locations: Vec<Location> = region_a_room.iter().cloned().collect();
        region_a_locations.sort_by(|a, b| match a.x.cmp(&b.x) {
            std::cmp::Ordering::Equal => a.y.cmp(&b.y),
            other => other,
        });
        let region_a_location =
            region_a_locations[(rand.next() as usize) % region_a_locations.len()];

        let mut region_b_room_indices: Vec<usize> = room_indices_by_region_num[&region_b]
            .iter()
            .cloned()
            .collect();
        region_b_room_indices.sort();
        let region_b_room_index =
            region_b_room_indices[(rand.next() as usize) % region_b_room_indices.len()];

        let region_b_room = &rooms[region_b_room_index];
        let mut region_b_locations: Vec<Location> = region_b_room.iter().cloned().collect();
        region_b_locations.sort_by(|a, b| match a.x.cmp(&b.x) {
            std::cmp::Ordering::Equal => a.y.cmp(&b.y),
            other => other,
        });
        let region_b_location =
            region_b_locations[(rand.next() as usize) % region_b_locations.len()];

        // Now lets drive from region_a_location to region_b_location, and see what happens on the
        // way there.
        let mut path = Vec::new();
        let mut current_location = region_a_location;
        while current_location != region_b_location {
            if current_location.x != region_b_location.x {
                current_location.x += (region_b_location.x - current_location.x).signum();
            } else if current_location.y != region_b_location.y {
                current_location.y += (region_b_location.y - current_location.y).signum();
            } else {
                panic!("wat")
            }
            if !room_index_by_location.contains_key(&current_location) {
                // It means we're in open space, keep going.
                path.push(current_location);
            } else {
                let current_room_index = room_index_by_location[&current_location];
                let current_region = region_by_room_index[&current_room_index];
                if current_region == region_a {
                    // Keep going, but restart the path here.
                    path = Vec::new();
                } else if current_region == region_b {
                    // We reached our target region, stop here.
                    break;
                }
                // If we hit some other intermediate region, keep digging through it
            }
        }

        let combined_region = regions.len();
        regions.insert(combined_region);

        let new_room_index = rooms.len();
        rooms.push(FxHashSet::from_iter(path.iter().cloned()));
        for path_location in &path {
            room_index_by_location.insert(*path_location, new_room_index);
        }
        region_by_room_index.insert(new_room_index, combined_region);
        // We'll fill in regionNumberByRoomIndex and room_indices_by_region_num. umber shortly.

        // So, now we have a path that we know connects some regions. However, it might be
        // accidentally connecting more than two! It could have grazed past another region without
        // us realizing it.
        // So now, figure out all the regions that this path touches.

        let path_adjacent_locations = get_pattern_locations_adjacent_to_any(
            &FxHashSet::from_iter(path.iter().cloned()),
            true,
            false,
        );
        let mut path_adjacent_regions = FxHashSet::default();
        for path_adjacent_location in path_adjacent_locations {
            if room_index_by_location.contains_key(&path_adjacent_location) {
                let room_index = room_index_by_location[&path_adjacent_location];
                let region = region_by_room_index[&room_index];
                path_adjacent_regions.insert(region);
            }
        }

        let mut room_indices_in_combined_region = FxHashSet::default();
        room_indices_in_combined_region.insert(new_room_index);
        // Sort to ensure deterministic iteration
        let mut sorted_path_adjacent_regions: Vec<usize> =
            path_adjacent_regions.iter().cloned().collect();
        sorted_path_adjacent_regions.sort();
        for path_adjacent_region in sorted_path_adjacent_regions {
            if path_adjacent_region == combined_region {
                // The new room is already part of this region
                continue;
            }
            for path_adjacent_room_index in &room_indices_by_region_num[&path_adjacent_region] {
                region_by_room_index.insert(*path_adjacent_room_index, combined_region);
                room_indices_in_combined_region.insert(*path_adjacent_room_index);
            }
            room_indices_by_region_num.remove(&path_adjacent_region);
        }
        room_indices_by_region_num.insert(combined_region, room_indices_in_combined_region.clone());

        room_indices_by_region_num.insert(combined_region, room_indices_in_combined_region);
    }
}

fn get_adjacent_locations(
    width: i32,
    height: i32,
    center: Location,
    consider_corners_adjacent: bool,
) -> Vec<Location> {
    let mut result = Vec::new();
    for adjacent in get_pattern_adjacent_locations(center, consider_corners_adjacent) {
        if adjacent.x >= 0 && adjacent.y >= 0 && adjacent.x < width && adjacent.y < height {
            result.push(adjacent)
        }
    }
    return result;
}

fn get_adjacent_walkable_locations(
    walkabilities: &Vec<Vec<bool>>,
    center: Location,
    consider_corners_adjacent: bool,
) -> Vec<Location> {
    let mut result = Vec::new();
    let adjacents = get_adjacent_locations(
        walkabilities.len() as i32,
        walkabilities[0].len() as i32,
        center,
        consider_corners_adjacent,
    );
    for neighbor in adjacents {
        if walkabilities[neighbor.x as usize][neighbor.y as usize] {
            result.push(neighbor);
        }
    }
    return result;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn make_level_has_at_least_one_walkable_location() {
        let mut rand = LCGRand {
            seed: 42,
            call_count: 0,
        };
        let level = make_level(40, 30, &mut rand);
        let walkable = level.get_walkable_locations();
        if walkable.len() < 10 {
            // If the impl returned less than 10, then there should just be 0 or 1.
            assert!(
                walkable.len() <= 1,
                "level must have at least 1 walkable floor tile, got {}",
                walkable.len()
            );
        }
    }
}
