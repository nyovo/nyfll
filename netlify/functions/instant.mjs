import { createInstantHandler } from "@rei-standard/amsg-instant";
import { toNetlifyHandler } from "@rei-standard/amsg-instant/adapters/netlify";

const required = (name) => {
  const value = Netlify.env.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

const instantHandler = createInstantHandler({
  vapid: {
    email: Netlify.env.get("VAPID_SUBJECT") || "mailto:admin@example.com",
    publicKey: required("VAPID_PUBLIC_KEY"),
    privateKey: required("VAPID_PRIVATE_KEY"),
  },
  clientToken: required("AMSG_CLIENT_TOKEN"),
  autoEmitReasoning: false,
});

export default toNetlifyHandler(instantHandler);

export const config = { path: "/api/v1/instant" };
