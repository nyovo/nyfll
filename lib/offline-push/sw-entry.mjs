import { installReiSW } from "@rei-standard/amsg-sw";

const DB_NAME = "float-offline-push-v1";
const STORE_NAME = "inbox";

function openInbox() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "messageId" });
        store.createIndex("sentAt", "sentAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function persistIncomingPayload(payload) {
  if (!payload || payload.messageKind !== "content") return;
  if (payload.metadata?.test === true) return;
  const messageId = String(payload.messageId || payload.id || "");
  const charId = String(payload.metadata?.charId || "");
  const message = String(payload.message || "").trim();
  if (!messageId || !charId || !message) return;

  const db = await openInbox();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put({
        messageId,
        charId,
        message,
        sessionId: payload.sessionId || null,
        messageIndex: payload.messageIndex || 1,
        totalMessages: payload.totalMessages || 1,
        sentAt: payload.sentAt || new Date().toISOString(),
        metadata: { ...(payload.metadata || {}), origin: "offline-push" },
      });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

installReiSW(self, {
  defaultIcon: "/icon-192.png",
  defaultBadge: "/icon-192.png",
  defaultBody: "收到一条新消息",
  multipart: { enabled: true },
  onBusinessPayload: persistIncomingPayload,
});
