// Neko Code wordmark. Left half spells "neko", right half spells "code".
// Flat block glyphs — no shadow marks (the "_^~," shadow convention was removed
// so the wordmark renders clean, with no stray shadow pixels).
// "neko" / "code" wordmark. The K glyph is the 3-wide form (█ █ / █▀▄ / ▀ ▀);
// the left-half rows are all 18 wide so the columns stay aligned.
export const logo = {
  left: ["                  ", "█▀▀▄ █▀▀█ █ █ █▀▀█", "█  █ █▀▀▀ █▀▄ █  █", "▀  ▀ ▀▀▀▀ ▀ ▀ ▀▀▀▀"],
  right: ["             ▄     ", "█▀▀▀ █▀▀█ █▀▀█ █▀▀█", "█    █  █ █  █ █▀▀▀", "▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀"],
}

export const go = {
  left: ["    ", "█▀▀▀", "█ ▀█", "▀▀▀▀"],
  right: ["    ", "█▀▀█", "█  █", "▀▀▀▀"],
}

export const marks = "_^~,"
