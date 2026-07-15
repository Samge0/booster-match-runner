/**
 * Minimal i18n for the Match Runner panel.
 * Two languages (English default, Chinese), persisted in workspace globalState.
 * The extension side uses t()/eventLabel()/stateLabel(); the webview receives a
 * bundle via postMessage so its inline JS can translate without imports.
 */

import * as vscode from "vscode";

export type Lang = "en" | "zh";

export const LANGS: Lang[] = ["en", "zh"];

const LANG_KEY = "boosterMatch.lang";

/** UI strings shared by the extension side and the webview bundle. */
const MESSAGES: Record<Lang, Record<string, string>> = {
    en: {
        score: "Score",
        teams: "Teams",
        actions: "Actions",
        keyEvents: "Key Events",
        start: "Start",
        end: "End",
        count: "Count",
        records: "Match records",
        noEvents: "No events yet",
        starting: "Starting…",
        containerUnreachable: "Container unreachable",
        containerNotRunning: "Container not running.",
        startContainer: "Start Container",
        startMatchUi: "Start Match + UI",
        startHeadless: "Start Headless",
        ui: "UI",
        refresh: "Refresh",
        upload: "Upload",
        save: "Save",
        loading: "Loading...",
        noAgents: "No agents",
        timeout: "Match length(s)",
        lead: "Lead goals",
        preparing: "Preparing…",
        red: "Red",
        blue: "Blue",
        exportAll: "📥 Export all to CSV...",
        agents: "Agents",
        startingContainer: "Starting container…",
        confirmDelete: "Delete this agent? This cannot be undone.",
        manageAgents: "Manage",
        manageAgentsHint: "Select an agent to delete (Esc to cancel)",
        settings: "Settings",
    },
    zh: {
        score: "比分",
        teams: "队伍",
        actions: "操作",
        keyEvents: "关键事件",
        start: "开始",
        end: "结束",
        count: "次数",
        records: "比赛记录",
        noEvents: "暂无事件",
        starting: "启动中…",
        containerUnreachable: "容器不可达",
        containerNotRunning: "容器未运行。",
        startContainer: "启动容器",
        startMatchUi: "开始比赛 + UI",
        startHeadless: "开始无头模式",
        ui: "UI",
        refresh: "刷新",
        upload: "上传",
        save: "保存",
        loading: "加载中...",
        noAgents: "无 Agent",
        timeout: "自定义赛时(秒)",
        lead: "领先球",
        preparing: "准备中…",
        red: "红",
        blue: "蓝",
        exportAll: "📥 导出全部为 CSV...",
        agents: "Agent 列表",
        startingContainer: "正在启动容器…",
        confirmDelete: "确认删除该 Agent？此操作不可撤销。",
        manageAgents: "管理",
        manageAgentsHint: "选择要删除的 Agent（按 Esc 取消）",
        settings: "设置",
    },
};

/** Match state labels. */
const STATE_LABELS: Record<Lang, Record<string, string>> = {
    en: { playing: "Playing", ready: "Ready", set: "Set", finished: "Finished" },
    zh: { playing: "进行中", ready: "准备", set: "就位", finished: "已结束" },
};

/** Key-event type labels (matches KEY_EVENTS in eventReader.ts).
 *  English falls back to humanizeType() (snake_case -> Title Case), so only the
 *  Chinese dictionary is maintained here. */
const EVENT_LABELS: Record<Lang, Record<string, string>> = {
    en: {},
    zh: {
        goal: "进球",
        goal_disallowed_indirect: "进球无效（间接任意球）",
        goal_disallowed_own_free_kick: "进球无效（己方任意球）",
        ball_free: "活球（球空闲）",
        penalty: "犯规",
        kickoff_offense_retake: "开球违规",
        global_game_stuck: "卡死",
        dropped_ball: "坠球",
        throw_in_start: "界外球",
        goal_kick_start: "球门球",
        corner_kick_start: "角球",
        set_play_retake: "定位球重发",
        match_started: "比赛开始",
        match_finished: "比赛结束",
    },
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
let _ctx: vscode.ExtensionContext | undefined;
let currentLang: Lang = "en";

/** Bind the vscode context so language can be read/persisted from globalState. */
export function initLang(context: vscode.ExtensionContext): void {
    _ctx = context;
    const saved = context.globalState.get<string>(LANG_KEY);
    currentLang = saved === "zh" || saved === "en" ? saved : "en";
}

export function getLang(): Lang {
    return currentLang;
}

export function setLang(lang: Lang): void {
    currentLang = lang;
    if (_ctx) { void _ctx.globalState.update(LANG_KEY, lang); }
}

export function toggleLang(): Lang {
    const next: Lang = currentLang === "en" ? "zh" : "en";
    setLang(next);
    return next;
}

export function t(key: string): string {
    return MESSAGES[currentLang][key] ?? MESSAGES.en[key] ?? key;
}

export function stateLabel(state: string): string {
    return STATE_LABELS[currentLang][state] ?? STATE_LABELS.en[state] ?? state;
}

export function eventLabel(type: string): string {
    return EVENT_LABELS[currentLang][type] ?? humanizeType(type);
}

/** snake_case -> "Title Case" (e.g. goal_disallowed_indirect -> "Goal Disallowed Indirect"). */
export function humanizeType(type: string): string {
    return type.split("_").map((w) => w ? w[0].toUpperCase() + w.slice(1) : w).join(" ");
}

export interface I18nBundle {
    lang: Lang;
    msg: Record<string, string>;
    states: Record<string, string>;
    events: Record<string, string>;
}

/** Build the bundle shipped to the webview so its inline JS can translate. */
export function getI18nBundle(): I18nBundle {
    return {
        lang: currentLang,
        msg: MESSAGES[currentLang],
        states: STATE_LABELS[currentLang],
        events: EVENT_LABELS[currentLang],
    };
}
