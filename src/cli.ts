import "dotenv/config";
import { Command } from "commander";
import { artifactJsonSchema, tenantOverlayJsonSchema } from "./artifact/schema.js";

function notImplemented(name: string): () => void {
  return () => {
    console.error(`forge ${name}: not implemented yet`);
    process.exitCode = 2;
  };
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name("forge")
    .description("CapabilityForge: discover UI flows with an LLM, compile them into capability artifacts, replay them deterministically.")
    .version("0.1.0");

  program
    .command("app")
    .description("Serve the CoreLink Teller mock app (hostile legacy core-banking UI)")
    .action(notImplemented("app"));

  program
    .command("discover")
    .description("Run the LLM discovery agent on a goal and compile the run into a capability artifact")
    .action(notImplemented("discover"));

  program
    .command("replay")
    .description("Replay a capability artifact deterministically with input parameters")
    .action(notImplemented("replay"));

  program
    .command("operator")
    .description("Start the operator console for human interventions")
    .action(notImplemented("operator"));

  program
    .command("serve-mcp")
    .description("Expose approved capability artifacts as typed MCP tools")
    .action(notImplemented("serve-mcp"));

  program
    .command("schema")
    .description("Print the JSON Schema of the capability artifact (or tenant overlay) format")
    .option("--overlay", "print the tenant overlay schema instead")
    .action((opts: { overlay?: boolean }) => {
      const schema = opts.overlay ? tenantOverlayJsonSchema() : artifactJsonSchema();
      process.stdout.write(`${JSON.stringify(schema, null, 2)}\n`);
    });

  return program;
}

await buildProgram().parseAsync(process.argv);
