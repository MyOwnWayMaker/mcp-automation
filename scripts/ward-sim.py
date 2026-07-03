#!/usr/bin/env python3
"""
Sequential event simulator for Ward's ideas — implements his ACTUAL trade
management (per Hakiel 2026-05-21), not a naive stop-out:

  - Entry: TOUCH fills (price wicks through the level). Scale in if multiple
    entries touch before exit (average them, equal weight).
  - TP ladder: shave 50% / 25% / 12.5% / 12.5% at TP1..TP4.
  - Protect-after-TP1: once TP1 banks, if price returns to the average entry,
    close the remainder at breakeven (lock the partial; runner gives back ~0).
  - Loss (anti-stop-hunt): NOT a touch of the invalidation line. Price must
    travel BUFFER pips PAST the invalidation/structure line. EURUSD buffer
    = 10 pips. Only then is the (remaining) position closed at that level.

Reports, split LONG vs SHORT: win%, pips-won-when-right, pips-lost-when-wrong,
net pips, R-expectancy. EURUSD first (Phase 1).

Inputs:
  ~/CornyWardTradingView/_extracted_plays.json
  /tmp/wardprices/eurusd-m15-bid-*.csv   (timestamp_ms,open,high,low,close)
Outputs:
  ~/CornyWardTradingView/_EURUSD Profitability Backtest.md
  ~/CornyWardTradingView/_eurusd_sim_per_idea.csv
"""
import json, csv, os, glob, datetime, bisect, statistics

PLAYS = os.path.expanduser("~/CornyWardTradingView/_extracted_plays.json")
PRICE_GLOB = "/tmp/wardprices/eurusd-m15-bid-*.csv"
OUT_MD = os.path.expanduser("~/CornyWardTradingView/_EURUSD Profitability Backtest.md")
OUT_CSV = os.path.expanduser("~/CornyWardTradingView/_eurusd_sim_per_idea.csv")

PIP = 0.0001
LOSS_BUFFER_PIPS = 10
WINDOW_DAYS = 30
SHAVE = [0.50, 0.25, 0.125, 0.125]   # TP1..TP4 fractions

# ── load M15 price series ────────────────────────────────────────────────
files = sorted(glob.glob(PRICE_GLOB))
if not files:
    raise SystemExit("No EURUSD price CSV yet — wait for the dukascopy fetch to finish.")
ts_list, hi_list, lo_list = [], [], []
for fp in files:
    with open(fp) as f:
        r = csv.reader(f); next(r, None)
        for row in r:
            if len(row) < 5: continue
            try:
                ts_list.append(int(row[0])); hi_list.append(float(row[2])); lo_list.append(float(row[3]))
            except: pass
# sort by ts (in case multi-file)
order = sorted(range(len(ts_list)), key=lambda i: ts_list[i])
ts_list = [ts_list[i] for i in order]; hi_list=[hi_list[i] for i in order]; lo_list=[lo_list[i] for i in order]
print(f"Loaded {len(ts_list)} M15 bars, {datetime.datetime.utcfromtimestamp(ts_list[0]/1000).date()} → {datetime.datetime.utcfromtimestamp(ts_list[-1]/1000).date()}")

def bars_from(date_str, days):
    start = int(datetime.datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=datetime.timezone.utc).timestamp()*1000)
    end = start + days*86400*1000
    i = bisect.bisect_left(ts_list, start)
    j = bisect.bisect_right(ts_list, end)
    return list(zip(ts_list[i:j], hi_list[i:j], lo_list[i:j]))

