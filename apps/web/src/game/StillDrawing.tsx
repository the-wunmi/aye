/**
 * Graphics can take their time, and a page with nothing on it looks broken. Most of the waits
 * we've seen came with Ayé open in several tabs at once, all asking the same graphics card.
 */
import { useEffect, useState } from "react";

const SAY_AFTER_MS = 6_000;

export function StillDrawing() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SAY_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);
  return slow ? (
    <div className="still-drawing" role="status">
      Still drawing this. If Ayé is open in other tabs, closing them usually helps.
    </div>
  ) : null;
}
