import { previewPromptPayload } from "@/lib/chat-engine";
import {
  CHAT_MESSAGE_PUSHED_EVENT,
  loadChatMessages,
  loadChatSessions,
  type ChatSession,
} from "@/lib/chat-storage";
import { loadCharacters } from "@/lib/character-storage";
import { loadApiConfigs, loadBindingConfig, resolveBinding } from "@/lib/settings-storage";
import { enableOfflinePush } from "./client";

const clientToken = process.env.NEXT_PUBLIC_OFFLINE_PUSH_CLIENT_TOKEN || "";
const STORAGE_KEY = "float_offline_push_schedules_v1";

export { CHAT_MESSAGE_PUSHED_EVENT };

export type OfflinePushPreference = {
  sessionId: string;
  charId: string;
  intervalMinutes: number;
  enabled: boolean;
};

export type OfflinePushCandidate = {
  sessionId: string;
  charId: string;
  charName: string;
  updatedAt: string;
};

function loadPreferences(): OfflinePushPreference[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter(item => item?.sessionId && item?.charId && item?.enabled) : [];
  } catch {
    return [];
  }
}

function savePreferences(preferences: OfflinePushPreference[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  window.dispatchEvent(new CustomEvent("offline-push-schedules-updated"));
}

export function getOfflinePushPreferences(): OfflinePushPreference[] {
  return loadPreferences();
}

export function listOfflinePushCandidates(): OfflinePushCandidate[] {
  const characters = new Map(loadCharacters().map(character => [character.id, character.name]));
  const seen = new Set<string>();
  return loadChatSessions()
    .filter(session => !session.isGroup && !session.isBlacklisted && characters.has(session.contactId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .filter(session => {
      if (seen.has(session.contactId)) return false;
      seen.add(session.contactId);
      return true;
    })
    .map(session => ({
      sessionId: session.id,
      charId: session.contactId,
      charName: characters.get(session.contactId) || "角色",
      updatedAt: session.updatedAt,
    }));
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content || "");
  return content.map(part => {
    if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
      return String(part.text || "");
    }
    return "[图片]";
  }).join("\n");
}

async function buildSnapshot(session: ChatSession, intervalMinutes: number) {
  const history = loadChatMessages(session.id).slice(-120);
  if (history.length === 0) throw new Error("该角色还没有可用于生成回复的聊天记录");
  const prompt = await previewPromptPayload(session, history, {
    followUpCount: 1,
    followUpDelay: intervalMinutes * 60,
    appTags: ["chat", "text", "followup"],
  });
  const slot = resolveBinding(loadBindingConfig(), session.contactId, "chat");
  const providerConfig = loadApiConfigs().find(config => config.id === slot.apiConfigId);
  if (!providerConfig?.apiKey || !providerConfig.defaultModel) throw new Error("该角色没有可用的聊天模型配置");
  const lastUserMessage = [...history].reverse().find(message => message.role === "user");
  return {
    version: 1,
    sessionId: session.id,
    charId: session.contactId,
    charName: prompt.characterName,
    snapshotAt: new Date().toISOString(),
    lastUserAt: lastUserMessage?.createdAt || null,
    messages: prompt.messages.map(message => ({ role: message.role, content: contentToText(message.content) })),
    providerConfig: {
      provider: providerConfig.provider,
      apiKey: providerConfig.apiKey,
      baseUrl: providerConfig.baseUrl || "",
      defaultModel: providerConfig.defaultModel,
    },
  };
}

async function sendScheduleRequest(input: {
  session: ChatSession;
  intervalMinutes: number;
  sendNow?: boolean;
}) {
  const subscription = await enableOfflinePush();
  const snapshot = await buildSnapshot(input.session, input.intervalMinutes);
  const response = await fetch("/api/v1/offline-push", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Client-Token": clientToken },
    body: JSON.stringify({
      subscription: subscription.toJSON(),
      charId: snapshot.charId,
      charName: snapshot.charName,
      intervalMinutes: input.intervalMinutes,
      snapshot,
      sendNow: input.sendNow === true,
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(result.error || `保存失败 (${response.status})`));
  return result as { ok: true; nextFireAt: string };
}

export async function upsertOfflinePushSchedule(sessionId: string, intervalMinutes: number, sendNow = false) {
  const session = loadChatSessions().find(item => item.id === sessionId && !item.isGroup);
  if (!session) throw new Error("找不到可用的单聊会话");
  const result = await sendScheduleRequest({ session, intervalMinutes, sendNow });
  const next = loadPreferences().filter(item => item.charId !== session.contactId);
  next.push({ sessionId: session.id, charId: session.contactId, intervalMinutes, enabled: true });
  savePreferences(next);
  return result;
}

export async function disableOfflinePushSchedule(charId: string) {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    const response = await fetch("/api/v1/offline-push", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "X-Client-Token": clientToken },
      body: JSON.stringify({ subscription: subscription.toJSON(), charId }),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(String(result.error || `关闭失败 (${response.status})`));
    }
  }
  savePreferences(loadPreferences().filter(item => item.charId !== charId));
}

export async function disableAllOfflinePushSchedules(subscription: PushSubscription | null) {
  if (subscription) {
    await fetch("/api/v1/offline-push", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "X-Client-Token": clientToken },
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    }).catch(() => null);
  }
  savePreferences([]);
}

let refreshPromise: Promise<void> | null = null;

export function refreshOfflinePushSchedules(): Promise<void> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const preferences = loadPreferences();
    if (preferences.length === 0 || Notification.permission !== "granted") return;
    const sessions = new Map(loadChatSessions().map(session => [session.id, session]));
    for (const preference of preferences.slice(0, 5)) {
      const session = sessions.get(preference.sessionId);
      if (!session || session.isGroup) continue;
      await sendScheduleRequest({ session, intervalMinutes: preference.intervalMinutes });
    }
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}
