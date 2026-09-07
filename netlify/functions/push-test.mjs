import { sendWebPush } from "@rei-standard/amsg-instant";

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

export default async (request) => {
  if (request.method !== "POST") return json(405, { error: "METHOD_NOT_ALLOWED" });
  const expected = Netlify.env.get("AMSG_CLIENT_TOKEN");
  if (!expected || request.headers.get("X-Client-Token") !== expected) {
    return json(401, { error: "UNAUTHORIZED" });
  }
  const body = await request.json().catch(() => null);
  if (!body?.subscription?.endpoint || !body?.subscription?.keys?.p256dh || !body?.subscription?.keys?.auth) {
    return json(400, { error: "INVALID_SUBSCRIPTION" });
  }
  const messageId = crypto.randomUUID();
  await sendWebPush({
    subscription: body.subscription,
    vapid: {
      email: Netlify.env.get("VAPID_SUBJECT") || "mailto:admin@example.com",
      publicKey: Netlify.env.get("VAPID_PUBLIC_KEY"),
      privateKey: Netlify.env.get("VAPID_PRIVATE_KEY"),
    },
    payload: {
      messageKind: "content",
      messageType: "instant",
      source: "instant",
      messageSubtype: "float.offline.test",
      messageId,
      sessionId: `test_${messageId}`,
      message: "离线推送测试成功",
      sentAt: new Date().toISOString(),
      metadata: { charId: "__offline_push_test__", origin: "offline-push", test: true },
      notification: {
        show: "always",
        title: "float",
        body: "离线推送测试成功",
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        tag: "float-offline-test",
      },
    },
  });
  return json(200, { ok: true, messageId });
};

export const config = { path: "/api/v1/push-test" };
