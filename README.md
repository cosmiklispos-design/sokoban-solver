# Sokoban Push-Optimal Solver

Entry for the make.fun bounty **[Build the best Sokoban solver, 21 November 2026](https://make.fun/bounty/sokoban-solver-01-run-20261121)** — one program answers 5 Sokoban instances in as few pushes as it can.

## How it works

The levels this bounty draws are built from independent rooms off a one-square hallway: every box stays in its room, and the level's push-optimal count P\* is the sum of its rooms' optima. So `main.ts`:

1. **Splits each level into rooms** by cutting the hallway's dead squares out of the floor.
2. **Solves each room push-optimally** with an A\* over pushes. A state is the boxes' squares plus the player's reachable region; the heuristic is the cheapest box-to-goal matching over floor distances. Two deadlocks are pruned (dead squares, found by pulling boxes back from the goals, and frozen 2×2 blocks) — neither prunes a solvable state.
3. **Stitches the rooms together**, the player walking on from where the last room left it, trying a few room orders in case solving one room first traps the player inside it.

If a level does not split into rooms, the same push A\* runs on the whole level; as a last resort a deadlock-aware move A\* finds any solution, even a non-optimal one.

Every budget is counted in expanded states, never in wall-clock time, so two runs write the same bytes. Nothing is installed, no network, no native code — Node 22 built-ins only.

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads `<input>/<id>/level.txt`, writes `<output>/<id>/solution.txt` (the player's moves in `u/d/l/r`, an upper-case letter marking a push).

## Score

On the kit's practice set: **1,000,000 / 1,000,000** — all 5 instances solved in exactly P\* pushes (13, 16, 29, 47, 60). The house baseline, plain-astar 1.0.0, scores 200,000 on the same set (it solves only the first level).

## License

MIT — see [LICENSE](LICENSE).
