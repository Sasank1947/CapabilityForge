/** All data is synthetic and deterministic from the seed. SSNs are in the never-issued 9xx range. */

export interface Account {
  suffix: string;
  type: string;
  description: string;
  nickname?: string;
  balanceCents: number;
}

export interface Member {
  memberNumber: string;
  first: string;
  middle: string;
  last: string;
  ssn: string;
  status: "ACTIVE" | "DORMANT";
  branch: string;
  opened: string;
  accounts: Account[];
}

export const SUB_ACCOUNT_TYPES = [
  { code: "S20", label: "S20 - HOLIDAY CLUB", description: "HOLIDAY CLUB", minCents: 1 },
  { code: "S30", label: "S30 - VACATION CLUB", description: "VACATION CLUB", minCents: 1 },
  { code: "S40", label: "S40 - MONEY MARKET", description: "MONEY MARKET", minCents: 100_000 },
  { code: "D20", label: "D20 - SECONDARY CHECKING", description: "SECONDARY CHECKING", minCents: 1 },
] as const;

export type SubAccountTypeCode = (typeof SUB_ACCOUNT_TYPES)[number]["code"];

/** Share accounts hold a $5.00 par value that is never available. */
export const SHARE_PAR_CENTS = 500;

export function availableCents(acct: Account): number {
  return acct.suffix === "S00" ? Math.max(0, acct.balanceCents - SHARE_PAR_CENTS) : acct.balanceCents;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = [
  "ALEX", "JORDAN", "CASEY", "MORGAN", "TAYLOR", "RILEY", "QUINN", "AVERY", "PARKER", "ROWAN",
  "SAGE", "EMERSON", "HAYDEN", "REESE", "DAKOTA", "FINLEY", "KENDALL", "LOGAN", "MARLOWE", "SKYLER",
];
const LAST = [
  "ABERNATHY", "BRIGHTWATER", "CALLOWAY", "DUNMORE", "ELLSWORTH", "FAIRBANKS", "GALLOWAY", "HOLLOWAY",
  "IVERSON", "JANSSEN", "KILBRIDE", "LOCKHART", "MARCHETTI", "NORTHCOTT", "OKAFOR",
];
const MIDDLE = "ABCDEFGHJKLMNPRSTW";

function pick<T>(rng: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length)] as T;
}

function cents(rng: () => number, min: number, max: number): number {
  return Math.round((min + rng() * (max - min)) * 100);
}

function pad(n: number, w: number): string {
  return String(n).padStart(w, "0");
}

export const DEMO_MEMBER_NUMBER = "12345";

export function generateMembers(seed: number, count = 25): Member[] {
  const rng = mulberry32(seed);
  const members: Member[] = [
    {
      memberNumber: DEMO_MEMBER_NUMBER,
      first: "AVERY",
      middle: "J",
      last: "SAMPLE",
      ssn: "900-12-3456",
      status: "ACTIVE",
      branch: "004",
      opened: "03/14/2011",
      accounts: [
        { suffix: "S00", type: "SHARE", description: "PRIMARY SHARE", balanceCents: 2_500 },
        { suffix: "S01", type: "SAVINGS", description: "REGULAR SAVINGS", balanceCents: 152_075 },
        { suffix: "D10", type: "CHECKING", description: "SHARE DRAFT CHECKING", balanceCents: 84_210 },
      ],
    },
  ];
  for (let i = 0; i < count; i++) {
    const memberNumber = String(100001 + i);
    const ssn = `9${pad(Math.floor(rng() * 100), 2)}-${pad(10 + Math.floor(rng() * 90), 2)}-${pad(Math.floor(rng() * 10000), 4)}`;
    const dormant = i > 1 && rng() < 0.12;
    members.push({
      memberNumber,
      first: pick(rng, FIRST),
      middle: pick(rng, MIDDLE.split("")),
      last: pick(rng, LAST),
      ssn,
      status: dormant ? "DORMANT" : "ACTIVE",
      branch: pick(rng, ["001", "004", "007", "012"]),
      opened: `${pad(1 + Math.floor(rng() * 12), 2)}/${pad(1 + Math.floor(rng() * 28), 2)}/${1998 + Math.floor(rng() * 26)}`,
      accounts: [
        { suffix: "S00", type: "SHARE", description: "PRIMARY SHARE", balanceCents: cents(rng, 5, 30) },
        { suffix: "S01", type: "SAVINGS", description: "REGULAR SAVINGS", balanceCents: cents(rng, 50, 25_000) },
        { suffix: "D10", type: "CHECKING", description: "SHARE DRAFT CHECKING", balanceCents: cents(rng, 0, 6_000) },
      ],
    });
  }
  return members;
}

export function fmtMoney(c: number): string {
  const neg = c < 0;
  const abs = Math.abs(c);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  return `${neg ? "-" : ""}$${dollars}.${pad(abs % 100, 2)}`;
}

export function maskSsn(ssn: string): string {
  return `***-**-${ssn.slice(-4)}`;
}

export function fullName(m: Member): string {
  return `${m.first} ${m.middle} ${m.last}`;
}
