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
        preparing: "Preparing…",
        red: "Red",
        blue: "Blue",
        exportAll: "📥 Export all to CSV...",
        agents: "Agents",
        startingContainer: "Starting container…",
        confirmDelete: "Delete this agent? This cannot be undone.",
        manageAgents: "Manage",
        manageAgentsHint: "Select an agent to delete (Esc to cancel)",
        simBlockedHeadless: "Cannot open the simulator UI during a headless match: it resets game-control and would interrupt the running match. Use 'Start Match + UI' instead, or End the headless match first.",
        settings: "Settings",
        clock: "Clock",
        play: "Play",
        stopped: "Stopped",
        winner: "Winner",
        noSetPlay: "Open play",
        customDeployTitle: "Deploy Agent — Custom id / name",
        customDeployHint: "Agent id '{id}' already exists. A version suffix '{suf}' was appended automatically — edit it, or clear the id to overwrite the original.",
        customDeployIdLabel: "Agent id",
        customDeployNameLabel: "Display name",
        customDeployIdInvalid: "Only letters, digits and dots; must start with a letter.",
        customDeployOk: "Confirm",
        customDeployCancel: "Cancel",
        customDeployAlsoExists: "Agent id '{id}' also exists. Overwrite it?",
        customDeployOverwrite: "Overwrite",
        deployingAgent: "Deploying agent...",
        deployedAgent: "Deployed",
        deployModeNew: "new",
        deployModeOverwrite: "overwrite",
        deletingAgent: "Deleting agent...",
        deleteFailed: "Delete failed",
        runnerDied: "Runner process exited unexpectedly. This is usually stale state on the Booster Studio side. Please restart Booster Studio and retry.",
        runnerNotReady: "Runner not ready in 75s — robots may not move. This is usually stale state on the Booster Studio side. Please restart Booster Studio and retry.",
        diagnose: "Diagnose",
        diagTitle: "=== Environment Diagnosis ===",
        diagRos2: "ros2 launch processes (incl. booster_agent_manager)",
        diagSandboxes: "Stale historical sandboxes",
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
        preparing: "准备中…",
        red: "红",
        blue: "蓝",
        exportAll: "📥 导出全部为 CSV...",
        agents: "Agent 列表",
        startingContainer: "正在启动容器…",
        confirmDelete: "确认删除该 Agent？此操作不可撤销。",
        manageAgents: "管理",
        manageAgentsHint: "选择要删除的 Agent（按 Esc 取消）",
        simBlockedHeadless: "无头比赛进行中无法打开可视化 UI：会重置 game-control 并中断当前比赛。请改用「Start Match + UI」，或先结束无头比赛。",
        settings: "设置",
        clock: "时钟",
        play: "局面",
        stopped: "已停止",
        winner: "胜方",
        noSetPlay: "常规",
        customDeployTitle: "部署 Agent — 自定义 id / 名称",
        customDeployHint: "Agent id「{id}」已存在。已自动拼接版本后缀「{suf}」（可自行修改；清空 id 或保持「{id}」则覆盖原 agent）。",
        customDeployIdLabel: "Agent id",
        customDeployNameLabel: "显示名称",
        customDeployIdInvalid: "只允许字母、数字和点，且以字母开头。",
        customDeployOk: "确定",
        customDeployCancel: "取消",
        customDeployAlsoExists: "Agent id「{id}」也已存在，是否覆盖？",
        customDeployOverwrite: "覆盖",
        deployingAgent: "正在部署 Agent…",
        deployedAgent: "已部署",
        deployModeNew: "新增",
        deployModeOverwrite: "覆盖",
        deletingAgent: "正在删除 Agent…",
        deleteFailed: "删除失败",
        runnerDied: "Runner 进程意外退出。通常是 Booster Studio 侧状态陈旧导致，请重启 Booster Studio 后重试。",
        runnerNotReady: "Runner 75 秒内未就绪——机器人可能不动。通常是 Booster Studio 侧状态陈旧导致，请重启 Booster Studio 后重试。",
        diagnose: "诊断",
        diagTitle: "=== 环境诊断 ===",
        diagRos2: "ros2 launch 进程（含 booster_agent_manager）",
        diagSandboxes: "堆积的历史 sandbox",
    },
};

/** Set-play type labels. Codes are camelCase from the sim's GameControl state
 *  (e.g. "noSetPlay", "throwIn", "cornerKick"). English falls back to
 *  humanizeCamel(), so only Chinese is maintained here. */
const SETPLAY_LABELS: Record<Lang, Record<string, string>> = {
    en: {},
    zh: {
        noSetPlay: "常规",
        directFreeKick: "直接任意球",
        indirectFreeKick: "间接任意球",
        penaltyKick: "点球",
        throwIn: "界外球",
        goalKick: "球门球",
        cornerKick: "角球",
        droppedBall: "坠球",
    },
};

/** Timing-stage labels (game.timingStage / timing.stage). */
const STAGE_LABELS: Record<Lang, Record<string, string>> = {
    en: {},
    zh: { regulation: "常规", overtime: "加时", shootout: "点球大战" },
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

/** Set-play label for a camelCase code (e.g. "throwIn" -> "界外球" / "Throw In"). */
export function setPlayLabel(code: string): string {
    return SETPLAY_LABELS[currentLang][code] ?? SETPLAY_LABELS.en[code] ?? humanizeCamel(code);
}

/** Timing-stage label for a code (e.g. "overtime" -> "加时" / "Overtime"). */
export function stageLabel(code: string): string {
    return STAGE_LABELS[currentLang][code] ?? STAGE_LABELS.en[code] ?? humanizeCamel(code);
}

/** snake_case -> "Title Case" (e.g. goal_disallowed_indirect -> "Goal Disallowed Indirect"). */
export function humanizeType(type: string): string {
    return type.split("_").map((w) => w ? w[0].toUpperCase() + w.slice(1) : w).join(" ");
}

/** camelCase -> "Title Case" (e.g. noSetPlay -> "No Set Play", throwIn -> "Throw In"). */
export function humanizeCamel(code: string): string {
    return code
        .replace(/([A-Z])/g, " $1")
        .replace(/^./, (c) => c.toUpperCase())
        .trim();
}

export interface I18nBundle {
    lang: Lang;
    msg: Record<string, string>;
    states: Record<string, string>;
    events: Record<string, string>;
    setplays: Record<string, string>;
    stages: Record<string, string>;
}

/** Build the bundle shipped to the webview so its inline JS can translate. */
export function getI18nBundle(): I18nBundle {
    return {
        lang: currentLang,
        msg: MESSAGES[currentLang],
        states: STATE_LABELS[currentLang],
        events: EVENT_LABELS[currentLang],
        setplays: SETPLAY_LABELS[currentLang],
        stages: STAGE_LABELS[currentLang],
    };
}
