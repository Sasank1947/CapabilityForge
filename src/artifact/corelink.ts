import type { z } from "zod";
import { TargetDescriptor, type CapabilityArtifactInput, type Condition } from "./schema.js";

const NAV = ["nav"] as const;
const MAIN = ["main"] as const;

type TargetInput = z.input<typeof TargetDescriptor>;

function target(
  description: string,
  strategies: TargetInput["strategies"],
  framePath: readonly string[] = [],
): TargetInput {
  return { description, framePath: [...framePath], strategies };
}

const loginUser = target("Operator ID field", [
  { kind: "role", role: "textbox", name: "Operator ID:" },
  { kind: "label", labelText: "Operator ID:", relation: "right-of", controlRole: "textbox" },
  { kind: "css", selector: "input[name=fld1]" },
]);
const loginPassword = target("Password field", [
  { kind: "label", labelText: "Password:", relation: "right-of" },
  { kind: "css", selector: "input[name=fld2]" },
]);
const signOn = target("Sign On button", [
  { kind: "role", role: "button", name: "Sign On" },
  { kind: "css", selector: "input[type=submit]" },
]);
const memberInquiry = target(
  "Member Inquiry nav link",
  [
    { kind: "role", role: "link", name: "Member Inquiry" },
    { kind: "text", text: "Member Inquiry" },
  ],
  NAV,
);
const memberNumber = target(
  "Member Number search field",
  [
    { kind: "role", role: "textbox", name: "Member Number:" },
    { kind: "label", labelText: "Member Number:", relation: "right-of", controlRole: "textbox" },
    { kind: "css", selector: "input[name=fld1]" },
  ],
  MAIN,
);
const searchButton = target(
  "Search button",
  [
    { kind: "role", role: "button", name: "Search" },
    { kind: "css", selector: "input[type=submit]" },
  ],
  MAIN,
);
const memberLink = target(
  "Member result row link",
  [
    { kind: "role", role: "link", name: "{{memberId}}" },
    { kind: "text", text: "{{memberId}}" },
  ],
  MAIN,
);

const sessionExpiredDetect: Condition = {
  kind: "any",
  conditions: [
    { kind: "textPresent", text: "SESSION TIMED OUT" },
    { kind: "textPresent", text: "PLEASE SIGN ON AGAIN" },
  ],
};

const maintenanceDetect: Condition = { kind: "textPresent", text: "System maintenance tonight" };

const serverErrorDetect: Condition = {
  kind: "any",
  conditions: [
    { kind: "titleMatches", pattern: "^500" },
    { kind: "textPresent", text: "Internal Server Error" },
    { kind: "textPresent", text: "CLX-0500" },
  ],
};

const reloginSteps = [
  {
    id: "relogin-username",
    intent: "Re-enter operator username after session expiry",
    target: loginUser,
    action: { type: "type" as const, value: { kind: "secret" as const, name: "username" } },
    risk: "safe" as const,
    preconditions: [{ kind: "urlMatches" as const, pattern: "/login" }],
    timeoutMs: 10_000,
  },
  {
    id: "relogin-password",
    intent: "Re-enter operator password after session expiry",
    target: loginPassword,
    action: { type: "type" as const, value: { kind: "secret" as const, name: "password" } },
    risk: "safe" as const,
  },
  {
    id: "relogin-sign-on",
    intent: "Submit login after session expiry",
    target: signOn,
    action: { type: "click" as const },
    risk: "safe" as const,
    postcondition: { kind: "textPresent" as const, text: "Member Inquiry", framePath: [...NAV] },
  },
  {
    id: "relogin-inquiry",
    intent: "Return to member inquiry after re-login",
    target: memberInquiry,
    action: { type: "click" as const },
    risk: "safe" as const,
    postcondition: { kind: "textPresent" as const, text: "Member Number:", framePath: [...MAIN] },
  },
];

