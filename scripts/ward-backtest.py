#!/usr/bin/env python3
"""
Retrospective profitability backtest of ProfessorCEWard's 446 TradingView ideas.

For each DIRECTIONAL idea (direction 1=long / 2=short; skip 0=neutral) with
parseable entry/SL/TP levels, walk DAILY price forward from the publish date
and determine which level price reached first → win (TP) / loss (SL) /
ambiguous (both inside one day's range — can't order without intraday data) /
open (neither hit within the window) / unparseable (no clean levels).

Honest limitations baked in + reported:
  - Daily candles only (Yahoo doesn't serve years-old intraday FX). Intraday
    scalp setups whose TP+SL both sit inside a single day get flagged
    AMBIGUOUS, not guessed.
  - Tests "if you mechanically took every published level" — NOT Ward's live
    discretionary timing.
  - Level parser is conservative: ideas it can't confidently parse are counted
    as UNPARSEABLE and excluded from win-rate (reported separately).

Outputs:
  ~/CornyWardTradingView/_Profitability Backtest.md   (summary)
  ~/CornyWardTradingView/_backtest_per_idea.csv        (every idea's verdict)
"""
import json, re, os, sys, time, csv, datetime
from collections import defaultdict

IDEAS = os.path.expanduser("~/CornyWardTradingView/ideas_real/_all_ideas_raw.json")
OUT_MD = os.path.expanduser("~/CornyWardTradingView/_Profitability Backtest.md")
OUT_CSV = os.path.expanduser("~/CornyWardTradingView/_backtest_per_idea.csv")
WINDOW_DAYS = 45   # how long after publish we wait for TP/SL

import yfinance as yf
import warnings; warnings.filterwarnings("ignore")

# ── TradingView short_name → Yahoo ticker ────────────────────────────────
def yahoo_ticker(short, typ):
    s = (short or "").upper().replace("OANDA:", "").replace(".P", "")
    fxset = {"EUR","USD","GBP","JPY","AUD","NZD","CAD","CHF","ZAR","DKK","NOK","SEK","SGD","MXN","TRY","HKD"}
    # explicit maps first
    m = {
        "XAUUSD":"GC=F","GOLD":"GC=F","XAGUSD":"SI=F","SILVER":"SI=F",
        "USOIL":"CL=F","WTI":"CL=F","UKOIL":"BZ=F","NGAS":"NG=F",
        "SPX":"^GSPC","SPX500":"^GSPC","SPX500USD":"^GSPC","US500":"^GSPC",
        "NAS100":"^NDX","NAS100USD":"^NDX","US100":"^NDX","NDX":"^NDX",
        "US30":"^DJI","DJI":"^DJI","NIFTY":"^NSEI","DXY":"DX-Y.NYB",
        "GER40":"^GDAXI","DAX":"^GDAXI","UK100":"^FTSE","JP225":"^N225",
    }
    if s in m: return m[s]
    # crypto
    for c in ["BTC","ETH","ZEC","XRP","SOL","DOGE","ADA","BNB","LTC"]:
        if s.startswith(c) and ("USD" in s or "USDT" in s):
            return f"{c}-USD"
    # forex 6-letter
    if len(s) == 6 and s[:3] in fxset and s[3:] in fxset:
        return f"{s}=X"
    # plain stock ticker
    if re.fullmatch(r"[A-Z]{1,5}", s):
        return s
    return None

# ── parse entry / SL / TP from the idea body ─────────────────────────────
# Ward's ideas put the PRICE FIRST then a descriptor, usually as bullets:
#   "• 1.62500 — TP (bounce fade)"
#   "0.80347 — Buy limit order (1H)"
#   "1.62700 — Sell Stop/Invalidation (overhead pivot)"
# We classify each (price, descriptor) line into entry / sl / tp candidates,
# then pick direction-aware. We ALSO handle the legacy "Label: price" order.
NUM = r'\d+(?:\.\d+)?'

def _classify(desc):
    """Map a level descriptor → 'entry' | 'sl' | 'tp' | None."""
    d = desc.lower()
    if re.search(r'invalidat|stop[- ]?loss|\bsl\b|protective|guardrail', d): return "sl"
    if re.search(r'take[- ]?profit|\btp\d?\b|target|profit magnet|objective|exhaust', d): return "tp"
    if re.search(r'buy limit|sell limit|buy stop|sell stop|\bentry\b|\benter\b|buy zone|demand 1|reload', d): return "entry"
    # bare "Buy"/"Sell" without limit/stop → entry
    if re.search(r'\bbuy\b|\bsell\b', d): return "entry"
    return None

