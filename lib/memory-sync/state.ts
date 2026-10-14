// lib/memory-sync/state.ts
// 学习记忆自动同步的运行状态：上次同步时间、上次结果、上次失败原因。
// 只存本地（KV），不进备份、不参与同步——纯记账，用来决定"这次该不该跑"和给界面显示。

import { kvGet, kvSet, registerKvMigration } from "../kv-db";

const STATE_KEY = "ai_phone_studymate_memory_sync_state_v1";
registerKvMigration(STATE_KEY);

export type StudyMemorySyncState = {
    /** 上次尝试（成功或失败）的 ISO 时间 */
    lastAttemptAt?: string;
    /** 上次成功的 ISO 时间 */
    lastSuccessAt?: string;
    /** 上次成功合并进来的条数 */
    lastAdded?: number;
    lastSkipped?: number;
    /** 上次失败原因（成功后清空） */
    lastError?: string;
};

export function loadStudyMemorySyncState(): StudyMemorySyncState {
    try {
        const raw = kvGet(STATE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as StudyMemorySyncState;
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

export function saveStudyMemorySyncState(state: StudyMemorySyncState): void {
    try {
        kvSet(STATE_KEY, JSON.stringify(state));
    } catch {
        /* 存储不可用时静默——记账失败不该影响主流程 */
    }
}

/** 距上次成功是否已经超过间隔（没有记录时视为"该跑"）。 */
export function isStudyMemorySyncDue(intervalMinutes: number, now = Date.now()): boolean {
    const state = loadStudyMemorySyncState();
    const stamp = state.lastAttemptAt || state.lastSuccessAt;
    if (!stamp) return true;
    const last = Date.parse(stamp);
    if (!Number.isFinite(last) || last <= 0) return true;
    return now - last >= intervalMinutes * 60_000;
}

/** 给界面用的一句话状态。 */
export function describeStudyMemorySyncState(state: StudyMemorySyncState): string {
    if (state.lastError) return `上次同步失败：${state.lastError}`;
    if (!state.lastSuccessAt) return "还没有同步过";
    const when = new Date(state.lastSuccessAt).toLocaleString("zh-CN", {
        month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    const added = state.lastAdded ?? 0;
    return added > 0 ? `${when} 同步了 ${added} 条` : `${when} 同步过（无新内容）`;
}