const sharedScreenStates = [
  {
    id: "sessionExpired",
    description: "Bounced back to login after an idle or injected session expiry",
    detect: sessionExpiredDetect,
    priority: 20,
    handler: {
      kind: "recover" as const,
      steps: reloginSteps,
      retry: { maxAttempts: 2, initialBackoffMs: 200, factor: 2 },
      resume: { mode: "restartFrom" as const, stepId: "enter-member" },
    },
  },
  {
    id: "maintenanceDialog",
    description: "System maintenance interstitial (surprise_dialog fault)",
    detect: maintenanceDetect,
    priority: 15,
    handler: {
      kind: "recover" as const,
      steps: [
        {
          id: "dismiss-maintenance",
          intent: "Acknowledge the maintenance notice",
          target: target("Acknowledge button", [
            { kind: "role", role: "button", name: "Acknowledge" },
            { kind: "css", selector: "input[type=submit]" },
          ], MAIN),
          action: { type: "click" as const },
          risk: "safe" as const,
        },
      ],
      retry: { maxAttempts: 2, initialBackoffMs: 150, factor: 2 },
      resume: { mode: "retryStep" as const },
    },
  },
  {
    id: "serverError",
    description: "Application 500 page",
    detect: serverErrorDetect,
    priority: 30,
    handler: { kind: "fail" as const, failureKind: "app_error" as const, message: "CoreLink returned a server error" },
  },
];

const provenance = {
  source: "hand-written" as const,
  recordedAt: "2026-10-11T20:00:00.000Z",
  recordedOnTenant: "a",
};

const app = {
  vendor: "CoreLink",
  product: "Teller",
  versionRange: ">=7.4 <8",
  surface: "legacy-web" as const,
  entryRoute: "/login",
  fingerprint: {
    titlePattern: "CoreLink Teller",
    versionText: "v7.4.2",
    landmarks: ["Member Inquiry", "OPERATOR SIGN ON"],
  },
};

const secrets = {
  username: { ref: "env://CORELINK_USER", description: "Teller operator id" },
  password: { ref: "env://CORELINK_PASSWORD", description: "Teller operator password" },
};

const loginAndSearchSteps = [
  { id: "open-login", intent: "Open the CoreLink sign-on page", action: { type: "navigate" as const, url: "/login" }, risk: "safe" as const },
  {
    id: "enter-username",
    intent: "Enter operator username",
    target: loginUser,
    action: { type: "type" as const, value: { kind: "secret" as const, name: "username" } },
    risk: "safe" as const,
  },
  {
    id: "enter-password",
    intent: "Enter operator password",
    target: loginPassword,
    action: { type: "type" as const, value: { kind: "secret" as const, name: "password" } },
    risk: "safe" as const,
  },
  {
    id: "sign-in",
    intent: "Submit login",
    target: signOn,
    action: { type: "click" as const },
    risk: "safe" as const,
    postcondition: { kind: "textPresent" as const, text: "Member Inquiry", framePath: [...NAV] },
    timeoutMs: 15_000,
  },
  {
    id: "open-inquiry",
    intent: "Open member inquiry from the nav frame",
    target: memberInquiry,
    action: { type: "click" as const },
    risk: "safe" as const,
    postcondition: { kind: "textPresent" as const, text: "Member Number:", framePath: [...MAIN] },
    timeoutMs: 15_000,
  },
  {
    id: "enter-member",
    intent: "Type the member number into search",
    target: memberNumber,
    action: { type: "type" as const, value: { kind: "input" as const, name: "memberId" } },
    risk: "safe" as const,
  },
  {
    id: "search",
    intent: "Run the member search",
    target: searchButton,
    action: { type: "click" as const },
    risk: "safe" as const,
    timeoutMs: 15_000,
  },
];

