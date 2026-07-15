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
