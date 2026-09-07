import { build } from "esbuild";

await build({
  entryPoints: ["lib/offline-push/sw-entry.mjs"],
  outfile: "public/offline-push-sw.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  minify: true,
  legalComments: "linked",
});

console.log("[offline-push] built public/offline-push-sw.js");
