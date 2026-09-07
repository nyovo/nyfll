"use client";

import { useEffect, useState } from "react";
import { BellRing, Loader2 } from "lucide-react";
import { disableOfflinePush, enableOfflinePush, isOfflinePushConfigured, sendOfflinePushTest } from "@/lib/offline-push/client";

export function OfflinePushSettings({ onNotice }: { onNotice?: (message: string) => void }) {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const configured = isOfflinePushConfigured();

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.ready.then(registration => registration.pushManager.getSubscription()).then(subscription => setEnabled(Boolean(subscription)));
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
  </div>;
}
