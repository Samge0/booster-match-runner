/**
 * Incremental reader for game-control events.jsonl.
 * Pure helpers (parse/filter/map) at top; docker IO at bottom.
 * events.jsonl format (per line): { eventId, wallTime, type, actor:{side,teamName}, score:{home,away}, outcome, ... }
 */

import { dockerExec } from "./docker";

export interface ParsedEvent {
    eventId: string;
    wallTime: number;
    type: string;
    icon: string;
    actorSide: "home" | "away" | null;
    actorName: string | null;
    scoreHome: number;
    scoreAway: number;
    /** Optional pre-localized label for synthetic events (e.g. early-end reason),
     *  shown verbatim instead of deriving a label from `type`. */
    text?: string;
}

/** Event types shown in Key Events (core + restart-play). Noise types are
 *  intentionally excluded: state_changed, ball_touch, ball_placement_started,
 *  ball_placement_complete, penalty_started, penalty_complete, and setup events. */
export const KEY_EVENTS = new Set<string>([
    "goal", "goal_disallowed_indirect", "goal_disallowed_own_free_kick",
    "ball_free", "penalty", "kickoff_offense_retake", "global_game_stuck",
    "dropped_ball", "throw_in_start", "goal_kick_start", "corner_kick_start",
    "set_play_retake", "match_started", "match_finished",
]);

const TYPE_ICON: Record<string, string> = {
    goal: "⚽",
    goal_disallowed_indirect: "❌",
    goal_disallowed_own_free_kick: "❌",
    ball_free: "⚪",
    penalty: "🟨",
    kickoff_offense_retake: "⚠️",
    global_game_stuck: "⛔",
    dropped_ball: "🏐",
    throw_in_start: "📤",
    goal_kick_start: "🥅",
    corner_kick_start: "🚩",
    set_play_retake: "🔄",
    match_started: "🏁",
    match_finished: "🏁",
};

/** Parse one events.jsonl line into ParsedEvent, or null if blank/invalid/non-key. */
export function parseEventLine(line: string): ParsedEvent | null {
    const trimmed = line.trim();
    if (!trimmed) { return null; }
    let raw: any;
    try { raw = JSON.parse(trimmed); } catch { return null; }
    if (!raw || typeof raw !== "object") { return null; }
    const type: string = raw.type;
    if (!type || !KEY_EVENTS.has(type)) { return null; }
    const actor = raw.actor || null;
    const score = raw.score || {};
    const side = actor && (actor.side === "home" || actor.side === "away") ? actor.side : null;
    return {
        eventId: String(raw.eventId || ""),
        wallTime: typeof raw.wallTime === "number" ? raw.wallTime : 0,
        type,
        icon: TYPE_ICON[type] || "•",
        actorSide: side,
        actorName: actor && actor.teamName ? String(actor.teamName) : null,
        scoreHome: Number(score.home) || 0,
        scoreAway: Number(score.away) || 0,
    };
}

/** Parse a chunk of events.jsonl text (e.g. tail output) into key events, file order. */
export function parseEventsChunk(text: string): ParsedEvent[] {
    const out: ParsedEvent[] = [];
    for (const line of text.split("\n")) {
        const ev = parseEventLine(line);
        if (ev) { out.push(ev); }
    }
    return out;
}

/** De-duplicate events by eventId, keeping the first occurrence. The sim's
 *  events.jsonl occasionally contains repeated lines for the same eventId
 *  (observed: the same eventId written 2–3×), so without this the panel would
 *  show duplicate rows. Events without an eventId are dropped (can't dedupe). */
export function dedupeByEventId(events: ParsedEvent[]): ParsedEvent[] {
    const seen = new Set<string>();
    const out: ParsedEvent[] = [];
    for (const ev of events) {
        if (!ev.eventId || seen.has(ev.eventId)) { continue; }
        seen.add(ev.eventId);
        out.push(ev);
    }
    return out;
}

export function shellQuote(s: string): string {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/** Line count of the events log — captured at match start as the baseline. */
export async function getBaseLineCount(path: string): Promise<number> {
    const out = await dockerExec(`wc -l < ${shellQuote(path)}`, 8000);
    const n = parseInt(out.trim(), 10);
    return Number.isFinite(n) ? n : 0;
}

/** Read all events appended AFTER baseLineCount (1-indexed tail). Returns key events only. */
export async function readNewEvents(path: string, baseLineCount: number): Promise<ParsedEvent[]> {
    const start = baseLineCount + 1;
    const out = await dockerExec(`tail -n +${start} ${shellQuote(path)}`, 15000);
    return parseEventsChunk(out);
}