def parse_levels(body, direction):
    """Return (entry, sl, tp) or None. Handles Ward's price-first bullet format."""
    text = body.replace(",", "")
    entries, sls, tps = [], [], []

    # Pattern A: price first, then descriptor (his dominant format)
    for m in re.finditer(r'(' + NUM + r')\s*[—\-–:]+\s*([^\n•]{2,60})', text):
        try: price = float(m.group(1))
        except: continue
        kind = _classify(m.group(2))
        if   kind == "sl": sls.append(price)
        elif kind == "tp": tps.append(price)
        elif kind == "entry": entries.append(price)

    # Pattern B: descriptor first, then price (legacy)
    def after(label_re, dst):
        for m in re.finditer(label_re + r'[^0-9\n]{0,18}(' + NUM + r')', text, re.I):
            try: dst.append(float(m.group(1)))
            except: pass
    after(r'\b(?:SL|stop[- ]?loss|invalidat\w*|protective)\b', sls)
    after(r'\b(?:TP\d?|take[- ]?profit|target)\b', tps)
    after(r'\b(?:entry|buy[- ]?stop|sell[- ]?stop|buy[- ]?limit|sell[- ]?limit)\b', entries)

    entries = sorted(set(entries)); sls = sorted(set(sls)); tps = sorted(set(tps))
    if not (entries and sls and tps):
        return None

    # Direction-aware selection. Use the median price of all parsed levels as
    # a reference "current price" so we pick a sensible entry.
    alllv = sorted(entries + sls + tps)
    ref = alllv[len(alllv)//2]

    if direction == 1:   # LONG: entry≈ref, SL below, TP above
        ent_c = [e for e in entries if e <= ref*1.01] or entries
        entry = min(ent_c, key=lambda x: abs(x-ref))
        sl_c = [s for s in sls if s < entry]
        tp_c = [t for t in tps if t > entry]
        if not (sl_c and tp_c): return None
        sl = max(sl_c); tp = min(tp_c)
        if not (sl < entry < tp): return None
    elif direction == 2: # SHORT: entry≈ref, SL above, TP below
        ent_c = [e for e in entries if e >= ref*0.99] or entries
        entry = min(ent_c, key=lambda x: abs(x-ref))
        sl_c = [s for s in sls if s > entry]
        tp_c = [t for t in tps if t < entry]
        if not (sl_c and tp_c): return None
        sl = min(sl_c); tp = max(tp_c)
        if not (tp < entry < sl): return None
    else:
        return None

    # Sanity: SL and TP within ±15% of entry (reject mis-parses / wrong-scale numbers)
    for lv in (sl, tp):
        if entry and abs(lv-entry)/entry > 0.15: return None
    return (entry, sl, tp)

# ── price cache ──────────────────────────────────────────────────────────
_cache = {}
def get_prices(ticker, start, end):
    key = (ticker, start, end)
    if key in _cache: return _cache[key]
    try:
        df = yf.download(ticker, start=start, end=end, interval="1d",
                         progress=False, auto_adjust=False)
        _cache[key] = df
        return df
    except Exception:
        _cache[key] = None
        return None

def simulate(direction, entry, sl, tp, df):
    """Walk daily candles. Return verdict + R."""
    if df is None or len(df) == 0:
        return ("no_price", None)
    R = abs(tp-entry)/abs(entry-sl) if abs(entry-sl) > 0 else None
    for _, row in df.iterrows():
        hi = float(row["High"]); lo = float(row["Low"])
        if direction == 1:   # long
            hit_tp = hi >= tp; hit_sl = lo <= sl
        else:                # short
            hit_tp = lo <= tp; hit_sl = hi >= sl
        if hit_tp and hit_sl:
            return ("ambiguous", R)   # both in same day's range
        if hit_tp: return ("win", R)
        if hit_sl: return ("loss", R)
    return ("open", R)

# ── main ─────────────────────────────────────────────────────────────────
ideas = json.load(open(IDEAS))
rows = []
print(f"Processing {len(ideas)} ideas...", file=sys.stderr)
for i, it in enumerate(ideas, 1):
    s = it.get("symbol") or {}
    short = s.get("short_name") if isinstance(s, dict) else None
    typ   = s.get("type") if isinstance(s, dict) else None
    direction = s.get("direction") if isinstance(s, dict) else 0
    ts = it.get("date_timestamp")
    name = it.get("name","")
    rec = {"id": it.get("id"), "name": name, "symbol": short, "type": typ,
           "direction": {1:"long",2:"short",0:"neutral"}.get(direction,"?"),
           "date":"", "entry":"", "sl":"", "tp":"", "R":"", "verdict":""}
    if not ts:
        rec["verdict"] = "no_date"; rows.append(rec); continue
    d = datetime.date.fromtimestamp(ts)
    rec["date"] = d.isoformat()
    if direction not in (1,2):
        rec["verdict"] = "neutral_skip"; rows.append(rec); continue
    lv = parse_levels(it.get("description",""), direction)
    if not lv:
        rec["verdict"] = "unparseable"; rows.append(rec); continue
    entry, sl, tp = lv
    rec.update(entry=entry, sl=sl, tp=tp)
    tk = yahoo_ticker(short, typ)
    if not tk:
        rec["verdict"] = "no_ticker"; rows.append(rec); continue
    start = d.isoformat()
    end = (d + datetime.timedelta(days=WINDOW_DAYS)).isoformat()
    df = get_prices(tk, start, end)
    verdict, R = simulate(direction, entry, sl, tp, df)
    rec["verdict"] = verdict
    rec["R"] = round(R,2) if R else ""
    rows.append(rec)
    if i % 25 == 0:
        print(f"  {i}/{len(ideas)} done", file=sys.stderr)
    time.sleep(0.15)  # be gentle to Yahoo

# ── write CSV ──────────────────────────────────────────────────────────
with open(OUT_CSV, "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
    w.writeheader(); w.writerows(rows)

# ── aggregate ───────────────────────────────────────────────────────────
def bucket_type(t):
    return {"forex":"Forex","index":"Indices","commodity":"Metals/Commodities",
            "stock":"Stocks","spot":"Crypto/Spot","futures":"Futures"}.get(t, t or "Other")

agg = defaultdict(lambda: defaultdict(int))
Rwins = defaultdict(list)
for r in rows:
    cls = bucket_type(r["type"])
    agg[cls][r["verdict"]] += 1
    agg["ALL"][r["verdict"]] += 1
    if r["verdict"] in ("win","loss") and r["R"] != "":
        Rwins[cls].append((r["verdict"], r["R"]))
        Rwins["ALL"].append((r["verdict"], r["R"]))

def stats(cls):
    a = agg[cls]
    wins = a.get("win",0); losses = a.get("loss",0)
    decided = wins + losses
    wr = (100*wins/decided) if decided else 0
    # expectancy in R: avg of (+R for win, -1 for loss)
    exp = None
    rs = Rwins[cls]
    if rs:
        vals = [r if v=="win" else -1.0 for v,r in rs]
        exp = sum(vals)/len(vals)
    return wins, losses, a.get("ambiguous",0), a.get("open",0), a.get("unparseable",0), a.get("neutral_skip",0), a.get("no_ticker",0)+a.get("no_price",0), wr, exp

lines = []
lines.append("# Cornelius Ward — Retrospective Profitability Backtest\n")
lines.append(f"*Generated {datetime.datetime.now().isoformat(timespec='minutes')}. "
             f"Mechanical test of all {len(ideas)} published ideas: for each directional idea with "
             f"parseable entry/SL/TP, daily price was walked {WINDOW_DAYS} days forward from the publish "
             f"date to see whether the take-profit or the stop-loss was reached first.*\n")
lines.append("## ⚠️ Read this first — what this is and isn't\n")
lines.append("- **Daily candles only.** Yahoo doesn't serve years-old intraday FX, so intraday scalp "
             "setups whose TP and SL both fall inside a single day's range are marked **AMBIGUOUS** "
             "(we genuinely cannot tell which hit first) — NOT counted as wins or losses.\n"
             "- **Mechanical, not discretionary.** This tests 'if you blindly took every published level.' "
             "Ward trades these *discretionarily* with live timing, partial exits, and mind-changes — so his "
             "real results will differ (likely better on the ones he actually took, since he skips the bad ones).\n"
             "- **Conservative parser.** Ideas without cleanly labeled entry+SL+TP are **UNPARSEABLE** and "
             "excluded from the win-rate (reported separately, not as losses).\n"
             "- **Win rate = wins / (wins + losses)**, excluding ambiguous/open/unparseable.\n")

lines.append("## Results by asset class\n")
lines.append("| Asset class | Wins | Losses | Win rate | Avg expectancy (R) | Ambiguous | Open (no hit in 45d) | Unparseable | Neutral (skipped) |")
lines.append("|---|---|---|---|---|---|---|---|---|")
order = ["ALL","Forex","Indices","Metals/Commodities","Stocks","Crypto/Spot","Futures"]
seen = set()
for cls in order + [c for c in agg if c not in order]:
    if cls in seen or cls not in agg: continue
    seen.add(cls)
    w,l,amb,op,unp,neu,nodata,wr,exp = stats(cls)
    label = "**OVERALL**" if cls=="ALL" else cls
    exps = f"{exp:+.2f}R" if exp is not None else "—"
    lines.append(f"| {label} | {w} | {l} | {wr:.0f}% | {exps} | {amb} | {op} | {unp} | {neu} |")

lines.append("\n## How to read expectancy\n")
lines.append("Expectancy is the average R per *decided* trade, treating each loss as -1R and each win as its "
             "actual reward:risk. **Positive = the published levels, taken mechanically, made money on a "
             "risk-adjusted basis.** Negative = they lost. A 50% win rate at +0.5R avg expectancy is "
             "profitable; a 70% win rate at -0.3R (tiny targets, wide stops) is not.\n")
lines.append("\n## Caveats for the partner meeting\n")
lines.append("1. The AMBIGUOUS bucket is large for intraday ideas — to resolve it we'd need a paid intraday "
             "historical feed (e.g., Dukascopy tick data) and re-run. Worth it before trusting scalp win-rates.\n"
             "2. 'Open' ideas never hit either level in 45 days — usually means the move fizzled or the levels "
             "were too far out; not a loss but not a win.\n"
             "3. This validates *the levels*, not *Ward's execution*. The bot will execute mechanically, so this "
             "mechanical backtest is actually the MORE relevant number for bot expectations.\n")
open(OUT_MD,"w").write("\n".join(lines))
print("\n".join(lines))
print(f"\nWrote {OUT_MD} and {OUT_CSV}", file=sys.stderr)
