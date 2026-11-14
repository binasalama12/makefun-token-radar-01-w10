# Signal Deck — a token launch radar

A pre-token protocol board: 198 protocols ranked by an implied token value, each
with a six-step farm plan. Built for the make.fun token-radar-01 bounty.

## What it does

The program reads the sealed DefiLlama snapshot (`snapshot.json`, 758 protocols,
as of 2026-11-14) and scores every protocol on the snapshot's 40-protocol
watchlist plus the next 158 rankable pre-token protocols by TVL — a 198-row board,
the fullest board of genuine pre-token candidates this snapshot supports. Only
210 pre-token protocols exist below the $50M floor at all, and only 158
non-watchlist ones pass the watchlist's own exclusions (no CEX, no versioned pool,
no bridge / liquid staking / restaking product, no wrapped or staked product of a
token that already trades); a 300-row board would need WBTC, Binance staked ETH
and the exchanges at the top, which the competition's own rules call out as not
token launches. Live-token protocols are never ranked.

Implied value follows from the snapshot's own figures only:

```
implied = round( TVL^0.85 x 2.5
                 x (1 + clamp(change_7d, -60, 120) / 100 x 0.5)
                 x (0.6 + 0.4 x min(age_days, 1095) / 1095) )
```

TVL enters as a power law (exponent 0.85) so the range from $5M to billions does
not swamp the board; seven-day growth bends the value by at most half; age is the
time since DefiLlama first listed the protocol, the best record of how long it has
run with no token on record (an unlisted age counts as 365 days). No protocol name
is ever special-cased.

Each row carries six farm steps derived from the protocol's category, chains, TVL
and age, each naming what it costs and how long it takes.

## The dashboard

`dashboard/` is a static page (no network): a dense sortable table with rank
badges, a sticky header, text and category filters, a "Top 50 only" toggle, and a
detail view per protocol with the model's inputs and its farm plan. Views come
from the URL: `?view=board`, `?view=detail&slug=<slug>`,
`?view=filtered&f=<text>`.

## How to run it

Requires Node.js 22.18 or later, nothing to install.

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

The run writes `out/board.json` (the ranked board), `out/data.js` (the
dashboard's data), `out/dashboard/` and `out/screenshots/`, and `out/dossier.json`
last. The run is deterministic: two runs write identical bytes.

## Layout

- `main.ts` — entrypoint: reads the snapshot, writes the outputs, dossier last.
- `lib/model.ts` — the model: snapshot parsing, implied value, farm steps, board.
- `vendor/makefun-board.ts` — make.fun's dossier library (copied from the kit).
- `dashboard/` — the static page: `index.html`, `app.css`, `app.js`.
- `screenshots/` — three screenshots of the dashboard: board, detail, filtered.
