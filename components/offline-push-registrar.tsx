"use client";

import { useEffect } from "react";
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
      if (document.visibilityState === "visible") drain();
    };
    const onServiceWorkerMessage = () => drain();

    drain();
    window.addEventListener("focus", drain);
    document.addEventListener("visibilitychange", onVisibility);
    navigator.serviceWorker.addEventListener("message", onServiceWorkerMessage);
    return () => {
      window.removeEventListener("focus", drain);
      document.removeEventListener("visibilitychange", onVisibility);
      navigator.serviceWorker.removeEventListener("message", onServiceWorkerMessage);
    };
  }, []);

  return null;
}
