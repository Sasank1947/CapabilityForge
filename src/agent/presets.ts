import type { FieldType, InputField, Sensitivity } from "../artifact/schema.js";
import type { DiscoveryGoal, OutputDecl } from "./types.js";

export const LOOKUP_BALANCE_GOAL: DiscoveryGoal = {
  id: "corelink.lookup_member_balance",
  title: "Look up member savings balance",
  description:
    "Signs on to CoreLink Teller, searches for a member by member number, opens the detail page and returns the Regular Savings (S01) balance.",
  instruction:
    "Sign on to CoreLink Teller, open Member Inquiry from the nav frame, type the declared memberId, click Search, then click the member-number link in the results table (the frameset URL may stay '/'). On the member detail page extract the Regular Savings (S01) balance as savingsBalance. Evidence of success is visible text such as MEMBER DETAIL or REGULAR SAVINGS. Do not request_human after a single unchanged click — wait for the new snapshot and click the result row.",
  inputs: {
    memberId: {
      type: "string",
      description: "Five-digit member number",
      sensitivity: "pii",
      required: true,
      pattern: "^[0-9]{5}$",
      example: "12345",
    },
  },
  outputs: {
    savingsBalance: {
      type: "number",
      description: "Current Regular Savings (S01) balance in USD",
      sensitivity: "pii",
    },
  },
  secrets: {
    username: { ref: "env://CORELINK_USER", description: "Teller operator id" },
    password: { ref: "env://CORELINK_PASSWORD", description: "Teller operator password" },
  },
  app: {
    vendor: "CoreLink",
    product: "Teller",
    versionRange: ">=7.4 <8",
    surface: "legacy-web",
    entryRoute: "/login",
    fingerprint: {
      titlePattern: "CoreLink Teller",
      versionText: "v7.4.2",
      landmarks: ["Member Inquiry", "OPERATOR SIGN ON"],
    },
  },
  version: "0.1.0",
};

export interface FieldSpec {
  name: string;
  type: FieldType;
  sensitivity: Sensitivity;
  description: string;
}

const FIELD_TYPES = new Set<FieldType>(["string", "integer", "number", "boolean"]);
const SENSITIVITIES = new Set<Sensitivity>(["public", "internal", "pii", "secret"]);

/** Parse `name:type:sensitivity[:description]`. */
export function parseFieldSpec(spec: string): FieldSpec {
  const parts = spec.split(":");
  const name = parts[0]?.trim() ?? "";
  const type = parts[1]?.trim() as FieldType;
  const sensitivity = parts[2]?.trim() as Sensitivity;
  const description = parts.slice(3).join(":").trim() || name;
  if (!name) throw new Error(`invalid field spec '${spec}': missing name`);
  if (!FIELD_TYPES.has(type)) throw new Error(`invalid field spec '${spec}': type must be string|integer|number|boolean`);
  if (!SENSITIVITIES.has(sensitivity)) throw new Error(`invalid field spec '${spec}': sensitivity must be public|internal|pii|secret`);
  return { name, type, sensitivity, description };
}

export function specToInput(spec: FieldSpec): InputField {
  return { type: spec.type, description: spec.description, sensitivity: spec.sensitivity, required: true };
}

export function specToOutput(spec: FieldSpec): OutputDecl {
  return { type: spec.type, description: spec.description, sensitivity: spec.sensitivity };
}

export function goalFromPreset(name: string): DiscoveryGoal {
  if (name === "lookup-balance" || name === "lookup_member_balance" || name === "corelink.lookup_member_balance") {
    return structuredClone(LOOKUP_BALANCE_GOAL);
  }
  throw new Error(`unknown discover preset '${name}' (known: lookup-balance)`);
}
