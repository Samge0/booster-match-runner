/**
 * Match lifecycle: start, monitor, end.
 */

import { gameControlApi } from "./docker";
import { MatchStatus } from "./types";

/** Call the game-control API with exponential-backoff retries. Used for
 *  state-changing calls (start/end) where a transient failure leaves the sim
 *  in a bad state: a missed start means the match never begins (monitorMatch
 *  then stalls), a missed end leaves a stale match corrupting the next one in
 *  a batch. Final error is propagated; callers catch it. */
async function apiCallWithRetry(path: string, method: string, timeoutMs: number): Promise<any> {
    const backoff = [500, 1000, 2000];
    let lastErr: unknown;
    for (let i = 0; i <= backoff.length; i++) {
        try {
            return await gameControlApi(path, method, timeoutMs);
        } catch (err) {
            lastErr = err;
            if (i < backoff.length) { await new Promise((r) => setTimeout(r, backoff[i])); }
        }
    }
    throw lastErr;
}

/** Start a match via HTTP API (with retries). */
export async function startMatch(): Promise<void> {
    await apiCallWithRetry("/match/start", "POST", 10000);
}

/** End the current match via HTTP API (with retries). */
export async function endMatch(): Promise<void> {
    await apiCallWithRetry("/match/end", "POST", 10000);
}

const num = (v: any): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;

const str = (v: any): string => (typeof v === "string" ? v : "");

const side = (v: any): "home" | "away" | null =>
    v === "home" || v === "away" ? v : null;

/** Get current match status. */
export async function getMatchStatus(): Promise<MatchStatus> {
    const data = await gameControlApi("/status", "GET", 8000);
    // The sim returns { gameControl, match: { ..., game: {...}, timing: {...} } }.
    // The detailed GameControl state lives under data.match.game (NOT data.game —
    // that path never existed, so `state` used to be "unknown" and active/set-play
    // detection silently failed). Timing may be duplicated under match.timing.
    const match = data.match || {};
    const game = match.game || data.game || {};
    const timing = match.timing || {};
    const score = match.score || game.score || { home: 0, away: 0 };
    const timeRemaining = num(game.timeRemaining ?? timing.timeRemaining);
    const stage = str(game.timingStage ?? timing.stage);
    // Derive a count-UP clock (matching the simulator UI) from the sim's
    // count-DOWN timeRemaining. Overtime adds its own elapsed on top of the
    // regulation length; regulation is simply regularDurationSeconds - remaining.
    const regular = num(game.regularDurationSeconds ?? timing.regularDurationSeconds);
    const extraElapsed = num(timing.extraTimeElapsedSeconds);
    let elapsed: number | null = null;
    if (stage === "overtime") {
        if (regular != null && extraElapsed != null) { elapsed = regular + extraElapsed; }
    } else if (regular != null && timeRemaining != null) {
        elapsed = Math.max(0, regular - timeRemaining);
    }
    return {
        state: str(game.state) || "unknown",
        phase: str(game.phase),
        score: { home: score.home || 0, away: score.away || 0 },
        durationSeconds: match.durationSeconds || 0,
        isFinished: match.isFinal === true || game.state === "finished",
        startedAtWallTime: num(match.startedAtWallTime),
        endedAtWallTime: num(match.endedAtWallTime),
        timeRemaining,
        elapsedSeconds: elapsed,
        setPlay: str(game.setPlay),
        kickingSide: side(game.kickingSide),
        timingStage: stage,
        stopped: game.stopped === true,
        winner: side(match.winner),
        endReason: str(match.endReason),
    };
}
