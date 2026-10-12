import { startCoreLink } from "./server.js";

const port = Number(process.env.CORELINK_PORT) || 4100;
const tenant = process.env.CORELINK_TENANT === "b" ? "b" : "a";
const seed = process.env.CORELINK_SEED ? Number(process.env.CORELINK_SEED) : undefined;

const handle = await startCoreLink({ port, tenant, seed });
console.log(`CoreLink mock (tenant ${tenant}) listening at ${handle.url}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void handle.close().then(() => process.exit(0));
  });
}
