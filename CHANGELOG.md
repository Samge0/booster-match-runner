# Changelog

## 0.2.1

- **Tag-agnostic sim container detection** — the container is now auto-detected by substring-matching the image name (running containers first) and falls back to `virtual-robot/virtual-robot`, so a version mismatch (e.g. `0.6.4-beta` vs `0.6.5-beta`) no longer causes "Could not find sim container by image". `simImage` defaults to empty; pin a full `image:tag` only if needed.
- **Reload-safe auto-end** — `matchLength` / `leadGoals` now run inside the independent status poll, so they still end the match after a Booster Studio window reload (the old monitor loop did not survive reload). A synthetic 🛑 event is appended noting which condition ended the match early.
- **Headless start no longer blocks the panel** — buttons refresh the instant a match starts (Start disabled, End enabled); opening the simulator UI during a headless match is blocked, since it would reset game-control and interrupt the match.
- **Resilient match monitor** — if a match is interrupted externally and the state gets stuck, the monitor exits on its own instead of spinning forever, and **End** always unlocks the panel. Starting a new match while one is running offers "Stop & Start New" instead of just warning.
- **Settings-first config** — `Match length` and `Lead goals` moved from the panel to the Settings page with detailed descriptions; the redundant `projectsDir` setting was removed (folded into `hostAgentRoots`); the upload dialog now defaults to the current workspace folder; settings are ordered by how often you'll touch them.
- **Settings entry button** on the panel, plus the panel state is refreshed when a match completes.

## 0.2.0

- **Upload agent with duplicate ID** — when an uploaded agent's ID already exists in the container, pick a custom ID/name to deploy it as an independent copy, or overwrite. Custom-ID deployment rewrites the full agent identity (ROS2 package name, `site-packages`, ament index) and restores executable bits, so the same agent can run on both teams.
- **Manage & delete agents** — new **Manage** action opens a picker to delete any agent (container agents are removed from the container; local `.agent` files are deleted from disk), with a confirmation prompt.
- **Reload-safe panel** — after a Booster Studio window reload, the Red/Blue pickers restore the two teams of the ongoing match (persisted locally), and the **End** button stays clickable while a match is running.
- **Hide the built-in demo agent** — `com.boosterobotics.default` (loads but doesn't play soccer) is filtered out of the picker by default.
- **UI polish** — Start-Container spinner while the container boots; each agent in the pickers shows its source and ID; the Actions row uses icon-over-label buttons.

## 0.1.0

First public release.

- **Run 3v3 robot soccer matches** between any two agents (Red vs Blue), picked from the running sim container and/or local `.agent` files.
- **Two modes**: visual match (opens the simulator replay UI) and headless (no UI); queue several matches in a row via **Count**.
- **Live score & match clock**, polled every 3 s, with automatic finish detection.
- **Key Events timeline** — goals, fouls, set-plays and more, streamed from the container's `events.jsonl`.
- **Configurable auto-end** — set a match length (s) and/or a lead-goal margin on the panel; `0` leaves the end to the sim.
- **Match records** — every finished match is archived (summary + events + run log); export all to CSV (Excel-friendly); manually save a match-log zip anytime.
- **One-click sim-container start** and **`.agent` upload** straight into the container.
- **English / Chinese** one-click language toggle for the whole panel.
