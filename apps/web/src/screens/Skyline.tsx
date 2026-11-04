/**
 * Dusk over a row of buildings, with windows coming on as you arrive: the idea of the game (a
 * place with people living in it) before anything's been read. It's drawn the same every time,
 * has no meaning for screen readers, and stays still for anyone who asks for less motion.
 */

const BUILDINGS = 16;
const WINDOW_ROWS = 9;
const WINDOW_COLS = 4;

/** A repeatable spread of numbers, 0 to 999, so the skyline never shifts between visits. */
const spread = (n: number) => (Math.imul(n + 1, 2654435761) >>> 0) % 1000;

export function Skyline() {
  return (
    <div className="skyline" aria-hidden="true">
      {Array.from({ length: BUILDINGS }, (_, b) => {
        const rows = 3 + (spread(b) % (WINDOW_ROWS - 2));
        return (
          <div className="tower" key={b} style={{ gridTemplateRows: `repeat(${rows}, 1fr)` }}>
            {Array.from({ length: rows * WINDOW_COLS }, (_, w) => {
              const seed = spread(b * 97 + w);
              const lit = seed % 5 < 2;
              return (
                <span
                  key={w}
                  className={lit ? "lit" : undefined}
                  style={lit ? { animationDelay: `${(seed % 26) / 10}s` } : undefined}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
