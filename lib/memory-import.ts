// lib/memory-import.ts
// 从外部链接导入长期记忆（供 StudyMate 学习记忆同步用）。
//
// 设计要点：
//   * 只走既有的 saveMemoryEntry / loadMemoryEntries —— 不新增持久化路径，也不碰备份模块；
//   * 按 id 幂等：同 id 的记忆会被跳过，所以可以反复点"导入"而不会堆积或重复；
//   * characterId 以**当前正在看的角色**为准，忽略远端声明，避免写错角色；
//   * 远端只需要返回一个 JSON：{ characterId?, memories: ImportMemoryInput[] }。

import type { MemoryEntry } from "./memory-types";
import { loadMemoryEntries, saveMemoryEntry } from "./memory-storage";

/** 远端一条记忆的最小形状（StudyMate 生成的就是这个）。 */
export type ImportMemoryInput = {
    id?: string;
    content?: string;
    importance?: number;
    createdAt?: string;
    updatedAt?: string;
    /** 可选：标题 / 关键词，会被收进 metadata 供检索。 */
    title?: string;
    keywords?: string[];
    metadata?: Record<string, unknown>;
};

export type MemoryImportPayload = {
    /** 远端自称的角色；仅用于校验提示，不决定写入目标。 */
    characterId?: string;
    memories?: ImportMemoryInput[];
};

export type FetchMemoryResult = {
    entries: ImportMemoryInput[];
    /** 远端声明的角色 id（用于与当前角色比对提示）。 */
    characterId: string;
};

export type ImportMemorySummary = {
    added: number;
    skipped: number;
    total: number;
    /** 第一条新记忆的内容，用于导入后给个可核对的提示。 */
    firstContent: string;
};

const DEFAULT_LIMIT = 200;
const MAX_CONTENT_LENGTH = 2000;

function asString(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function normalizeIncoming(raw: ImportMemoryInput, index: number): MemoryEntry | null {
    const content = asString(raw?.content).slice(0, MAX_CONTENT_LENGTH);
    if (!content) return null;
    const now = new Date().toISOString();
    const createdAt = asString(raw?.createdAt) || now;
    const importance = Number(raw?.importance);
    const keywords = Array.isArray(raw?.keywords)
        ? raw.keywords.map(k => String(k).trim()).filter(Boolean).slice(0, 8)
        : [];
    return {
        // 没有 id 的条目按内容取稳定键：重跑不会产生新条目
        id: asString(raw?.id) || `mem_lt_import_${index}_${content.length}_${content.slice(0, 24)}`,
        characterId: "", // 写入前用当前角色覆盖
        sourceApp: "chat",
        type: "long_term",
        content,
        importance: Number.isFinite(importance) ? Math.max(0, Math.min(1, importance)) : 0.8,
        createdAt,
        updatedAt: asString(raw?.updatedAt) || createdAt,
        metadata: {
            ...(raw?.metadata ?? {}),
            origin: "studymate",
            importedAt: now,
            ...(asString(raw?.title) ? { title: asString(raw?.title) } : {}),
            ...(keywords.length ? { keywords } : {}),
        },
    };
}

/** 拉取远端清单；失败时抛出可读原因。 */
export async function fetchRemoteMemories(url: string): Promise<FetchMemoryResult> {
    const target = asString(url);
    if (!target) throw new Error("请先填写链接");
    let res: Response;
    try {
        res = await fetch(target, { headers: { Accept: "application/json" }, cache: "no-store" });
    } catch (error) {
        throw new Error(
            `拉取失败：${error instanceof Error ? error.message : String(error)}。`
            + "若地址是自签 HTTPS，请先在那台机器上装好证书；手机需与它同一网络。",
        );
    }
    if (!res.ok) throw new Error(`拉取失败：HTTP ${res.status}`);
    let parsed: MemoryImportPayload;
    try {
        parsed = (await res.json()) as MemoryImportPayload;
    } catch {
        throw new Error("拉取到的不是 JSON（检查链接是否指到了正确的接口）");
    }
    const list = Array.isArray(parsed?.memories) ? parsed.memories : [];
    if (list.length === 0) throw new Error("这个链接里没有记忆条目（memories 为空）");
    return {
        entries: list.slice(0, DEFAULT_LIMIT),
        characterId: asString(parsed?.characterId),
    };
}

/** 把拉到的条目合并进该角色：同 id 跳过，其余写入。 */
export async function importMemoriesIntoCharacter(
    characterId: string,
    entries: ImportMemoryInput[],
): Promise<ImportMemorySummary> {
    if (!characterId) throw new Error("没有选中的角色");
    const existing = await loadMemoryEntries(characterId);
    const seen = new Set(existing.map(entry => entry.id));
    let added = 0;
    let skipped = 0;
    let firstContent = "";
    for (let index = 0; index < entries.length; index += 1) {
        const normalized = normalizeIncoming(entries[index], index);
        if (!normalized) {
            skipped += 1;
            continue;
        }
        if (seen.has(normalized.id)) {
            skipped += 1;
            continue;
        }
        normalized.characterId = characterId;
        await saveMemoryEntry(normalized);
        seen.add(normalized.id);
        added += 1;
        if (!firstContent) firstContent = normalized.content;
    }
    return { added, skipped, total: existing.length + added, firstContent };
}