export const LOOKUP_MEMBER_BALANCE: CapabilityArtifactInput = {
  schemaVersion: "capabilityforge/v1",
  id: "corelink.lookup_member_balance",
  version: "1.0.0",
  status: "approved",
  title: "Look up member savings balance",
  description:
    "Signs on to CoreLink Teller, searches for a member by member number, opens the detail page and returns the Regular Savings (S01) balance. Returns MEMBER_NOT_FOUND when the search yields no record.",
  provenance,
  app,
  inputs: {
    memberId: {
      type: "string",
      description: "Five-digit member number",
      sensitivity: "pii",
      pattern: "^[0-9]{5}$",
      example: "12345",
    },
  },
  outputs: {
    savingsBalance: {
      type: "number",
      description: "Current Regular Savings (S01) balance in USD",
      sensitivity: "pii",
      extraction: {
        target: target(
          "Regular Savings balance cell",
          [
            { kind: "label", labelText: "REGULAR SAVINGS", relation: "right-of" },
            { kind: "label", labelText: "S01", relation: "same-row" },
          ],
          MAIN,
        ),
        read: "text",
        transforms: [{ kind: "trim" }, { kind: "parseNumber", allowCurrency: true }],
      },
    },
  },
  secrets,
  steps: [
    ...loginAndSearchSteps,
    {
      id: "open-member",
      intent: "Open the matching member row",
      target: memberLink,
      action: { type: "click" },
      risk: "safe",
      postcondition: { kind: "textPresent", text: "REGULAR SAVINGS", framePath: [...MAIN] },
      timeoutMs: 15_000,
    },
    { id: "read-balance", intent: "Read the Regular Savings balance", action: { type: "extract", outputs: ["savingsBalance"] }, risk: "safe" },
  ],
  screenStates: [
    {
      id: "memberNotFound",
      description: "Search returned no matching member",
      detect: { kind: "textPresent", text: "NO RECORD FOUND FOR MEMBER" },
      priority: 10,
      appliesTo: ["search", "open-member"],
      handler: { kind: "outcome", code: "MEMBER_NOT_FOUND", message: "No member with that number" },
    },
    ...sharedScreenStates,
  ],
  successCheckpoint: {
    description: "Member detail page showing Regular Savings is on screen",
    condition: {
      kind: "all",
      conditions: [
        { kind: "textPresent", text: "MEMBER DETAIL", framePath: [...MAIN] },
        { kind: "textPresent", text: "REGULAR SAVINGS", framePath: [...MAIN] },
      ],
    },
  },
};

