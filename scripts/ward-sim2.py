#!/usr/bin/env python3
"""
Ward EURUSD backtest v2 — refinements:
  - PLAY SELECTION: 'primary' (his stated-bias play only) vs 'best'
    (fall back to whichever play in the idea has a complete entry+target+
    invalidation triplet — ~doubles coverage by salvaging ideas whose primary
    play was incomplete).
  - RUNNER MODE: 'exit' (close remainder at breakeven when price returns to
    entry after TP1 — the conservative FLOOR) vs 'hold' (keep the runner open
    through re-accumulation, let it reach TP2-4, only the loss-buffer or
    window-end closes it — the optimistic CEILING). Per Hakiel: in reality
    they re-evaluate, so truth sits between floor and ceiling.

Runs the full 2x2 matrix and reports long vs short for each.
Same Ward mechanics: touch-fill + scale-in, shave ladder 50/25/12.5/12.5,
10-pip anti-stop-hunt loss buffer past invalidation.
"""
import json, csv, os, glob, datetime, bisect, statistics

PLAYS = os.path.expanduser("~/CornyWardTradingView/_extracted_plays.json")
PRICE_GLOB = "/tmp/wardprices/eurusd-m15-bid-*.csv"
OUT_MD = os.path.expanduser("~/CornyWardTradingView/_EURUSD Profitability Backtest v2.md")

PIP = 0.0001
LOSS_BUFFER_PIPS = 10
WINDOW_DAYS = 30
SHAVE = [0.50, 0.25, 0.125, 0.125]

files = sorted(glob.glob(PRICE_GLOB))
ts_list, hi_list, lo_list, cl_list = [], [], [], []
for fp in files:
    with open(fp) as f:
        r = csv.reader(f); next(r, None)
        for row in r:
            if len(row) < 5: continue
            try:
                ts_list.append(int(row[0])); hi_list.append(float(row[2]))
                lo_list.append(float(row[3])); cl_list.append(float(row[4]))
            except: pass
order = sorted(range(len(ts_list)), key=lambda i: ts_list[i])
ts_list=[ts_list[i] for i in order]; hi_list=[hi_list[i] for i in order]
lo_list=[lo_list[i] for i in order]; cl_list=[cl_list[i] for i in order]

def bars_from(date_str, days):
    start = int(datetime.datetime.strptime(date_str,"%Y-%m-%d").replace(tzinfo=datetime.timezone.utc).timestamp()*1000)
    end = start + days*86400*1000
    i = bisect.bisect_left(ts_list, start); j = bisect.bisect_right(ts_list, end)
    return list(zip(ts_list[i:j], hi_list[i:j], lo_list[i:j], cl_list[i:j]))

def play_complete(p):
    ent = sorted(set(e["price"] for e in p.get("entries",[])))
    inv = p.get("invalidation") or p.get("structure_line")
    tgts = p.get("targets") or []
    if not ent or inv is None or not tgts: return False
    long = (p["direction"]=="long")
    tgts = [t for t in tgts if (t>max(ent))==long]
    return len(tgts) > 0

def simulate(play, date, runner_mode):
    long = (play["direction"]=="long")
    entries = sorted(set(e["price"] for e in play.get("entries",[])))
    inv = play.get("invalidation") or play.get("structure_line")
    targets = [t for t in (play.get("targets") or []) if (t>max(entries))==long] if entries else []
    targets = sorted(targets, reverse=not long)
    if not entries or inv is None or not targets:
        return {"verdict":"no_levels","pips":None,"R":None}
    loss_level = inv - LOSS_BUFFER_PIPS*PIP if long else inv + LOSS_BUFFER_PIPS*PIP
    bars = bars_from(date, WINDOW_DAYS)
    if not bars: return {"verdict":"no_price","pips":None,"R":None}

    filled=[]; avg_entry=None; tp_hit=0; realized=0.0; remaining=1.0; risk=None; tp1_done=False
    last_close=bars[-1][3]
    for (t,hi,lo,cl) in bars:
        for e in entries:
            if e not in filled and lo<=e<=hi:
                filled.append(e); avg_entry=sum(filled)/len(filled)
                risk=abs(avg_entry-loss_level)/PIP
        if avg_entry is None: continue
        # loss
        if ((lo<=loss_level) if long else (hi>=loss_level)) and remaining>0:
            pl=(loss_level-avg_entry)/PIP*(1 if long else -1)
            realized+=remaining*pl; remaining=0.0; break
        # TP ladder
        while tp_hit<len(targets) and tp_hit<len(SHAVE) and remaining>0:
            tp=targets[tp_hit]
            if not ((hi>=tp) if long else (lo<=tp)): break
            gain=(tp-avg_entry)/PIP*(1 if long else -1)
            realized+=SHAVE[tp_hit]*gain; remaining-=SHAVE[tp_hit]; tp_hit+=1
            if tp_hit==1: tp1_done=True
        # runner handling after TP1
        if tp1_done and remaining>0 and runner_mode=="exit":
            if (lo<=avg_entry) if long else (hi>=avg_entry):
                remaining=0.0; break   # breakeven on runner
        if remaining<=0.0001: break
    if avg_entry is None:
        return {"verdict":"never_filled","pips":None,"R":None}
    # window-end: value any remaining runner at last close (hold mode mostly)
    if remaining>0 and tp_hit>0:
        mtm=(last_close-avg_entry)/PIP*(1 if long else -1)
        realized+=remaining*mtm; remaining=0.0
    if tp_hit==0 and remaining>0:
        return {"verdict":"open","pips":round(realized,1),"R":None}
    R=(realized/risk) if risk else None
    verdict="win" if realized>0.5 else ("loss" if realized<-0.5 else "scratch")
    return {"verdict":verdict,"pips":round(realized,1),"R":round(R,2) if R is not None else None}

