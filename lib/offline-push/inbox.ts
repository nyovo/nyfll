import {
  hydrateChatStorage,
  loadChatSessions,
  upsertImportedChatMessage,
  type ChatMessage,
} from "@/lib/chat-storage";

const DB_NAME = "float-offline-push-v1";
const STORE_NAME = "inbox";
const LOCK_NAME = "float-offline-push-drain";

export type OfflineInboxItem = {
  messageId: string;
  charId: string;
  message: string;
  sentAt: string;
  messageIndex?: number;
  totalMessages?: number;
};

function openInbox(): Promise<IDBDatabase> {
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

async function readAll(): Promise<OfflineInboxItem[]> {
  const db = await openInbox();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve((request.result as OfflineInboxItem[]).sort((a, b) =>
        String(a.sentAt).localeCompare(String(b.sentAt)) || (a.messageIndex || 0) - (b.messageIndex || 0)
      ));
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function remove(messageId: string): Promise<void> {
  const db = await openInbox();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(messageId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function drainUnlocked(): Promise<number> {
  await hydrateChatStorage();
  const sessions = loadChatSessions();
  const items = await readAll();
  let inserted = 0;

  for (const item of items) {
    const session = sessions.find(candidate => !candidate.isGroup && candidate.contactId === item.charId);
    if (!session) continue;

    const message: ChatMessage = {
      id: item.messageId,
      sessionId: session.id,
      role: "assistant",
      content: item.message,
      status: "sent",
      createdAt: item.sentAt || new Date().toISOString(),
      origin: "offline_push",
    };
    const result = upsertImportedChatMessage(message);
    if (result.inserted) inserted += 1;
    await remove(item.messageId);
  }
  return inserted;
}

export async function drainOfflinePushInbox(): Promise<number> {
  if (typeof window === "undefined" || !("indexedDB" in window)) return 0;
  const locks = navigator.locks;
  if (!locks) return drainUnlocked();
  return locks.request(LOCK_NAME, () => drainUnlocked());
}
