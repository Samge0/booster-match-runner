/**
 * Match lifecycle: start, monitor, end.
 */

import { gameControlApi } from "./docker";
import { MatchStatus } from "./types";

/** Start a match via HTTP API. */
export async function startMatch(): Promise<void> {
    await gameControlApi("/match/start", "POST", 10000);
}

/** End the current match via HTTP API. */
export async function endMatch(): Promise<void> {
    await gameControlApi("/match/end", "POST", 10000);
}

/** Get current match status. */
export async function getMatchStatus(): Promise<MatchStatus> {
    const data = await gameControlApi("/status", "GET", 8000);
    const match = data.match || {};
    const game = data.game || {};
    const score = match.score || game.score || { home: 0, away: 0 };
    const num = (v: any): number | null =>
        typeof v === "number" && Number.isFinite(v) ? v : null;
    return {
        state: game.state || "unknown",
        phase: game.phase || "",
        score: { home: score.home || 0, away: score.away || 0 },
        durationSeconds: match.durationSeconds || 0,
        isFinished: match.isFinal === true || game.state === "finished",
        startedAtWallTime: num(match.startedAtWallTime),
        endedAtWallTime: num(match.endedAtWallTime),
    };
}
