# Changelog

## 0.2.5

- **Match video recording (UI mode)** — enable `boosterMatch.recordVideo` and each **Start Match + UI** run records every match to an MP4 by capturing the Booster Studio window. The recording is "what you see" — the viewer's 3D scene, the score HUD and the robot skins — so no offline re-render is needed. Each match in a Count>1 batch gets its own MP4, saved next to the match zip with the same name.
- **Cross-platform window capture** — Windows uses `gdigrab` (PowerShell resolves the window rect, clamped to the screen); Linux uses `x11grab` (`wmctrl` + `xdpyinfo`); macOS uses `avfoundation` (`osascript`) with a crop. Requires `ffmpeg` on the host PATH plus the OS-specific locator. The Studio window must stay foreground & unobstructed while recording (a minimized/covered window records blank); headless matches have no window and aren't recorded. See README → "Verified recording setups" for tested configs.
- **File names include both teams** — auto-saved records are now `match-<timestamp>_<red>_vs_<blue>_<score>.zip` / `.mp4` (team names sanitized for the filesystem), so the file list alone shows who played.

## 0.2.4

- **Fix: "robots don't move" after End → Start (leftover `ros2 launch` parents)** — `ros2 launch <pkg>` is the **parent** of `pyagent_x86`, so the existing `pkill pyagent_x86` only killed the child node and left the `ros2 launch` parent orphaned (its cgroup had already been `rm -rf`'d, so it ran on unmanaged). Those orphans kept holding the ROS2 node / package / topic names, so the next match's agents couldn't bind them and the robots stayed still. `/match/end` also does NOT destroy team sandboxes, so each End without a manual restart accumulated another pair of orphans. `endMatch()` and the start-of-match cleanup now kill leftover team-agent `ros2 launch` + `pyagent` processes (precisely excluding the `booster_agent_manager` daemon and the `com.boosterobotics.default` demo, matched in both dotted-path and underscored-package forms). End now leaves the container clean (just agent_manager + default) and the next Start binds cleanly.
- This cleanup runs **only at End and right before a new match starts** — never during a live match. This is deliberately different from the pre-flight "conflicting agent" check removed in 0.2.2, which guessed which launches were stale and could mis-flag the teams currently playing.
- **Count tooltip warns about reload** — hovering the **Count** input now shows a hint that reloading the window cancels the remaining batch (the match itself runs in the container and is unaffected, but the batch loop lives in the IDE and does not survive a window reload).
- **Batch end kills the last match's team agents** — when a Count>1 batch finishes (or is aborted), the final match's team-agent `ros2 launch` processes are now killed too, so they don't leak into the next batch. (Between matches, `restartRunnerWithTeams` already cleaned; only the final match was left behind.)
- **Start cleans up leftover agents up front** — clicking **Start** (visual or headless) now kills any leftover team-agent processes before deploying/restarting, so agents orphaned by a window reload (which breaks the in-process batch loop, leaving the last match's agents un-killed) don't hold the ROS2 namespace and block the new match.
- **Community links in README** — added a Community section pointing to the official Booster Robotics developer channels (Feishu group / Discord / booster.tech).
- **Records button label** — the 📋 button next to **Count** now shows a "Records" / "比赛记录" label beside the icon (was icon-only).

## 0.2.3

- **Count now works in visual mode** — **Start Match + UI** honors the **Count** field and runs a multi-match queue just like headless (the simulator UI opens once for the whole batch). Previously Count was silently ignored in visual mode and only one match ever ran.
- **Auto-end no longer kills the whole batch** — the `matchLength` / `leadGoals` auto-end used to call `endMatch()` (which sets `isRunning=false`), aborting the entire Count>1 queue after the first match. It now stops only the current match (`apiEndMatch`); `monitorMatch` exits on its own when the sim reports finished, so the next match starts.
- **Retried start/end HTTP calls** — `match/start` and `match/end` are now called with exponential backoff (500/1000/2000 ms, 4 attempts), so a transient game-control failure no longer leaves a match un-started or a stale match running into the next one.
- **Installable from the extension marketplace** — search **Booster Match Runner** directly in Booster Studio's Extensions view (the previous `.vsix` / build-from-source paths still work).

## 0.2.2

- **Bot-freeze forensics** — when a match start fails (`run.py` exits, or `/health` never goes ready within 75 s), the extension now captures the failure scene — `run.py` log tail, last `/health` response, sandbox dirs, and live `run.py` / `pyagent` / `ros2 launch` processes — to both the output channel and `~/.booster-match-runner/match-start-failure.log` (overwritten each failure), so an intermittent "robots don't move" can be diagnosed after the fact without shelling into the container mid-failure.
- **Restart-Booster-Studio error hint** — runner-died / not-ready errors now tell you to restart Booster Studio (the usual root cause is stale injected runtime on the Studio side), instead of a vague "check the logs".
- **Rename self-check on custom-ID deploy** — when the same `.agent` is deployed under a custom ID (or cloned for a mirror match), the renamed package is grepped for any residual original package name in text files and hits are logged; a missed rename is the classic cause of two custom-ID twins colliding on the ROS namespace.
- **Diagnose button** — a read-only **Diagnose** action dumps running `ros2 launch` processes and stale historical sandboxes to the output channel for manual inspection.
- **Guard against deleting an agent mid-match** — deleting an agent that is currently playing in a running match is blocked with a prompt to stop the match first; other agents can still be deleted.
- **Removed the invalid "conflicting agent" detection** — the pre-flight conflict check, its warning dialog, the `detectConflictingAgents` helper, and the leftover-`ros2 launch` kill were built on an unverified assumption and could mislead (they even mis-flagged the teams currently playing). Removed. Kept: fast-fail on `run.py` exit (`runnerAlive`) and the stale-sandbox cleanup.
- **Auto-suffix duplicate agent IDs on upload** — when an uploaded agent's ID already exists, the custom-ID form pre-fills a version suffix, and agents show version/status hints in the pickers.
- **Richer UI** — the live score line shows the match clock; key events carry extra detail; each agent in the pickers shows its version.

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
