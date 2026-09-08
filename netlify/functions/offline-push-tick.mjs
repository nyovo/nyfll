import { processDueSchedules } from "./_shared/offline-push-server.mjs";

export default async () => {
  const result = await processDueSchedules(1);
  console.log("[offline-push] tick complete", result);
};

export const config = { schedule: "* * * * *" };
