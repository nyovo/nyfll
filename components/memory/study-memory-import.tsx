"use client";

// components/memory/study-memory-import.tsx
// 记忆 App 里的「从链接导入」入口：把一个 JSON 链接里的长期记忆合并进当前角色。
//
// 用途：把 StudyMate（本地学习系统）产生的学习记忆同步进小手机。服务端只需返回：
//   { "characterId": "char_…", "memories": [ { "id", "content", "importance", "createdAt", … } ] }
//
// 特点：
//   * 只调用既有的 saveMemoryEntry / loadMemoryEntries —— 不新增持久化路径，不碰备份模块；
//   * 按 id 幂等：同一条记忆重复导入会被跳过；
//   * 写入目标以**当前正在看的角色**为准，忽略远端声明的 characterId（只用来提示不一致）；
//   * 先拉取 → 给清单预览 → 再写入，不做无人值守的盲写。

import { useState } from "react";
import { Check, Download, Link2, X } from "lucide-react";
import {
    fetchRemoteMemories,
    importMemoriesIntoCharacter,
    type ImportMemoryInput,
} from "@/lib/memory-import";

type Props = {
    characterId: string;
    characterName?: string;
    /** 导入成功后由调用方刷新列表（可异步）。 */
    onImported: (added: number, skipped: number) => void | Promise<void>;
    onNotice?: (message: string) => void;
    /** toolbar：跟「新增/清除」并排的小按钮；block：空列表时的独立按钮。 */
    variant?: "toolbar" | "block";
};

const PREVIEW_LIMIT = 20;

export function StudyMemoryImportButton({ characterId, characterName, onImported, onNotice, variant = "toolbar" }: Props) {
    const [open, setOpen] = useState(false);
    const [url, setUrl] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [preview, setPreview] = useState<{ entries: ImportMemoryInput[]; remoteChar: string } | null>(null);

    const reset = () => {
        setError("");
        setPreview(null);
    };

    const handleFetch = async () => {
        if (busy) return;
        setBusy(true);
        setError("");
        try {
            const result = await fetchRemoteMemories(url);
            setPreview({ entries: result.entries, remoteChar: result.characterId });
            if (result.characterId && result.characterId !== characterId) {
                setError(`注意：链接里的记忆属于角色 ${result.characterId}，与当前角色不同——导入仍会写进当前角色。`);
            }
        } catch (err) {
            setPreview(null);
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    };

    const handleImport = async () => {
        if (busy || !preview) return;
        setBusy(true);
        setError("");
        try {
            const summary = await importMemoriesIntoCharacter(characterId, preview.entries);
            await onImported(summary.added, summary.skipped);
            onNotice?.(summary.added > 0
                ? `已导入 ${summary.added} 条记忆${summary.skipped ? `（${summary.skipped} 条已存在，跳过）` : ""}`
                : "没有新记忆需要导入（都已存在）");
            setOpen(false);
            setPreview(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    };

    const buttonClass = variant === "block" ? "mem-empty-add-btn" : "mem-entry-add-btn";

    return (
        <>
            <button
                className={buttonClass}
                onClick={() => { reset(); setOpen(true); }}
            >
                <Download size={variant === "block" ? 14 : 15} strokeWidth={1.8} />
                <span>从链接导入</span>
            </button>

            {open && (
                <div
                    className="modal-overlay modal-overlay-bottom"
                    data-ui="modal"
                    onClick={() => { if (!busy) setOpen(false); }}
                >
                    <div
                        className="modal-sheet mem-edit-sheet"
                        data-ui="modal-sheet"
                        onClick={event => event.stopPropagation()}
                    >
                        <div className="modal-header" data-ui="modal-header">
                            <button
                                className="modal-header-btn modal-header-btn-muted"
                                onClick={() => setOpen(false)}
                                disabled={busy}
                            >
                                <X size={18} />
                            </button>
                            <h3 className="modal-title">从链接导入</h3>
                            <button
                                className="modal-header-btn modal-header-btn-action"
                                onClick={() => void handleImport()}
                                disabled={busy || !preview || preview.entries.length === 0}
                            >
                                <Check size={18} />
                            </button>
                        </div>
                        <div className="modal-body mem-edit-body" data-ui="modal-body">
                            <input
                                className="input-field"
                                placeholder="https://…/memories.json"
                                value={url}
                                disabled={busy}
                                onChange={event => { setUrl(event.target.value); reset(); }}
                            />
                            <p className="ts-12 text-secondary" style={{ margin: "8px 0 0" }}>
                                先拉取看清单再写入；同一条记忆（同 id）会被跳过，可反复导入。
                            </p>
                            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                                <button
                                    className="ui-chip"
                                    onClick={() => void handleFetch()}
                                    disabled={busy || !url.trim()}
                                >
                                    <Link2 size={14} />
                                    <span>{busy ? "处理中…" : "拉取清单"}</span>
                                </button>
                            </div>
                            {error && (
                                <p className="ts-12" style={{ color: "var(--c-danger)", marginTop: 10 }}>{error}</p>
                            )}
                            {preview && (
                                <div style={{ marginTop: 12 }}>
                                    <p className="ts-13" style={{ margin: "0 0 6px" }}>
                                        拉到 <b>{preview.entries.length}</b> 条，写入
                                        <b> {characterName || characterId}</b>：
                                    </p>
                                    <ul className="ts-12 text-secondary" style={{ paddingLeft: 18, margin: 0, maxHeight: 180, overflowY: "auto" }}>
                                        {preview.entries.slice(0, PREVIEW_LIMIT).map((entry, index) => (
                                            <li key={entry.id || index} style={{ marginBottom: 4 }}>{entry.content}</li>
                                        ))}
                                    </ul>
                                    {preview.entries.length > PREVIEW_LIMIT && (
                                        <p className="ts-12 text-secondary" style={{ margin: "6px 0 0" }}>
                                            …其余 {preview.entries.length - PREVIEW_LIMIT} 条同样会导入
                                        </p>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}

export default StudyMemoryImportButton;