# ── simulate one play ────────────────────────────────────────────────────
def simulate(play, date):
    d = play["direction"]; long = (d == "long")
    entries = sorted(set(e["price"] for e in play.get("entries",[])))
    targets = play.get("targets") or []
    inv = play.get("invalidation") or play.get("structure_line")
    if not entries or not targets or inv is None:
        return {"verdict":"no_levels","pips":None,"R":None}
    # order targets in the direction of profit, nearest-first
    targets = sorted(targets, reverse=not long)
    targets = [t for t in targets if (t>max(entries)) == long]  # keep only true profit-side targets
    if not targets:
        return {"verdict":"no_targets","pips":None,"R":None}
    loss_level = inv - LOSS_BUFFER_PIPS*PIP if long else inv + LOSS_BUFFER_PIPS*PIP

    bars = bars_from(date, WINDOW_DAYS)
    if not bars: return {"verdict":"no_price","pips":None,"R":None}

    filled = []          # entry prices touched so far
    avg_entry = None
    tp_hit = 0           # how many TP rungs banked
    realized_pips = 0.0  # weighted pips locked
    remaining = 1.0      # fraction of position still open
    risk_pips = None

    for (t,hi,lo) in bars:
        # 1. fills (touch) — scale in any entry the bar reaches that isn't filled
        for e in entries:
            if e not in filled and lo <= e <= hi:
                filled.append(e)
                avg_entry = sum(filled)/len(filled)
                risk_pips = abs(avg_entry - loss_level)/PIP
        if avg_entry is None:
            continue   # not in a position yet

        # 2. loss check (buffer past invalidation) — applies to remaining size
        hit_loss = (lo <= loss_level) if long else (hi >= loss_level)
        if hit_loss and remaining > 0:
            pl = (loss_level - avg_entry)/PIP * (1 if long else -1)
            realized_pips += remaining * pl
            remaining = 0.0
            break

        # 3. TP ladder (touch) — bank shave fractions in order
        while tp_hit < len(targets) and tp_hit < len(SHAVE) and remaining > 0:
            tp = targets[tp_hit]
            reached = (hi >= tp) if long else (lo <= tp)
            if not reached: break
            frac = SHAVE[tp_hit]
            gain = (tp - avg_entry)/PIP * (1 if long else -1)
            realized_pips += frac * gain
            remaining -= frac
            tp_hit += 1

        # 4. protect-after-TP1: once TP1 banked, if price returns to avg_entry, close runner ~breakeven
        if tp_hit >= 1 and remaining > 0:
            back_to_entry = (lo <= avg_entry) if long else (hi >= avg_entry)
            if back_to_entry:
                realized_pips += remaining * 0.0   # breakeven on the runner
                remaining = 0.0
                break

        if remaining <= 0.0001:
            break

    if avg_entry is None:
        return {"verdict":"never_filled","pips":None,"R":None}
    if remaining > 0 and tp_hit == 0:
        return {"verdict":"open","pips":round(realized_pips,1),"R":None}

    R = (realized_pips / risk_pips) if risk_pips else None
    verdict = "win" if realized_pips > 0.5 else ("loss" if realized_pips < -0.5 else "scratch")
    return {"verdict":verdict, "pips":round(realized_pips,1), "R":round(R,2) if R is not None else None,
            "tp_hit":tp_hit, "risk_pips":round(risk_pips,1) if risk_pips else None}

# ── run over EURUSD ideas ────────────────────────────────────────────────
data = json.load(open(PLAYS))
rows = []
for idea in data:
    if idea.get("symbol") != "EURUSD": continue
    plays = idea.get("plays") or []
    if not plays: continue
    pi = idea.get("primary_play_index") or 0
    if pi >= len(plays): pi = 0
    play = plays[pi]
    res = simulate(play, idea["date"])
    rows.append({"id":idea["id"],"date":idea["date"],"direction":play["direction"],
                 **res})

with open(OUT_CSV,"w",newline="") as f:
    w=csv.DictWriter(f, fieldnames=["id","date","direction","verdict","pips","R","tp_hit","risk_pips"])
    w.writeheader()
    for r in rows: w.writerow({k:r.get(k,"") for k in w.fieldnames})

def agg(rs):
    wins=[r for r in rs if r["verdict"]=="win"]
    losses=[r for r in rs if r["verdict"]=="loss"]
    scr=[r for r in rs if r["verdict"]=="scratch"]
    opn=[r for r in rs if r["verdict"]=="open"]
    decided=len(wins)+len(losses)
    wr = 100*len(wins)/decided if decided else 0
    pips_won = sum(r["pips"] for r in wins) if wins else 0
    pips_lost = sum(r["pips"] for r in losses) if losses else 0
    avg_win = statistics.mean([r["pips"] for r in wins]) if wins else 0
    avg_loss = statistics.mean([r["pips"] for r in losses]) if losses else 0
    Rs = [r["R"] for r in rs if r.get("R") is not None and r["verdict"] in ("win","loss","scratch")]
    exp = statistics.mean(Rs) if Rs else None
    net = sum(r["pips"] for r in rs if r.get("pips") is not None)
    return dict(n=len(rs),wins=len(wins),losses=len(losses),scratch=len(scr),open=len(opn),
                wr=wr,pips_won=pips_won,pips_lost=pips_lost,avg_win=avg_win,avg_loss=avg_loss,
                net=net,exp=exp)

