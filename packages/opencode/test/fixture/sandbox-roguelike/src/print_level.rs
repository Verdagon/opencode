use crate::game::*;

pub fn print_level_ascii(game: &Game) {
    let level = game.get_current_level();
    for y in 0..level.max_height {
        let mut line = String::new();
        for x in 0..level.max_width {
            let loc = crate::location::Location::new(x, y);
            let mut ch = ' ';

            if let Some(tile) = level.tiles.get(&loc) {
                match tile.display_class.as_str() {
                    "dirt" | "grass" => ch = '.',
                    "wall" => ch = '#',
                    _ => ch = '?',
                }
            }

            if let Some(&unit_index) = level.unit_by_location.get(&loc) {
                let unit = &game.units[unit_index];
                match unit.display_class.as_str() {
                    "goblin" => ch = 'g',
                    "chronomancer" => ch = '@',
                    _ => ch = '?',
                }
            }

            line.push(ch);
        }
        println!("{}", line);
    }
}
