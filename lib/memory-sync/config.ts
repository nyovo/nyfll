// lib/memory-sync/config.ts
// StudyMate 学习记忆的自动同步配置。
//
// 与云备份配置（lib/cloud-backup/config.ts）**完全独立**：不同的存储键、不同的
// 界面、不同的定时器。学习同步出问题不会影响云备份，反之亦然。
//
// 用户可见的开关：
//   enabled   —— 打开后由 StudyMemorySyncScheduler 定时静默同步
//   url       —— StudyMate 本地记忆接口（形如 https://192.168.1.174:8765/studymate/memories.json）
//   characterId —— 同步给哪个角色（记忆是按角色绑定的，必须明确指定）
//   intervalMinutes —— 同步间隔

import { kvGet, kvSet, registerKvMigration } from "../kv-db";

const CONFIG_KEY = "ai_phone_studymate_memory_sync_v1";
registerKvMigration(CONFIG_KEY);

export type StudyMemorySyncConfig = {
    enabled: boolean;
    url: string;
    characterId: string;
    /** 间隔（分钟）。手机与 Mac 同一网络时才有意义，默认 30 分钟。 */
    intervalMinutes: number;
    /** 记忆合并进哪个类型：学习记忆固定写长期记忆。 */
    targetType: "long_term";
};

export const DEFAULT_STUDY_MEMORY_SYNC_CONFIG: StudyMemorySyncConfig = {
    enabled: false,
    url: "",
    characterId: "",
    intervalMinutes: 30,
    targetType: "long_term",
};

const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 24 * 60;

function clampInterval(value: unknown): number {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_STUDY_MEMORY_SYNC_CONFIG.intervalMinutes;
    return Math.max(MIN_INTERVAL_MINUTES, Math.min(MAX_INTERVAL_MINUTES, Math.round(n)));
}

/** 去掉尾部斜杠；没写协议就补 https（手机上的页面是 https，必须走 https）。 */
export function normalizeStudyMemoryUrl(url: string): string {
    const trimmed = (url || "").trim().replace(/\/+$/, "");
    if (!trimmed) return "";
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function loadStudyMemorySyncConfig(): StudyMemorySyncConfig {
    try {
        const raw = kvGet(CONFIG_KEY);
        if (!raw) return { ...DEFAULT_STUDY_MEMORY_SYNC_CONFIG };
        const parsed = JSON.parse(raw) as Partial<StudyMemorySyncConfig>;
        return {
            enabled: parsed.enabled === true,
            url: normalizeStudyMemoryUrl(String(parsed.url ?? "")),
            characterId: typeof parsed.characterId === "string" ? parsed.characterId : "",
            intervalMinutes: clampInterval(parsed.intervalMinutes),
            targetType: "long_term",
        };
    } catch {
        return { ...DEFAULT_STUDY_MEMORY_SYNC_CONFIG };
    }
}

export function saveStudyMemorySyncConfig(config: StudyMemorySyncConfig): void {
    const next: StudyMemorySyncConfig = {
        enabled: config.enabled === true,
        url: normalizeStudyMemoryUrl(config.url),
        characterId: (config.characterId || "").trim(),
        intervalMinutes: clampInterval(config.intervalMinutes),
        targetType: "long_term",
    };
    kvSet(CONFIG_KEY, JSON.stringify(next));
}

/** 自动同步是否具备运行条件（有链接、有角色、已打开）。 */
export function isStudyMemorySyncReady(config: StudyMemorySyncConfig): boolean {
    return Boolean(config.enabled && config.url && config.characterId);
}
