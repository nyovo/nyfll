import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { sendWebPush } from "@rei-standard/amsg-instant";

const MAX_SNAPSHOT_BYTES = 512_000;
const DAILY_LIMIT = 8;

function required(name) {
  const value = Netlify.env.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function base64urlBuffer(value) {
  return Buffer.from(String(value).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function encryptionKey() {
  const key = base64urlBuffer(required("OFFLINE_PUSH_ENCRYPTION_KEY"));
  if (key.length !== 32) throw new Error("OFFLINE_PUSH_ENCRYPTION_KEY must decode to 32 bytes");
  return key;
}

function fromBytea(value) {
  const text = String(value || "");
  if (!text.startsWith("\\x")) throw new Error("Invalid encrypted database value");
  return Buffer.from(text.slice(2), "hex");
}

function encryptSnapshot(snapshot) {
  const plain = Buffer.from(JSON.stringify(snapshot), "utf8");
  if (plain.length > MAX_SNAPSHOT_BYTES) throw new Error("SNAPSHOT_TOO_LARGE");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return { cipherHex: encrypted.toString("hex"), ivHex: Buffer.from(iv).toString("hex") };
}

function decryptSnapshot(cipherValue, ivValue) {
  const packed = fromBytea(cipherValue);
  const iv = fromBytea(ivValue);
  if (packed.length <= 16) throw new Error("Invalid encrypted snapshot");
  const tag = packed.subarray(packed.length - 16);
  const cipherText = packed.subarray(0, packed.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(cipherText), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

function endpointHash(endpoint) {
  return createHash("sha256").update(endpoint).digest("hex");
}

async function supabaseRequest(path, init = {}) {
  const url = `${required("SUPABASE_URL").replace(/\/$/, "")}/rest/v1/${path}`;
  const key = required("SUPABASE_PUBLISHABLE_KEY");
  const response = await fetch(url, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(`Supabase ${response.status}: ${detail}`);
  }
  if (response.status === 204) return null;
  return response.json().catch(() => null);
}

async function gateway(action, payload = {}) {
  return supabaseRequest("rpc/offline_push_gateway", {
    method: "POST",
    body: JSON.stringify({
      p_token: required("OFFLINE_PUSH_DB_TOKEN"),
      p_action: action,
      p_payload: payload,
    }),
  });
}

function validateSubscription(subscription) {
  const endpoint = String(subscription?.endpoint || "");
  const p256dh = String(subscription?.keys?.p256dh || "");
  const auth = String(subscription?.keys?.auth || "");
  if (!endpoint.startsWith("https://") || !p256dh || !auth) throw new Error("INVALID_SUBSCRIPTION");
  return { endpoint, p256dh, auth };
}

function validateScheduleBody(body) {
  const subscription = validateSubscription(body?.subscription);
  const charId = String(body?.charId || "").trim();
  const charName = String(body?.charName || "").trim().slice(0, 120);
  const intervalMinutes = Math.floor(Number(body?.intervalMinutes));
  const snapshot = body?.snapshot;
  if (!charId || !charName || !snapshot || snapshot.version !== 1) throw new Error("INVALID_SCHEDULE");
  if (!Number.isFinite(intervalMinutes) || intervalMinutes < 15 || intervalMinutes > 10080) {
    throw new Error("INVALID_INTERVAL");
  }
  if (snapshot.charId !== charId || snapshot.charName !== charName) throw new Error("SNAPSHOT_MISMATCH");
  return { subscription, charId, charName, intervalMinutes, snapshot };
}

export async function handleOfflinePushRequest(request) {
  if (request.headers.get("X-Client-Token") !== required("AMSG_CLIENT_TOKEN")) {
    return jsonResponse(401, { error: "UNAUTHORIZED" });
  }

  const body = await request.json().catch(() => null);
  try {
    if (request.method === "DELETE") {
      const { endpoint } = validateSubscription(body?.subscription);
      const hash = endpointHash(endpoint);
      const charId = String(body?.charId || "").trim();
      await gateway("disable", { endpoint_hash: hash, char_id: charId || null });
      return jsonResponse(200, { ok: true });
    }

    if (request.method !== "POST") return jsonResponse(405, { error: "METHOD_NOT_ALLOWED" });
    const input = validateScheduleBody(body);
    const encrypted = encryptSnapshot(input.snapshot);
    const now = Date.now();
    const intervalMs = input.intervalMinutes * 60_000;
    const nextFireAt = new Date(body?.sendNow === true ? now : now + intervalMs).toISOString();
    await gateway("upsert", {
        endpoint_hash: endpointHash(input.subscription.endpoint),
        char_id: input.charId,
        char_name: input.charName,
        push_endpoint: input.subscription.endpoint,
        push_p256dh: input.subscription.p256dh,
        push_auth: input.subscription.auth,
        interval_ms: intervalMs,
        max_interval_ms: Math.min(intervalMs * 8, 7 * 24 * 60 * 60_000),
        next_fire_at: nextFireAt,
        lease_until: null,
        snapshot_cipher_hex: encrypted.cipherHex,
        snapshot_iv_hex: encrypted.ivHex,
    });
    return jsonResponse(200, { ok: true, nextFireAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.startsWith("INVALID_") || message === "SNAPSHOT_TOO_LARGE" || message === "SNAPSHOT_MISMATCH" ? 400 : 500;
    console.error("[offline-push] schedule request failed", message);
    return jsonResponse(status, { error: message });
  }
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content || "");
  return content.map(part => part?.type === "text" ? String(part.text || "") : "[图片]").join("\n");
}

function normalizeMessages(messages, elapsedMinutes) {
  const normalized = Array.isArray(messages) ? messages.map(message => ({
    role: message?.role === "assistant" ? "assistant" : message?.role === "system" ? "system" : "user",
    content: textContent(message?.content),
  })).filter(message => message.content.trim()) : [];
  normalized.push({
    role: "system",
    content: `[定时离线追发：对方仍未回复，距快照更新约 ${elapsedMinutes} 分钟。请以角色身份自然地主动发一条简短消息；不要解释系统任务，不要输出分析过程。]`,
  });
  return normalized;
}

function providerBaseUrl(config) {
  if (config.baseUrl) return config.baseUrl;
  return {
    OpenAI: "https://api.openai.com/v1",
    Anthropic: "https://api.anthropic.com/v1",
    Google: "https://generativelanguage.googleapis.com/v1beta",
    DeepSeek: "https://api.deepseek.com/v1",
    Groq: "https://api.groq.com/openai/v1",
    OpenRouter: "https://openrouter.ai/api/v1",
    Moonshot: "https://api.moonshot.cn/v1",
    Zhipu: "https://open.bigmodel.cn/api/paas/v4",
    SiliconFlow: "https://api.siliconflow.cn/v1",
    TogetherAI: "https://api.together.xyz/v1",
  }[config.provider] || "";
}

function responseText(data) {
  const direct = data?.choices?.[0]?.message?.content;
  if (typeof direct === "string") return direct;
  if (Array.isArray(direct)) return direct.map(item => item?.text || "").join("");
  if (Array.isArray(data?.content)) return data.content.map(item => item?.text || "").join("");
  if (Array.isArray(data?.candidates?.[0]?.content?.parts)) {
    return data.candidates[0].content.parts.map(item => item?.text || "").join("");
  }
  return "";
}

async function generateReply(snapshot, elapsedMinutes) {
  const config = snapshot?.providerConfig || {};
  const apiKey = String(config.apiKey || "");
  const model = String(config.defaultModel || "");
  const baseUrl = providerBaseUrl(config).replace(/\/$/, "");
  if (!apiKey || !model || !baseUrl) throw new Error("INVALID_MODEL_CONFIG");
  const messages = normalizeMessages(snapshot.messages, elapsedMinutes);
  let url;
  let headers = { "Content-Type": "application/json" };
  let body;

  if (config.provider === "Anthropic" && !config.baseUrl) {
    url = `${baseUrl}/messages`;
    headers = { ...headers, "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
    const system = messages.filter(item => item.role === "system").map(item => item.content).join("\n\n");
    body = { model, system, messages: messages.filter(item => item.role !== "system"), max_tokens: 1200, temperature: 0.8 };
  } else if (config.provider === "Google") {
    url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const system = messages.filter(item => item.role === "system").map(item => item.content).join("\n\n");
    body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.filter(item => item.role !== "system").map(item => ({
        role: item.role === "assistant" ? "model" : "user",
        parts: [{ text: item.content }],
      })),
      generationConfig: { temperature: 0.8, maxOutputTokens: 1200 },
    };
  } else {
    url = baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`;
    headers.Authorization = `Bearer ${apiKey}`;
    if (baseUrl.includes("openrouter.ai")) {
      headers["HTTP-Referer"] = "https://magical-salmiakki-4abbff.netlify.app";
      headers["X-Title"] = "float";
    }
    body = { model, messages, temperature: 0.8, max_tokens: 1200 };
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 240);
    throw new Error(`MODEL_${response.status}: ${detail}`);
  }
  const output = responseText(await response.json());
  if (!output.trim()) throw new Error("EMPTY_MODEL_RESPONSE");
  return output;
}

function visibleReply(raw) {
  const withoutThinking = String(raw)
    .replace(/<think(?:ing)?[\s\S]*?<\/think(?:ing)?>/gi, "")
    .replace(/<state(?:_values)?[\s\S]*?<\/state(?:_values)?>/gi, "")
    .replace(/<summary[\s\S]*?<\/summary>/gi, "")
    .trim();
  const contentMatches = [...withoutThinking.matchAll(/<content[^>]*>([\s\S]*?)<\/content>/gi)]
    .map(match => match[1].trim()).filter(Boolean);
  const selected = contentMatches.length ? contentMatches.join("\n") : withoutThinking.replace(/<[^>]+>/g, " ");
  return selected.replace(/\n{3,}/g, "\n\n").trim().slice(0, 3000);
}

async function updateSchedule(row, values) {
  return gateway("update", { endpoint_hash: row.endpoint_hash, char_id: row.char_id, ...values });
}

async function logDelivery(row, outcome, messageId, errorCode, metadata = {}) {
  return gateway("log", {
      endpoint_hash: row.endpoint_hash,
      char_id: row.char_id,
      message_id: messageId,
      outcome,
      error_code: errorCode || null,
      metadata,
  }).catch(error => console.warn("[offline-push] delivery log failed", error.message));
}

export async function processDueSchedules(limit = 1) {
  const rows = await gateway("claim", { limit: Math.max(1, Math.min(limit, 3)) }) || [];
  const results = [];

  for (const row of rows) {
    const deterministicId = createHash("sha256")
      .update(`${row.endpoint_hash}:${row.char_id}:${row.next_fire_at}`)
      .digest("hex").slice(0, 32);
    try {
      const snapshot = decryptSnapshot(row.snapshot_cipher, row.snapshot_iv);
      const elapsedMinutes = Math.max(1, Math.round((Date.now() - new Date(row.snapshot_updated_at || row.updated_at).getTime()) / 60_000));
      const message = visibleReply(await generateReply(snapshot, elapsedMinutes));
      if (!message) throw new Error("EMPTY_VISIBLE_REPLY");
      await sendWebPush({
        subscription: { endpoint: row.push_endpoint, keys: { p256dh: row.push_p256dh, auth: row.push_auth } },
        vapid: {
          email: Netlify.env.get("VAPID_SUBJECT") || "mailto:admin@example.com",
          publicKey: required("VAPID_PUBLIC_KEY"),
          privateKey: required("VAPID_PRIVATE_KEY"),
        },
        payload: JSON.stringify({
          messageKind: "content",
          messageType: "instant",
          source: "instant",
          messageSubtype: "float.offline.followup",
          messageId: deterministicId,
          sessionId: snapshot.sessionId || null,
          message,
          sentAt: new Date().toISOString(),
          metadata: { charId: row.char_id, origin: "offline-push", scheduled: true },
          notification: {
            show: "always",
            title: row.char_name || "float",
            body: message.slice(0, 180),
            icon: "/icon-192.png",
            badge: "/icon-192.png",
            tag: `float-offline-${row.char_id}`,
          },
        }),
      });

      const today = new Date().toISOString().slice(0, 10);
      const sentToday = row.sent_day === today ? Number(row.sent_today || 0) + 1 : 1;
      await updateSchedule(row, {
        lease_until: null,
        last_error: null,
        fail_count: 0,
        last_sent_at: new Date().toISOString(),
        sent_day: today,
        sent_today: Math.min(sentToday, DAILY_LIMIT),
        next_fire_at: new Date(Date.now() + Number(row.interval_ms)).toISOString(),
        decision_state: { lastReason: "scheduled", lastMessageId: deterministicId },
      });
      await logDelivery(row, "dispatched", deterministicId, null, { elapsedMinutes });
      results.push({ charId: row.char_id, outcome: "dispatched" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = Number(error?.statusCode || error?.status || 0);
      const expired = status === 404 || status === 410 || /\b(404|410)\b/.test(message);
      const failCount = Number(row.fail_count || 0) + 1;
      const retryMs = Math.min(Number(row.max_interval_ms), Number(row.interval_ms) * Math.max(1, 2 ** Math.min(failCount, 5)));
      await updateSchedule(row, {
        lease_until: null,
        enabled: expired ? false : row.enabled,
        fail_count: failCount,
        last_error: message.slice(0, 500),
        next_fire_at: new Date(Date.now() + retryMs).toISOString(),
      });
      await logDelivery(row, expired ? "disabled" : "send_failed", deterministicId, message.slice(0, 120));
      console.error("[offline-push] scheduled delivery failed", row.char_id, message);
      results.push({ charId: row.char_id, outcome: expired ? "disabled" : "send_failed" });
    }
  }
  return { claimed: rows.length, results };
}
