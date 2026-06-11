// Integration regression test for xact_add_note persistence.
//
// History (2026-06-10): xact_add_note returned ✅ but the note never persisted.
// Root cause: the page-level addNote(isTask, isReply, ...) only OPENS XA's
// add-note dialog (it takes flags, not the note text); the tool called
// addNote(noteText) and reported success on "the function ran", with no
// read-back. The diary count stayed flat (66) across two attempts.
//
// The fix added read-after-write verification: the tool now re-reads the diary
// and only reports success if the note text is visible AND/OR the "Notes (N)"
// counter incremented. This test locks that contract by doing a real round-trip.
//
// LIVE + WRITES TO A REAL CLAIM. It is therefore GATED on XACT_TEST_MFN and is
// SKIPPED unless that env var names a designated safe/low-activity test MFN.
// It writes a uniquely-tagged note, re-reads within 5s, asserts the tag appears
// and the count incremented by exactly 1.
//
// HEADS-UP: XactAnalysis diary notes are IMMUTABLE (no deleteNote, no per-row
// delete control) — the cleanup below is best-effort and is normally a NO-OP, so
// every live run PERMANENTLY appends one note. Point XACT_TEST_MFN at a DEDICATED
// THROWAWAY assignment, never a live customer claim.
//
// Run it explicitly:  XACT_TEST_MFN=<safe-mfn> node --test tests/xact_add_note.test.mjs

import assert from "node:assert";
import { test } from "node:test";

const MFN = process.env.XACT_TEST_MFN;
const RUN = !!MFN;

function textOf(res) {
  return (res?.content || []).map((c) => c.text || "").join("\n");
}
function parseCount(notesText) {
  const m = notesText.match(/Notes count:\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

test(
  "xact_add_note persists and is confirmed by read-back (count + text)",
  { skip: RUN ? false : "set XACT_TEST_MFN to a designated safe test MFN to run this live integration test" },
  async () => {
    const { xactAddNote, xactGetNotes, xactDeleteNote } = await import(
      "../dist/tools/xactanalysis.js"
    );

    const tag = `TEST-XACT-NOTE-${Date.now()}`;
    const note = `${tag} :: automated suite check, safe to delete.`;

    // Baseline count.
    const before = textOf(await xactGetNotes({ mfn: MFN }));
    const beforeCount = parseCount(before);
    assert.ok(beforeCount != null, `could not read baseline Notes count for ${MFN}`);
    assert.ok(!before.includes(tag), "unique tag unexpectedly already present before write");

    // Write.
    const addRes = await xactAddNote({ mfn: MFN, note });
    const addText = textOf(addRes);
    assert.notStrictEqual(
      addRes.isError,
      true,
      `xact_add_note reported an error instead of persisting:\n${addText}`
    );
    assert.ok(
      /CONFIRMED/i.test(addText),
      `xact_add_note did not return a CONFIRMED read-back:\n${addText}`
    );

    // Re-read within 5 seconds.
    await new Promise((r) => setTimeout(r, 1500));
    const after = textOf(await xactGetNotes({ mfn: MFN }));
    const afterCount = parseCount(after);

    // Hard assertions — the exact regression we hit: tag must appear AND the
    // counter must have incremented by exactly 1. No soft pass.
    assert.ok(
      after.includes(tag),
      `unique note tag "${tag}" NOT found in diary after write — note did not persist`
    );
    assert.ok(afterCount != null, "could not read Notes count after write");
    assert.strictEqual(
      afterCount,
      beforeCount + 1,
      `Notes count did not increment by 1 (was ${beforeCount}, now ${afterCount})`
    );

    // Cleanup (best-effort, normally a NO-OP): XA diary notes are immutable, so
    // this will usually NOT remove the note. The note is clearly tagged
    // "safe to delete" — this is why XACT_TEST_MFN must be a throwaway MFN.
    try {
      await xactDeleteNote({ mfn: MFN, note_text_match: tag });
    } catch {
      /* immutable diary — leave the clearly-tagged test note */
    }
  }
);
