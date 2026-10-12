import { describe, expect, it } from "vitest";
import { luhnValid, Redactor } from "../src/policy/redact.js";

const r = new Redactor();

describe("detectors", () => {
  it("masks formatted SSNs including the synthetic 9xx range", () => {
    expect(r.redactString("SSN 900-12-3456 on file")).toMatch(/^SSN \[PII:ssn#[0-9a-f]{4}\] on file$/);
    expect(r.redactString("ssn: 987 65 4321")).not.toContain("4321");
  });

  it("masks unformatted SSNs only with a context word", () => {
    expect(r.redactString("Social Security Number: 900123456")).not.toContain("900123456");
    expect(r.redactString("ref 900123456")).toContain("900123456");
  });

  it("masks app-masked SSNs (last 4 is still partial PII)", () => {
    expect(r.redactString("***-**-3456")).toMatch(/^\[PII:ssn\.last4#[0-9a-f]{4}\]$/);
  });

  it("masks Luhn-valid card numbers and leaves Luhn-invalid digit runs alone", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
    expect(r.redactString("card 4111 1111 1111 1111 ok")).toMatch(/\[PII:card#/);
    expect(r.redactString("ref 4111-1111-1111-1112")).toBe("ref 4111-1111-1111-1112");
    expect(r.redactString("5500005555555559")).toMatch(/^\[PII:card#/);
  });

  it("masks account and member numbers that appear with a context word", () => {
    expect(r.redactString("Member #: 12345 Jane")).toMatch(/^Member #: \[PII:account#[0-9a-f]{4}\] Jane$/);
    expect(r.redactString("acct 0012-3456789")).not.toMatch(/3456789/);
    expect(r.redactString("Account Type: S00")).toBe("Account Type: S00");
    expect(r.redactString("balance 12345.67")).toBe("balance 12345.67");
  });

  it("masks emails and US phone numbers", () => {
    expect(r.redactString("mail jane.doe+cu@example.org now")).toMatch(/^mail \[PII:email#[0-9a-f]{4}\] now$/);
    for (const p of ["(555) 123-4567", "555-123-4567", "+1 555.123.4567"]) {
      expect(r.redactString(`call ${p}`), p).toMatch(/^call \[PII:phone#/);
    }
  });

  it("masks bearer tokens, API keys and credential key=value pairs", () => {
    expect(r.redactString("Authorization: Bearer abc.DEF-123_xyz")).not.toContain("abc.DEF-123_xyz");
    expect(r.redactString("key sk-proj-AbCdEfGhIjKlMnOpQrSt1234")).toBe("key [SECRET]");
    expect(r.redactString("fld1=teller1&password=hunter22&x=1")).toBe("fld1=teller1&password=[SECRET]&x=1");
    expect(r.redactString('{"api_key":"zzz-123456"}')).toBe('{"api_key":"[SECRET]"}');
    expect(r.redactString("Cookie: CLSESSID=deadbeef1234")).not.toContain("deadbeef1234");
    expect(r.redactString("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl")).toBe("jwt [SECRET]");
  });

  it("does not touch ordinary log content", () => {
    const s = "2026-10-11T18:51:00.000Z clicked Search at http://127.0.0.1:53123/search (step 3 of 5), balance $1,234.56";
    expect(r.redactString(s)).toBe(s);
  });
});

describe("exact-value scrubbing from sensitivity tags", () => {
  const artifact = {
    inputs: {
      memberId: { sensitivity: "pii" as const },
      lastName: { sensitivity: "pii" as const },
      branch: { sensitivity: "public" as const },
    },
    outputs: { ssn: { sensitivity: "pii" as const }, savingsBalance: { sensitivity: "internal" as const } },
    secrets: { operatorPassword: {} },
  };

  const red = () =>
    Redactor.forRun(artifact as never, {
      inputs: { memberId: "12345", lastName: "Okonkwo", branch: "004" },
      secrets: { operatorPassword: "Tr0ub4dor&3" },
    }).addValue("900-55-1234", "pii", "ssn");

  it("scrubs registered values in free text, URLs and encoded bodies", () => {
    const x = red();
    expect(x.redactString("GET /member?m=12345")).toMatch(/^GET \/member\?m=\[PII:memberId#[0-9a-f]{4}\]$/);
    expect(x.redactString("Member OKONKWO, J.")).toMatch(/^Member \[PII:lastName#/);
    expect(x.redactString("fld2=Tr0ub4dor%263")).toBe("fld2=[SECRET]");
    expect(x.redactString("pw Tr0ub4dor&3!")).toBe("pw [SECRET]!");
    expect(x.redactString("branch 004")).toBe("branch 004");
    // Not a different number that merely contains the value.
    expect(x.redactString("m=112345")).toBe("m=112345");
  });

  it("scrubs digit-separator variants and the last 4", () => {
    const x = red();
    expect(x.redactString("900551234")).toMatch(/^\[PII:ssn#/);
    expect(x.redactString("SSN ending 1234")).toMatch(/^SSN ending \[PII:ssn\.last4#/);
  });

  it("produces stable, correlatable masks", () => {
    const x = red();
    const a = x.redactString("m=12345");
    expect(x.redactString("member 12345")).toContain(a.slice(2));
    expect(new Redactor({ values: [{ value: "12345", sensitivity: "pii", label: "memberId" }] }).redactString("12345")).toBe(a.slice(2));
    expect(new Redactor({ hashKey: "other" }).mask("pii", "memberId", "12345")).not.toBe(a.slice(2));
  });

  it("is idempotent", () => {
    const x = red();
    const once = x.redactString("member 12345 ssn 900-55-1234 mail a@b.co pw Tr0ub4dor&3");
    expect(x.redactString(once)).toBe(once);
  });

  it("exposes raw values for screenshot masking", () => {
    expect(red().screenshotMaskValues()).toEqual(expect.arrayContaining(["12345", "Okonkwo", "Tr0ub4dor&3", "900-55-1234", "1234"]));
  });
});

describe("deep redaction", () => {
  const SENSITIVE = ["12345", "Okonkwo", "Tr0ub4dor&3", "900-55-1234", "4111111111111111", "jane@example.org", "sk-live-0123456789abcdefXYZ", "S3cr3t!pass"];

  it("redacts nested keys and values and no raw value survives JSON serialization", () => {
    const x = Redactor.forRun(
      { inputs: { memberId: { sensitivity: "pii" }, lastName: { sensitivity: "pii" } }, outputs: {}, secrets: { pw: {} } } as never,
      { inputs: { memberId: "12345", lastName: "Okonkwo" }, secrets: { pw: "Tr0ub4dor&3" } },
    );
    const payload = {
      inputs: { memberId: "12345", lastName: "Okonkwo" },
      action: { type: "type", ref: "e7", text: "Tr0ub4dor&3", clear: true, sensitive: true },
      typedPin: { type: "type", ref: "e8", text: "S3cr3t!pass", clear: true, sensitive: true },
      observation: { textByFrame: { main: "Member 12345 OKONKWO SSN 900-55-1234 card 4111111111111111" } },
      byMember: { "12345": { email: "jane@example.org" } },
      headers: { Authorization: "Bearer sk-live-0123456789abcdefXYZ", accept: "text/html" },
      nested: [{ deep: [{ password: "S3cr3t!pass" }] }],
      error: new Error("lookup failed for member 12345"),
      when: new Date("2026-10-11T00:00:00Z"),
      blob: Buffer.from("raw"),
      skip: undefined,
      fn: () => 1,
      count: 3,
      ok: true,
    };
    const out = x.redact(payload);
    const json = JSON.stringify(out);
    for (const s of SENSITIVE) expect(json, s).not.toContain(s);

    expect(out.inputs).toEqual({ memberId: expect.stringMatching(/^\[PII:memberId#/), lastName: expect.stringMatching(/^\[PII:lastName#/) });
    expect((out.action as Record<string, unknown>).text).toBe("[SECRET]");
    expect((out.typedPin as Record<string, unknown>).text).toBe("[SECRET]");
    expect((out.action as Record<string, unknown>).ref).toBe("e7");
    expect(Object.keys(out.byMember as object)[0]).toMatch(/^\[PII:memberId#/);
    expect((out.headers as Record<string, unknown>).accept).toBe("text/html");
    expect(out.when).toBe("2026-10-11T00:00:00.000Z");
    expect(out.blob).toBe("[binary 3 bytes]");
    expect("skip" in out || "fn" in out).toBe(false);
    expect(out.count).toBe(3);
    expect(out.ok).toBe(true);
  });

  it("masks a sensitive action's literal with its pii label when it is a registered value", () => {
    const x = new Redactor({ values: [{ value: "12345", sensitivity: "pii", label: "memberId" }] });
    const out = x.redact({ type: "type", ref: "e1", text: "12345", clear: true, sensitive: true });
    expect(out.text).toMatch(/^\[PII:memberId#/);
  });

  it("masks numbers under pii keys and registered numeric values", () => {
    const x = new Redactor({ fields: { memberId: { sensitivity: "pii" } }, values: [{ value: 12345, sensitivity: "pii", label: "memberId" }] });
    const out = x.redact({ memberId: 99999, other: 12345, balance: 12345.67 });
    expect(out.memberId).toMatch(/^\[PII:memberId#/);
    expect(out.other).toMatch(/^\[PII:memberId#/);
    expect(out.balance).toBe(12345.67);
  });

  it("handles cycles and wraps non-object payloads", () => {
    const a: Record<string, unknown> = { name: "x" };
    a.self = a;
    expect(r.redact(a)).toEqual({ name: "x", self: "[Circular]" });
    expect(r.redact(["900-12-3456"] as never)).toEqual({ value: [expect.stringMatching(/^\[PII:ssn#/)] });
  });

  it("masks whole subtrees under secret keys", () => {
    const out = r.redact({ credentials: { user: "teller1", pass: "x" }, sessionId: 42 });
    expect(out).toEqual({ credentials: "[SECRET]", sessionId: "[SECRET]" });
  });
});
