// lib/memory-sync/runner.ts
// 学习记忆的一次同步：拉取远端清单 → 按 id 合并进目标角色 → 记账。
//
// 幂等由两层保证：
//   1) 服务端只下发设备上还没有的条目；
//   2) 这里 importMemoriesIntoCharacter 会再按 id 逐条跳过。
// 所以定时器跑多少次都不会堆出重复记忆。

import { fetchRemoteMemories, importMemoriesIntoCharacter } from "../memory-import";
import { isStudyMemorySyncReady, loadStudyMemorySyncConfig, type StudyMemorySyncConfig } from "./config";
import { loadStudyMemorySyncState, saveStudyMemorySyncState } from "./state";

export type StudyMemorySyncResult =
    | { status: "skipped"; reason: string }
    | { status: "ok"; added: number; skipped: number; total: number }
    | { status: "error"; error: string };

/**
 * 执行一次同步。options.plotOnly=true 时只拉取不写入（给界面"先看清单"用）。
 */
export async function runStudyMemorySync(
    options: { config?: StudyMemorySyncConfig; plotOnly?: boolean } = {},
): Promise<StudyMemorySyncResult> {
    const config = options.config ?? loadStudyMemorySyncConfig();
    if (!config.url) return { status: "skipped", reason: "还没设置记忆接口地址" };
    if (!config.characterId) return { status: "skipped", reason: "还没选定同步给哪个角色" };
    if (!options.plotOnly && !isStudyMemorySyncReady(config)) {
        return { status: "skipped", reason: "自动同步未打开" };
    }

    const state = loadStudyMemorySyncState();
    const attemptedAt = new Date().toISOString();
    try {
        const remote = await fetchRemoteMemories(config.url);
        if (options.plotOnly) {
            return { status: "ok", added: remote.entries.length, skipped: 0, total: remote.entries.length };
        }
        const summary = await importMemoriesIntoCharacter(config.characterId, remote.entries);
        saveStudyMemorySyncState({
            ...state,
            lastAttemptAt: attemptedAt,
            lastSuccessAt: attemptedAt,
            lastAdded: summary.added,
            lastSkipped: summary.skipped,
            lastError: undefined,
        });
        return { status: "ok", added: summary.added, skipped: summary.skipped, total: summary.total };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // 失败只记账，不抛给调用方：定时器里静默，界面里显示状态
        saveStudyMemorySyncState({ ...state, lastAttemptAt: attemptedAt, lastError: message });
        return { status: "error", error: message };
    }
}
