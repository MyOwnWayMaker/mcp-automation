# Xactimate AI Automation Project

## Overview
Build an AI-powered workflow that automates insurance claims adjusting work in Xactimate,
integrated into the existing MCP automation server.

## User Context
- **Profession:** Independent Insurance Claims Adjuster
- **Primary software:** Xactimate Online (90%), Xactimate Desktop (10%)
- **Goal:** Use AI to prep estimates while driving between job sites, then review and submit faster when stationary

## Critical Note: Xactimate Online Is NOT Browser-Based
Despite being called "Xactimate Online," when you open a file it launches a downloaded
Windows desktop application — not a web browser. This means:
- **ALL Xactimate work requires Windows**, not just the 10% previously noted
- The Mac Mini will need Bootcamp for all Xactimate use
- Browser automation (Playwright) will NOT work for Xactimate
- Automation must use Windows desktop automation (e.g. AutoHotkey, PyAutoGUI, or
  Xactimate's own ESX file format for importing estimates programmatically)
- The ESX file format (XML-based) is the most promising automation path —
  AI builds the ESX file, user imports it into Xactimate to review and submit

---

## Planned Workflow

### Step 1 — At the job site
- Take damage photos
- Record a voice note with claim details, insured info, policy notes

### Step 2 — While driving (hands-free)
- Send voice note + photos to AI via iMessage
- AI works in the background automatically

### Step 3 — AI processing (automatic)
- Transcribe voice note
- Analyze photos → identify damages → map to Xactimate line items
- Pull property details from Zillow/Redfin
- Draft full narrative using the adjusting company's template
- Prepare complete estimate draft with line items

### Step 4 — When stationary
- Open Claude Desktop, review everything AI prepared
- AI opens Xactimate Online via browser automation
- Fills in line items, narrative, photo labels while user verifies
- User sketches rooms/roofs manually (not automatable)
- Submit

---

## Automation Levels by Task

| Task | Automation Level | Notes |
|---|---|---|
| Narrative writing | ~100% | AI fills template with all collected details |
| Property details (Zillow/Redfin) | ~100% | Web scraping |
| Photo labeling & descriptions | ~90% | Computer vision via Gemini |
| Line item suggestions from photos | ~80% | Needs user's format/preferences trained in |
| Filling Xactimate Online fields | ~60% | ESX file import (NOT browser — app is Windows-only) |
| Room & roof sketching | 0% | Must be done manually in Xactimate |

---

## Hardware Setup (Pending Mac Mini Purchase)
- **Mac Mini** (M-series recommended) — always-on workstation at home/office
- **Ollama** — runs local LLM on Mac Mini (free, private, no API costs)
- **Cloudflare Tunnel** — exposes Mac Mini to the internet securely (free)
- **Railway MCP server** — connects to Mac Mini via Cloudflare Tunnel URL
- **Bootcamp** — required for ALL Xactimate work (Online and Desktop both require Windows)
- Xactimate Online misleadingly launches a Windows desktop app, not a browser

---

## MCP Tools to Build

### New tools needed:
- `xactimate_analyze_photos` — takes damage photos, identifies damage types, suggests line items
- `xactimate_pull_property_details` — scrapes Zillow/Redfin for property info by address
- `xactimate_transcribe_voice_note` — transcribes voice memo to structured claim details
- `xactimate_draft_narrative` — fills in narrative template with all collected details
- `xactimate_prepare_estimate` — assembles full estimate draft (line items + descriptions)
- `xactimate_fill_online` — Playwright browser automation to fill Xactimate Online
- `ollama_prompt` — sends prompts to local Ollama LLM running on Mac Mini

### Existing tools already useful:
- `imessage_send` / `imessage_get_recent_chats` — receive job site texts
- `gmail_*` — receive policy docs, communicate with adjusting companies
- `gdocs_*` — store narrative templates, draft reports
- `drive_*` — store photos, completed reports
- `http_request` — call Zillow/Redfin APIs

---

## Information Still Needed from User

1. **Narrative templates** — copy of each adjusting company's narrative format
   - Which independent adjusting companies do you work with most?
2. **Line item format** — how estimates are typically structured
   - Example of a completed estimate (can be anonymized)
3. **Photo workflow** — how photos are currently named/organized
4. **Xactimate Online login** — will be stored securely in .env (not collected yet)

---

## Setup Steps (When Ready)

1. Purchase Mac Mini (M2 or M4 recommended for Ollama performance)
2. Install Ollama → pull preferred model (Llama 3.1, Mistral, or similar)
3. Set up Cloudflare Tunnel → get permanent URL
4. Add Cloudflare URL + Ollama config to Railway environment variables
5. Enable Google Docs/Drive scopes for new templates
6. Build Xactimate-specific MCP tools (listed above)
7. Re-authenticate Google with new scopes (npm run auth:google)
8. Test full workflow end-to-end with a real claim

---

## Notes
- Sketching (rooms & roofs) cannot be automated — Xactimate's drawing tool requires manual input
- Different adjusting companies have different narrative templates — need one per company
- Line item format should be captured from a real completed estimate for accuracy
- Consider Twilio as a fallback for SMS triggers if iMessage automation has limitations while driving