allr=[r for r in rows if r["verdict"] in ("win","loss","scratch","open")]
longs=[r for r in allr if r["direction"]=="long"]
shorts=[r for r in allr if r["direction"]=="short"]

def fmt(a):
    e = f"{a['exp']:+.2f}R" if a['exp'] is not None else "—"
    return (f"{a['n']} | {a['wins']}W/{a['losses']}L/{a['scratch']}scr/{a['open']}open | "
            f"{a['wr']:.0f}% | avg win {a['avg_win']:+.0f}p | avg loss {a['avg_loss']:+.0f}p | "
            f"net {a['net']:+.0f}p | {e}")

lines=[]
lines.append("# EURUSD — Ward Idea Profitability Backtest\n")
lines.append("*Sequential simulation of Ward's PRIMARY play per idea on M15 EURUSD (Dukascopy bid). "
             "Implements his real management: touch-fill + scale-in, shave-ladder TPs (50/25/12.5/12.5), "
             "protect-after-TP1 (runner exits at breakeven if price returns to entry), and loss only when "
             "price runs 10 pips PAST the invalidation line (anti-stop-hunt buffer). Window 30 days/idea.*\n")
lines.append("| Segment | n | W/L/scr/open | Win% | Avg win | Avg loss | Net pips | Expectancy |")
lines.append("|---|---|---|---|---|---|---|---|")
for label, a in [("**ALL EURUSD**", agg(allr)), ("**LONGS**", agg(longs)), ("**SHORTS**", agg(shorts))]:
    e = f"{a['exp']:+.2f}R" if a['exp'] is not None else "—"
    lines.append(f"| {label} | {a['n']} | {a['wins']}/{a['losses']}/{a['scratch']}/{a['open']} | {a['wr']:.0f}% | "
                 f"{a['avg_win']:+.0f}p | {a['avg_loss']:+.0f}p | {a['net']:+.0f}p | {e} |")
lines.append("\n## Longs vs Shorts (validating his 'shorts move faster/more profitable' claim)\n")
la, sa = agg(longs), agg(shorts)
lines.append(f"- **Longs**: {la['wr']:.0f}% win, avg win {la['avg_win']:+.0f} pips, net {la['net']:+.0f} pips, expectancy {('%+.2fR'%la['exp']) if la['exp'] is not None else '—'}")
lines.append(f"- **Shorts**: {sa['wr']:.0f}% win, avg win {sa['avg_win']:+.0f} pips, net {sa['net']:+.0f} pips, expectancy {('%+.2fR'%sa['exp']) if sa['exp'] is not None else '—'}")
verdict = "SHORTS more profitable ✓ (matches his claim)" if (sa['exp'] or -9) > (la['exp'] or -9) else "LONGS more profitable (contradicts his claim — worth a closer look)"
lines.append(f"- **Verdict**: {verdict}\n")
lines.append("## Caveats\n")
lines.append("- M15 bars (not tick): within-bar sequencing of two levels in the same 15-min candle is "
             "resolved conservatively (loss checked before TP in that bar). Tick data would refine the few "
             "same-bar cases.\n- Bid prices only; spread (~0.5 pip) not deducted — shave a touch off wins for realism.\n"
             "- Only the PRIMARY play per idea is simulated (his stated-bias trade). The counter-trend bounce "
             "plays are extracted too and can be simulated separately.\n"
             "- 'Scratch' = hit TP1 then gave the runner back to breakeven (still banked the 50% partial; net "
             "small positive). 'Open' = never resolved within 30 days.\n")
open(OUT_MD,"w").write("\n".join(lines))
print("\n".join(lines))
print(f"\nWrote {OUT_MD}")
