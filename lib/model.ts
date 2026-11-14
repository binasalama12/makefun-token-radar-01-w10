// Signal Deck — the token radar's model (w10 variant).
//
// One sealed snapshot in, one ranked board out. The board covers every slug on the
// snapshot's watchlist (the floor, never the ceiling) and adds the next 260
// rankable pre-token protocols by TVL — the fullest board this snapshot supports.
// NOTE on the count: the snapshot holds only 210 pre-token protocols below the
// $50M floor in total, and only 158 non-watchlist pre-token protocols pass the
// watchlist's own exclusions (no CEX, no versioned pool, no bridge / liquid
// staking / restaking product, no wrapped or staked product of a token that
// already trades, no exchange-named product). A 300-row board would need the
// wrapped, staked and exchange products the competition's own rules call out as
// not token launches — WBTC and Binance staked ETH would top it — so this board
// stops at 40 + 158 = 198 genuine pre-token rows instead of padding with them.
// Every row is scored by one function of the snapshot's own figures only;
// no protocol name is ever special-cased.
//
//   implied = round( TVL^0.85 x 2.5
//                    x (1 + clamp(change_7d, -60, 120) / 100 x 0.5)
//                    x (0.6 + 0.4 x min(age_days, 1095) / 1095) )
//
// TVL enters as a power law (exponent 0.85) so the range from $5M to billions does
// not swamp everything else; growth bends the value up or down by at most half;
// age is the time since DefiLlama first listed the protocol, the best record of
// how long it has run with no token on record. An unknown age counts as 365 days.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, stated in the dashboard so a reader can check every row. */
export interface ModelConstants {
  tvl_exponent: number;
  tvl_multiplier: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
}

export const MODEL: ModelConstants = {
  tvl_exponent: 0.85,
  tvl_multiplier: 2.5,
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
};

export const MODEL_VERSION = 'signal-deck-1';

/** Extra pre-token rows beyond the watchlist: the board is watchlist + this many. */
export const EXTRA_ROWS = 260;

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

export interface RadarRow extends BoardRow {}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  extra_size: number;
  rows: RadarRow[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

function finiteNum(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days from `listedAt` to `asOf`, clamped at zero; null when either is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

export interface Scored {
  implied: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  age: number | null;
}

/** The implied value of one protocol under the model, from the snapshot's figures only. */
export function impliedValue(p: SnapshotProtocol, asOf: string, model: ModelConstants = MODEL): Scored {
  const age = ageDays(asOf, p.listed_at);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, finiteNum(p.change_7d, 0)));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult =
    model.maturity_floor +
    (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const implied = Math.max(
    1,
    Math.round(Math.pow(p.tvl_usd, model.tvl_exponent) * model.tvl_multiplier * growthMult * maturityMult),
  );
  return { implied, growthPct, growthMult, maturityMult, age };
}

/** A protocol records no token at all on DefiLlama's record. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** Categories that are a wrapped, staked or bridged product of a token that trades. */
const WRAPPED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);
/** Exchange names a pre-token launch candidate never starts with. */
const EXCHANGE_NAMES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
/** Whole words that mark a wrapped or staked product. */
const WRAPPED_WORDS = /\b(wrapped|staked|staking)\b/i;

/**
 * Whether a protocol is one the board may rank: pre-token, and not a CEX, a
 * versioned pool, or a wrapped / staked / bridged product of a token that already
 * trades — the watchlist's own exclusions, applied to the extra rows too.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category === 'CEX') return false;
  if (VERSIONED.test(p.name)) return false;
  if (p.category !== null && WRAPPED_CATEGORIES.has(p.category)) return false;
  if (WRAPPED_WORDS.test(p.name)) return false;
  if (EXCHANGE_NAMES.some((e) => p.name.startsWith(e))) return false;
  return true;
}

function slugCmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

function firstChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** Position size for one farm, from the protocol's own TVL. */
function stakeFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 300;
  if (p.tvl_usd >= 1_000_000_000) return 200;
  if (p.tvl_usd >= 100_000_000) return 120;
  return 60;
}

/** How many days to keep the position live, from the protocol's age. */
function seasonDays(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 90;
  if (age < 365) return 60;
  return 45;
}

