/**
 * Shared types for Booster Match Runner.
 */

export interface AgentInfo {
    /** Agent ID, e.g. "com.samge.agent" */
    id: string;
    /** Display name */
    name: string;
    /** Source: "container" (in sim container extract dir) or "file" (.agent file) */
    source: "container" | "file";
    /** Path inside container or on host */
    path: string;
    /** Version string */
    version?: string;
}

export interface MatchScore {
    home: number;
    away: number;
}

export interface MatchStatus {
    state: string;       // "playing" | "ready" | "set" | "finished"
    phase: string;       // "firstHalf" | "secondHalf" | etc.
    score: MatchScore;
    durationSeconds: number;
    isFinished: boolean;
    startedAtWallTime: number | null;   // match start Unix seconds; null before kick-off
    endedAtWallTime: number | null;     // match end Unix seconds; null until finished
    /** Seconds remaining in the current timing stage (regulation/overtime),
     *  straight from the sim's GameControl state. null when not reported. */
    timeRemaining: number | null;
    /** Match-internal elapsed time counting UP (0 -> duration), derived from
     *  timeRemaining so the panel matches the simulator UI's clock direction.
     *  null when the inputs to derive it are missing. */
    elapsedSeconds: number | null;
    /** Current set-play type as a camelCase code, e.g. "noSetPlay",
     *  "throwIn", "cornerKick", "penaltyKick". "" if not reported. */
    setPlay: string;
    /** Which side has ball rights during a set play, or null. */
    kickingSide: "home" | "away" | null;
    /** Timing stage code: "regulation" | "overtime" | ... "" if not reported. */
    timingStage: string;
    /** True when the referee has stopped play (game-control stopped flag). */
    stopped: boolean;
    /** Winning side once finished, or null. */
    winner: "home" | "away" | null;
    /** Sim-reported match end reason code, e.g. "operator_finish". "" if none. */
    endReason: string;
}

export interface MatchConfig {
    team1Agent: string;
    team2Agent: string;
    headless: boolean;
}

export interface DeployResult {
    success: boolean;
    message: string;
}
