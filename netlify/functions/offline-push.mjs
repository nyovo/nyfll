import { handleOfflinePushRequest } from "./_shared/offline-push-server.mjs";

export default handleOfflinePushRequest;

export const config = {
  path: "/api/v1/offline-push",
  rateLimit: { windowSize: 60, windowLimit: 30, aggregateBy: ["ip"] },
};
