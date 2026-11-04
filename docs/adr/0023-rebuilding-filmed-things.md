# 0023. Rebuilding filmed things in 3D

**Status:** accepted, amends 0012 and 0015 · 2026-11-04

## Context

A filmed place draws its things as library models or boxes wearing pictures. It works, but your
sofa isn't your sofa. SAM 3D Objects rebuilds a real thing from one image as a mesh. It needs a
large GPU, and it's offered as a hosted API by third parties.

## Decision

- One port, `ObjectReconstructor`, with two implementations selected by `RECONSTRUCT_PROVIDER`:
  `fal` (hosted, paid per call) and `modal` (our own GPU endpoint behind a small HTTP contract).
  Unset means off, and places keep the looks they have.
- A model chooses up to 8 things and, for each, up to 3 short concepts to find it by. A concept
  names the thing with what's on or in it, because a tight outline of "the shelf" rebuilds an
  empty shelf. The concept is model text reaching another model, so it's held to a few lowercase
  words with no punctuation, and its readers are segmenters, not instruction followers. Boxes drawn
  by the model were tried first and were too often wrong.
- SAM 3.1 finds each concept in every sampled frame, and code takes the frame with the largest view
  the edge doesn't cut off, or the planner's frame if it finds nothing. A model counting a dozen
  unlabelled images chose wrong frames too often.
- A result has two checks. Code compares it with the thing's measured shape (longest side over
  next longest, within 1.6 times): a coarse check from a small sample, which catches a screen found
  for its cabinet. Then Muse compares a picture of it with the frame, because code can't tell a
  full shelf from an empty one. The wrong thing means the next concept, and the thing keeps its
  old look if none works. The right thing missing what's on it is kept unless a later concept does
  better, because that still beats what it had.
- **Privacy:** this amends 0012's boundary. Whole redacted frames go to the configured
  reconstructor. Raw video and unredacted frames never do. Only `RedactedFrameSet` is accepted.
- **Untrusted output:** a GLB can reference outside addresses. `meshProblem` refuses external
  URIs, required extensions, and anything over the size and triangle caps before it's stored.
- **A look, never physics:** the mesh is drawn inside the thing's measured box. Bodies, walls and
  what things do don't change, so the sim's hash and every world eval are unaffected.

## Consequences

- Filming costs about $0.02 more per rebuild tried on `fal` (at most 24 a place), plus a SAM 3.1 call
  per frame and concept, and a Muse call per result judged.
- The place opens first and its rebuilt things appear afterwards, applied on top of whatever the
  place has become by then, so a rearrangement or a new ability made meanwhile isn't lost.
- The SAM License's position on commercial use needs a legal read before a real launch.
