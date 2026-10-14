"use client";

// components/study-memory-sync-scheduler.tsx
// 学习记忆的自动同步（B+C 双触发），做法与 cloud-backup-scheduler 一致：
//   B：应用打开时，先等一小会儿再跑一次（错过的时间在这里补上）
//   C：之后每 5 分钟检查一次"到点了吗"，到点就静默同步
//
// 特性：
//   * 只在"已打开自动同步 + 有链接 + 有角色"时工作；
//   * 失败静默（只写进 state，界面下次打开时显示原因），不弹错误打扰；
//   * 模块级锁，避免多个定时器/多次挂载同时跑；
//   * 通过 window 事件通知界面刷新（正在看那个角色的记忆页时会自动重载）。

import { useEffect } from "react";

import { isStudyMemorySyncReady, loadStudyMemorySyncConfig } from "@/lib/memory-sync/config";
import { isStudyMemorySyncDue } from "@/lib/memory-sync/state";
import { runStudyMemorySync } from "@/lib/memory-sync/runner";

/** 通知界面：同步完成（payload 里有角色 id 与新增条数）。 */
export const STUDY_MEMORY_SYNCED_EVENT = "studymate:memory-synced";

let syncRunning = false;

export function StudyMemorySyncScheduler() {
    useEffect(() => {
        let cancelled = false;

        const runWhenIdle = (fn: () => void) => {
            if (typeof window.requestIdleCallback === "function") {
                window.requestIdleCallback(() => fn(), { timeout: 4000 });
            } else {
                window.setTimeout(fn, 400);
            }
        };

        const tick = () => {
            if (cancelled || syncRunning) return;
            const config = loadStudyMemorySyncConfig();
            if (!isStudyMemorySyncReady(config)) return;
            if (!isStudyMemorySyncDue(config.intervalMinutes)) return;

            runWhenIdle(async () => {
                if (cancelled || syncRunning) return;
                syncRunning = true;
                try {
                    const result = await runStudyMemorySync({ config });
                    if (result.status === "ok") {
                        window.dispatchEvent(new CustomEvent(STUDY_MEMORY_SYNCED_EVENT, {
                            detail: { characterId: config.characterId, added: result.added, skipped: result.skipped },
                        }));
                    }
                } catch {
                    /* runStudyMemorySync 已把失败写进 state；这里兜住意外异常 */
                } finally {
                    syncRunning = false;
                }
            });
        };

        // C：定时检查
        const interval = window.setInterval(tick, 5 * 60_000);
        // B：打开应用时补一次（等页面稳定后再跑，别和首屏抢）
        const initial = window.setTimeout(tick, 20_000);
        // 与云端/本机状态变化解耦：切回前台时也补一次
        const onVisible = () => {
            if (document.visibilityState === "visible") tick();
        };
        document.addEventListener("visibilitychange", onVisible);

        return () => {
            cancelled = true;
            window.clearInterval(interval);
            window.clearTimeout(initial);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, []);

    return null;
}

export default StudyMemorySyncScheduler;