export const OPEN_SUB_ACCOUNT: CapabilityArtifactInput = {
  schemaVersion: "capabilityforge/v1",
  id: "corelink.open_sub_account",
  version: "1.0.0",
  status: "approved",
  title: "Open a member sub-account",
  description:
    "Signs on to CoreLink Teller, opens a member, fills the open-sub-account form, reviews the posting and submits it. Submit is irreversible. Returns the confirmation number.",
  provenance,
  app,
  inputs: {
    memberId: {
      type: "string",
      description: "Five-digit member number",
      sensitivity: "pii",
      pattern: "^[0-9]{5}$",
      example: "12345",
    },
    accountType: {
      type: "string",
      description: "Sub-account type code",
      sensitivity: "internal",
      enum: ["S20", "S30", "S40", "D20"],
      example: "S20",
    },
    nickname: {
      type: "string",
      description: "Optional nickname (letters, digits, space, hyphen; max 20)",
      sensitivity: "internal",
      required: false,
      maxLength: 20,
      example: "XMAS FUND",
    },
    deposit: {
      type: "string",
      description: "Opening deposit amount, e.g. 100.00",
      sensitivity: "pii",
      pattern: "^\\d+(\\.\\d{1,2})?$",
      example: "100.00",
    },
    fromSuffix: {
      type: "string",
      description: "Funding account suffix",
      sensitivity: "internal",
      pattern: "^[A-Z][0-9]{2}$",
      example: "S01",
    },
  },
  outputs: {
    confirmationNumber: {
      type: "string",
      description: "Posted confirmation number",
      sensitivity: "internal",
      extraction: {
        target: target(
          "Confirmation number value",
          [{ kind: "label", labelText: "Confirmation Number:", relation: "right-of" }],
          MAIN,
        ),
        read: "text",
        transforms: [{ kind: "trim" }],
      },
    },
    newSuffix: {
      type: "string",
      description: "Suffix of the newly opened account",
      sensitivity: "internal",
      extraction: {
        target: target("New account cell", [{ kind: "label", labelText: "New Account:", relation: "right-of" }], MAIN),
        read: "text",
        transforms: [{ kind: "trim" }, { kind: "regex", pattern: "^([A-Z]\\d{2})", group: 1 }],
      },
    },
  },
  secrets,
  steps: [
    ...loginAndSearchSteps,
    {
      id: "open-member",
      intent: "Open the matching member row",
      target: memberLink,
      action: { type: "click" },
      risk: "safe",
      postcondition: { kind: "textPresent", text: "Open Sub-Account", framePath: [...MAIN] },
      timeoutMs: 15_000,
    },
    {
      id: "click-open-sub",
      intent: "Open the sub-account form",
      target: target(
        "Open Sub-Account button",
        [
          { kind: "role", role: "button", name: "Open Sub-Account" },
          { kind: "css", selector: "input[type=submit]" },
        ],
        MAIN,
      ),
      action: { type: "click" },
      risk: "safe",
      postcondition: { kind: "textPresent", text: "Initial Deposit:", framePath: [...MAIN] },
    },
    {
      id: "select-type",
      intent: "Choose the sub-account type",
      target: target(
        "Account Type select",
        [
          { kind: "label", labelText: "Account Type:", relation: "right-of", controlRole: "combobox" },
          { kind: "css", selector: "select[name=fld1]" },
        ],
        MAIN,
      ),
      action: { type: "select", value: { kind: "input", name: "accountType" } },
      risk: "safe",
    },
    {
      id: "enter-nickname",
      intent: "Enter an optional nickname",
      target: target(
        "Nickname field",
        [
          { kind: "label", labelText: "Nickname:", relation: "right-of", controlRole: "textbox" },
          { kind: "css", selector: "input[name=fld2]" },
        ],
        MAIN,
      ),
      action: { type: "type", value: { kind: "input", name: "nickname" } },
      risk: "safe",
    },
    {
      id: "enter-deposit",
      intent: "Enter the opening deposit",
      target: target(
        "Initial Deposit field",
        [
          { kind: "label", labelText: "Initial Deposit:", relation: "right-of", controlRole: "textbox" },
          { kind: "css", selector: "input[name=fld3]" },
        ],
        MAIN,
      ),
      action: { type: "type", value: { kind: "input", name: "deposit" } },
      risk: "safe",
    },
    {
      id: "select-from",
      intent: "Choose the funding account",
      target: target(
        "Transfer From select",
        [
          { kind: "label", labelText: "Transfer From:", relation: "right-of", controlRole: "combobox" },
          { kind: "css", selector: "select[name=fld4]" },
        ],
        MAIN,
      ),
      action: { type: "select", value: { kind: "input", name: "fromSuffix" } },
      risk: "safe",
    },
    {
      id: "continue-review",
      intent: "Continue to the irreversible review screen",
      target: target(
        "Continue button",
        [
          { kind: "role", role: "button", name: "Continue" },
          { kind: "css", selector: "input[type=submit]" },
        ],
        MAIN,
      ),
      action: { type: "click" },
      risk: "reversible",
      postcondition: { kind: "textPresent", text: "CANNOT BE REVERSED", framePath: [...MAIN] },
    },
    {
      id: "submit",
      intent: "Post the sub-account (irreversible)",
      target: target(
        "Submit button",
        [
          { kind: "role", role: "button", name: "Submit" },
          { kind: "css", selector: "input[name=btn][value=Submit]" },
        ],
        MAIN,
      ),
      action: { type: "click" },
      risk: "irreversible",
      postcondition: { kind: "textPresent", text: "TRANSACTION POSTED", framePath: [...MAIN] },
    },
    {
      id: "read-confirmation",
      intent: "Read the confirmation number and new suffix",
      action: { type: "extract", outputs: ["confirmationNumber", "newSuffix"] },
      risk: "safe",
    },
  ],
  screenStates: [
    {
      id: "memberNotFound",
      description: "Search returned no matching member",
      detect: { kind: "textPresent", text: "NO RECORD FOUND FOR MEMBER" },
      priority: 10,
      appliesTo: ["search", "open-member"],
      handler: { kind: "outcome", code: "MEMBER_NOT_FOUND", message: "No member with that number" },
    },
    ...sharedScreenStates,
  ],
  successCheckpoint: {
    description: "Posted confirmation is on screen",
    condition: {
      kind: "all",
      conditions: [
        { kind: "textPresent", text: "TRANSACTION POSTED", framePath: [...MAIN] },
        { kind: "textPresent", text: "Confirmation Number:", framePath: [...MAIN] },
      ],
    },
  },
};
