"use client";

import { useEffect, useState } from "react";
import { BellRing, Loader2 } from "lucide-react";
import { disableOfflinePush, enableOfflinePush, isOfflinePushConfigured, sendOfflinePushTest } from "@/lib/offline-push/client";
import {
  disableOfflinePushSchedule,
  getOfflinePushPreferences,
  listOfflinePushCandidates,
  upsertOfflinePushSchedule,
} from "@/lib/offline-push/schedule";

export function OfflinePushSettings({ onNotice }: { onNotice?: (message: string) => void }) {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [scheduledCharIds, setScheduledCharIds] = useState<string[]>([]);
  const configured = isOfflinePushConfigured();
  const candidates = typeof window === "undefined" ? [] : listOfflinePushCandidates();

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.ready.then(registration => registration.pushManager.getSubscription()).then(subscription => setEnabled(Boolean(subscription)));
    const preferences = getOfflinePushPreferences();
    setScheduledCharIds(preferences.map(item => item.charId));
    if (preferences[0]) {
      setSelectedSessionId(preferences[0].sessionId);
      setIntervalMinutes(preferences[0].intervalMinutes);
    } else if (candidates[0]) {
      setSelectedSessionId(candidates[0].sessionId);
    }
    // Candidate data is loaded from local storage once when this settings page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (task: () => Promise<void>, success: string) => {
    setBusy(true);
    try { await task(); onNotice?.(success); }
    catch (error) { onNotice?.(error instanceof Error ? error.message : "操作失败"); }
    finally { setBusy(false); }
  };

  const toggle = () => run(async () => {
    if (enabled) { await disableOfflinePush(); setEnabled(false); }
    else { await enableOfflinePush(); setEnabled(true); }
  }, enabled ? "已关闭离线推送" : "已开启离线推送");

  const selected = candidates.find(item => item.sessionId === selectedSessionId);
  const isScheduled = Boolean(selected && scheduledCharIds.includes(selected.charId));
  const saveSchedule = (sendNow: boolean) => run(async () => {
    if (!selectedSessionId) throw new Error("请先选择角色");
    await upsertOfflinePushSchedule(selectedSessionId, intervalMinutes, sendNow);
    setEnabled(true);
    if (selected) setScheduledCharIds(ids => [...new Set([...ids, selected.charId])]);
  }, sendNow ? "任务已保存，将在下一次调度时生成测试回复" : "定时离线回复已保存");
  const removeSchedule = () => run(async () => {
    if (!selected) return;
    await disableOfflinePushSchedule(selected.charId);
    setScheduledCharIds(ids => ids.filter(id => id !== selected.charId));
  }, "已关闭该角色的定时回复");

  return <div className="flex flex-col gap-[16px]">
    <div className="ui-group-card !items-stretch">
      <div className="flex items-start gap-3">
        <div className="ui-icon-circle shrink-0"><BellRing size={20} /></div>
        <div className="flex-1 flex flex-col gap-1">
          <span className="menu-label font-medium">离线推送</span>
          <span className="menu-desc !mt-0">关闭 App 或锁屏后，通过系统通知接收角色消息。</span>
        </div>
      </div>
      <button type="button" className="ui-btn ui-btn-primary w-full justify-center mt-4" disabled={busy || !configured} onClick={() => void toggle()}>
        {busy ? <><Loader2 size={16} className="animate-spin" /> 处理中…</> : enabled ? "关闭离线推送" : "开启离线推送"}
      </button>
      {!configured ? <span className="menu-desc !mt-2 text-center">服务端环境变量尚未配置</span> : null}
    </div>
    <div className="ui-group-card !items-stretch">
      <span className="menu-label font-medium">安全链路测试</span>
      <span className="menu-desc !mt-1">仅发送 Push 订阅信息，不上传聊天记录或模型密钥。</span>
      <button type="button" className="ui-btn w-full justify-center mt-4" disabled={busy || !configured} onClick={() => void run(sendOfflinePushTest, "测试通知已发送")}>发送测试通知</button>
    </div>
    <div className="ui-group-card !items-stretch">
      <span className="menu-label font-medium">定时 AI 离线回复</span>
      <span className="menu-desc !mt-1">选择角色后，会把完整提示词和模型配置经 HTTPS 发送到 Netlify，加密后存入你的 Supabase。服务端只在到期时解密调用模型。</span>
      <label className="menu-desc !mt-4">角色</label>
      <select className="ui-input w-full mt-1" value={selectedSessionId} onChange={event => setSelectedSessionId(event.target.value)} disabled={busy || candidates.length === 0}>
        {candidates.length === 0 ? <option value="">暂无可用单聊</option> : null}
        {candidates.map(item => <option key={item.sessionId} value={item.sessionId}>{item.charName}</option>)}
      </select>
      <label className="menu-desc !mt-3">无回复多久后主动联系</label>
      <select className="ui-input w-full mt-1" value={intervalMinutes} onChange={event => setIntervalMinutes(Number(event.target.value))} disabled={busy}>
        <option value={15}>15 分钟</option>
        <option value={30}>30 分钟</option>
        <option value={60}>1 小时</option>
        <option value={180}>3 小时</option>
        <option value={360}>6 小时</option>
        <option value={720}>12 小时</option>
        <option value={1440}>1 天</option>
      </select>
      <button type="button" className="ui-btn ui-btn-primary w-full justify-center mt-4" disabled={busy || !configured || !selectedSessionId} onClick={() => void saveSchedule(false)}>
        {isScheduled ? "更新定时回复" : "开启该角色定时回复"}
      </button>
      <button type="button" className="ui-btn w-full justify-center mt-2" disabled={busy || !configured || !selectedSessionId} onClick={() => void saveSchedule(true)}>立即安排一次 AI 测试回复</button>
      {isScheduled ? <button type="button" className="ui-btn w-full justify-center mt-2" disabled={busy} onClick={() => void removeSchedule()}>关闭该角色定时回复</button> : null}
      <span className="menu-desc !mt-3">每天每个角色最多发送 8 条；失败会自动退避，订阅失效后自动停用。</span>
    </div>
  </div>;
}