/** The category's core on-chain action, in words a farmer can follow. */
function coreAction(p: SnapshotProtocol, stake: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateralized')) {
    return `Lend $${stake} of USDC into ${n} on ${chain}, borrow a small amount against it, then repay the borrow so both sides of the position are on record.`;
  }
  if (c.includes('dex') || c.includes('leveraged farm')) {
    return `Add $${stake} of liquidity to ${n}'s deepest pool on ${chain} and leave the LP tokens staked in the pool's gauge if it has one.`;
  }
  if (c.includes('bridge') || c.includes('cross chain')) {
    return `Bridge $${stake} of USDC into ${chain} through ${n}, then put the bridged funds to work in one app on the destination chain.`;
  }
  if (c.includes('staking') || c.includes('restak') || c.includes('liquid')) {
    return `Stake $${stake} of the chain's native asset through ${n} on ${chain} and hold the receipt token in the same wallet.`;
  }
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) {
    return `Deposit $${stake} of USDC as margin on ${n} and open one small hedged trade, then close it after a day.`;
  }
  if (c.includes('prediction')) {
    return `Fund $${stake} on ${n} and take one small position in an active market, then settle it when the market resolves.`;
  }
  if (c.includes('yield') || c.includes('vault') || c.includes('curator') || c.includes('allocator')) {
    return `Deposit $${stake} into a ${n} vault on ${chain} and keep the vault shares in the wallet for the whole season.`;
  }
  if (c.includes('stable')) {
    return `Mint $${stake} of the stable asset through ${n} on ${chain} and hold it in the wallet that minted it.`;
  }
  if (c.includes('rwa')) {
    return `Buy $${stake} of ${n}'s yield-bearing asset on ${chain} and hold it through at least one yield distribution.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${stake} of cover from ${n} on ${chain} and keep the policy active for the whole season.`;
  }
  if (c.includes('farm')) {
    return `Deposit $${stake} into ${n}'s main farm on ${chain} and harvest the rewards once a week.`;
  }
  return `Deposit $${stake} of USDC into ${n} on ${chain} and use the app once a week so the wallet shows repeat activity.`;
}

function fitStep(s: string): string {
  let out = s;
  if (out.length > 600) out = `${out.slice(0, 596)}...`;
  if (out.length < 20) out = `${out} Keep the position open and check the protocol's own page before withdrawing.`;
  return out;
}

/**
 * A protocol's farm plan: six steps, each naming what it costs and how long it takes.
 * Every figure comes from the protocol's own record (category, chains, TVL, age);
 * no protocol name is ever special-cased.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = firstChain(p);
  const stake = stakeFor(p);
  const season = seasonDays(age);
  const chainList = p.chains.length > 1 ? p.chains.slice(0, 3).join(', ') : chain;
  const ageText = age === null ? 'an unlisted age' : `${age} days since listing`;
  return [
    fitStep(
      `Open a fresh wallet for ${p.name} only, fund it with $${stake + 10} on ${chain}, and write the seed phrase on paper kept offline. Cost: about $3 of gas for the funding transfer. Time: 10 minutes.`,
    ),
    fitStep(
      `${coreAction(p, stake, chain)} Cost: $${stake} of capital plus about $${stake >= 200 ? 10 : 5} of gas. Time: 20 minutes to set up.`,
    ),
    fitStep(
      `Return once a week and do one more qualifying action on ${p.name} — a swap, a deposit, a borrow or a vote — so the wallet shows activity across ${chainList}. Cost: about $2 of gas per week. Time: 15 minutes a week.`,
    ),
    fitStep(
      `Keep the position live for at least ${season} days (${ageText}) so the activity spans more than one snapshot window. Cost: the $${stake} stays locked in the position. Time: ${season} days.`,
    ),
    fitStep(
      `Before withdrawing anything, open ${p.name}'s own points or rewards page from the link the protocol itself publishes and check the wallet's standing. Cost: no fee to check, and never pay a fee to claim. Time: 10 minutes.`,
    ),
    fitStep(
      `Log the wallet address, the dates and every transaction hash in a farm notebook, then unwind the position in one transaction once the season ends. Cost: about $3 of gas to exit. Time: 10 minutes to close out.`,
    ),
  ];
}

/** The ranked board: watchlist first, then the next pre-token protocols by TVL. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other rankable pre-token protocol, by TVL, capped at
  // EXTRA_ROWS. The pool holds 158 protocols, so the cap never binds: the board is
  // watchlist + 158 = 198 rows, every one of them a genuine pre-token candidate.
  const extra = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p))
    .sort((a, b) => b.tvl_usd - a.tvl_usd || slugCmp(a.slug, b.slug))
    .slice(0, EXTRA_ROWS);
  for (const p of extra) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => ({ p, s: impliedValue(p, snapshot.as_of, model) }));
  scored.sort((a, b) => b.s.implied - a.s.implied || slugCmp(a.p.slug, b.p.slug));
  return scored.map((x, i) => ({
    rank: i + 1,
    slug: x.p.slug,
    name: x.p.name,
    category: x.p.category,
    chains: x.p.chains,
    tvl_usd: x.p.tvl_usd,
    change_7d: x.p.change_7d,
    mcap_usd: x.p.mcap_usd,
    listed_at: x.p.listed_at,
    gecko_id: x.p.gecko_id,
    symbol: x.p.symbol,
    token_status: 'pre-token' as const,
    age_days: x.s.age,
    implied_value_usd: x.s.implied,
    model: {
      growth_pct: x.s.growthPct,
      growth_multiplier: round4(x.s.growthMult),
      maturity_multiplier: round4(x.s.maturityMult),
      age_days: x.s.age,
    },
    farm_steps: farmSteps(x.p, x.s.age),
  }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    extra_size: board.filter((r) => !snapshot.watchlist.includes(r.slug)).length,
    rows: board,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) if (!known.has(r.slug)) return `${r.slug} is not a snapshot protocol`;
  if (slugs.size !== board.length) return 'the board repeats a slug';
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
