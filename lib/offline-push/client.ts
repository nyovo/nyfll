const clientToken = process.env.NEXT_PUBLIC_OFFLINE_PUSH_CLIENT_TOKEN || "";
const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "";

export function isOfflinePushConfigured(): boolean {
  return Boolean(clientToken && vapidPublicKey);
}

function decodeVapidKey(value: string): Uint8Array {
  const padded = `${value}${"=".repeat((4 - value.length % 4) % 4)}`.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}

export async function enableOfflinePush(): Promise<PushSubscription> {
  if (!isOfflinePushConfigured()) throw new Error("离线推送服务尚未完成配置");
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("当前浏览器不支持 Web Push");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("通知权限未开启");
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  return existing || registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: decodeVapidKey(vapidPublicKey) as BufferSource,
  });
}

export async function disableOfflinePush(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    const { disableAllOfflinePushSchedules } = await import("./schedule");
    await disableAllOfflinePushSchedules(subscription);
  }
  if (subscription) await subscription.unsubscribe();
}

export async function sendOfflinePushTest(): Promise<void> {
  const subscription = await enableOfflinePush();
  const response = await fetch("/api/v1/push-test", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Client-Token": clientToken },
    body: JSON.stringify({ subscription: subscription.toJSON() }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(result.error || `测试失败 (${response.status})`));
}
