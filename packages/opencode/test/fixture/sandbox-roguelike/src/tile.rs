#[derive(new)]
pub struct Tile {
    pub walkable: bool,

    // A string that the UI can recognize so it knows what to display. This should
    // ONLY be read by the UI, and not by any special logic.
    pub display_class: String,
}