data=json.load(open(PLAYS))
eur=[d for d in data if d.get("symbol")=="EURUSD" and (d.get("plays") or [])]

def pick_play(idea, mode):
    plays=idea["plays"]; pi=idea.get("primary_play_index") or 0
    if pi>=len(plays): pi=0
    if mode=="primary":
        return plays[pi]
    # best: primary if complete, else the most-complete other play
    if play_complete(plays[pi]): return plays[pi]
    complete=[p for p in plays if play_complete(p)]
    if complete:
        return max(complete, key=lambda p: len(p.get("targets",[]))+len(p.get("entries",[])))
    return plays[pi]

def run(mode, runner):
    rows=[]
    for idea in eur:
        p=pick_play(idea, mode)
        res=simulate(p, idea["date"], runner)
        rows.append({"direction":p["direction"], **res})
    return rows

def agg(rows):
    rs=[r for r in rows if r["verdict"] in ("win","loss","scratch","open")]
    wins=[r for r in rs if r["verdict"]=="win"]; losses=[r for r in rs if r["verdict"]=="loss"]
    dec=len(wins)+len(losses); wr=100*len(wins)/dec if dec else 0
    Rs=[r["R"] for r in rs if r.get("R") is not None and r["verdict"] in ("win","loss","scratch")]
    exp=statistics.mean(Rs) if Rs else None
    net=sum(r["pips"] for r in rs if r.get("pips") is not None)
    aw=statistics.mean([r["pips"] for r in wins]) if wins else 0
    al=statistics.mean([r["pips"] for r in losses]) if losses else 0
    return dict(dec=dec,w=len(wins),l=len(losses),wr=wr,exp=exp,net=net,aw=aw,al=al,
                scr=len([r for r in rs if r["verdict"]=="scratch"]),
                opn=len([r for r in rs if r["verdict"]=="open"]))

lines=[]
lines.append("# EURUSD — Ward Backtest v2 (coverage + runner refinements)\n")
lines.append("*2x2 matrix: play-selection (primary vs best-complete) x runner-mode (exit-at-breakeven = floor, "
             "hold-through-accumulation = ceiling). Ward mechanics: touch-fill + scale-in, shave ladder "
             "50/25/12.5/12.5, 10-pip anti-stop-hunt loss buffer, 30-day window. M15 Dukascopy bid.*\n")
for mode in ("primary","best"):
    lines.append(f"\n## Play selection: {mode.upper()}" + (" (his stated-bias trade only)" if mode=="primary" else " (max coverage — salvages incomplete-primary ideas)"))
    for runner in ("exit","hold"):
        rows=run(mode,runner)
        a=agg(rows); L=agg([r for r in rows if r["direction"]=="long"]); S=agg([r for r in rows if r["direction"]=="short"])
        rname="EXIT runner @ breakeven (FLOOR)" if runner=="exit" else "HOLD through re-accumulation (CEILING)"
        lines.append(f"\n### Runner: {rname}")
        lines.append("| Segment | Decided | Win% | Avg win | Avg loss | Net pips | Expectancy |")
        lines.append("|---|---|---|---|---|---|---|")
        for lbl,x in [("All",a),("Longs",L),("Shorts",S)]:
            e=f"{x['exp']:+.2f}R" if x['exp'] is not None else "—"
            lines.append(f"| {lbl} | {x['w']}W/{x['l']}L | {x['wr']:.0f}% | {x['aw']:+.0f}p | {x['al']:+.0f}p | {x['net']:+.0f}p | {e} |")

# headline comparison
lines.append("\n## Headline — the profitability RANGE for EURUSD shorts (his edge)\n")
for mode in ("best",):
    fe=agg([r for r in run(mode,"exit") if r["direction"]=="short"])
    fh=agg([r for r in run(mode,"hold") if r["direction"]=="short"])
    lines.append(f"- **Shorts, best-coverage, FLOOR (exit runner):** {fe['wr']:.0f}% win, net {fe['net']:+.0f} pips, "
                 f"{('%+.2fR'%fe['exp']) if fe['exp'] is not None else '—'} expectancy ({fe['dec']} trades)")
    lines.append(f"- **Shorts, best-coverage, CEILING (hold runner):** {fh['wr']:.0f}% win, net {fh['net']:+.0f} pips, "
                 f"{('%+.2fR'%fh['exp']) if fh['exp'] is not None else '—'} expectancy ({fh['dec']} trades)")
    le=agg([r for r in run(mode,"exit") if r["direction"]=="long"])
    lh=agg([r for r in run(mode,"hold") if r["direction"]=="long"])
    lines.append(f"- **Longs, best-coverage, FLOOR:** {le['wr']:.0f}% win, net {le['net']:+.0f} pips, {('%+.2fR'%le['exp']) if le['exp'] is not None else '—'}")
    lines.append(f"- **Longs, best-coverage, CEILING:** {lh['wr']:.0f}% win, net {lh['net']:+.0f} pips, {('%+.2fR'%lh['exp']) if lh['exp'] is not None else '—'}")

lines.append("\n## Caveats unchanged\n")
lines.append("- M15 not tick; bid only (deduct ~0.5p/trade for spread). Window 30d. 'hold' marks any open "
             "runner to the window's last close. Truth for the runner sits between FLOOR and CEILING since "
             "Ward re-evaluates rather than always-exiting or always-holding.\n")
open(OUT_MD,"w").write("\n".join(lines))
print("\n".join(lines))
print(f"\nWrote {OUT_MD}")
