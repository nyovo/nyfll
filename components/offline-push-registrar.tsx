"use client";

import { useEffect } from "react";
import { CHAT_MESSAGE_PUSHED_EVENT, refreshOfflinePushSchedules } from "@/lib/offline-push/schedule";
import { drainOfflinePushInbox } from "@/lib/offline-push/inbox";

export function OfflinePushRegistrar() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    const drain = () => {
      void drainOfflinePushInbox().then(count => {
        if (count > 0) {
          window.dispatchEvent(new CustomEvent("offline-push-drained", { detail: { count } }));
        }
      }).catch(error => console.warn("[offline-push] inbox drain failed", error));
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        drain();
        void refreshOfflinePushSchedules().catch(error => console.warn("[offline-push] snapshot refresh failed", error));
      }
    };
    const onServiceWorkerMessage = () => drain();
    let refreshTimer: number | undefined;
    const onChatMessage = () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        void refreshOfflinePushSchedules().catch(error => console.warn("[offline-push] snapshot refresh failed", error));
      }, 1500);
    };

    drain();
    void refreshOfflinePushSchedules().catch(error => console.warn("[offline-push] snapshot refresh failed", error));
    window.addEventListener("focus", onVisibility);
    window.addEventListener(CHAT_MESSAGE_PUSHED_EVENT, onChatMessage);
    document.addEventListener("visibilitychange", onVisibility);
    navigator.serviceWorker.addEventListener("message", onServiceWorkerMessage);
    return () => {
      window.clearTimeout(refreshTimer);
      window.removeEventListener("focus", onVisibility);
      window.removeEventListener(CHAT_MESSAGE_PUSHED_EVENT, onChatMessage);
      document.removeEventListener("visibilitychange", onVisibility);
      navigator.serviceWorker.removeEventListener("message", onServiceWorkerMessage);
    };
  }, []);

  return null;
}
