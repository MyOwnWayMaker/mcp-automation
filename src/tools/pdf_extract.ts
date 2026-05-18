import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { google } from "googleapis";
import { getGoogleAuthClient } from "../auth/google.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "module";

// pdf-parse ships as CommonJS and its index.js has a debug-mode side effect
// that tries to read a test fixture if the file isn't loaded the right way.
// Importing the inner module bypasses that and works reliably under ESM.
const require = createRequire(import.meta.url);
const pdfParse: (buf: Buffer) => Promise<{ text: string; numpages: number; info?: any; metadata?: any }>
  = require("pdf-parse/lib/pdf-parse.js");

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

// ── OCR fallback ────────────────────────────────────────────────────────────
// When pdf-parse returns empty text (PDF has no text layer — i.e., it's a
// scanned image), shell out to poppler's pdftoppm to render each page as a
// PNG, then run tesseract on each PNG. Both binaries are installed via the
// Dockerfile (poppler-utils + tesseract-ocr + tesseract-ocr-eng).
//
// Tradeoffs vs. tesseract.js (pure-JS WASM):
//   - System tesseract is ~5x faster
//   - No 10MB+ language data download on first call (WASM build downloads on demand)
//   - Costs an apt install (already done in Dockerfile)

function which(bin: string): string | null {
  try {
    const out = execFileSync("which", [bin], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

let _ocrAvailable: boolean | null = null;
let _ocrUnavailableReason = "";
function ocrAvailable(): boolean {
  if (_ocrAvailable !== null) return _ocrAvailable;
  const missing: string[] = [];
  if (!which("pdftoppm")) missing.push("pdftoppm (poppler-utils)");
  if (!which("tesseract")) missing.push("tesseract");
  if (missing.length > 0) {
    _ocrAvailable = false;
    _ocrUnavailableReason = `OCR fallback unavailable — missing: ${missing.join(", ")}. Install in Dockerfile via: apt-get install -y poppler-utils tesseract-ocr tesseract-ocr-eng`;
    return false;
  }
  _ocrAvailable = true;
  return true;
}

type OcrPageResult = {
  page_num: number;
  text: string;
  confidence: number | null; // 0-100, null if not parseable
};

async function ocrFromBuffer(buf: Buffer): Promise<{ pages: OcrPageResult[]; warnings: string[] }> {
  const warnings: string[] = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfocr_"));
  const pdfPath = path.join(tmpDir, "in.pdf");

  try {
    fs.writeFileSync(pdfPath, buf);

    // Render PDF pages to PNG. -r 200 gives 200 DPI which is the sweet spot
    // for OCR accuracy vs. encode time. -png picks the format. Pages land
    // as page-1.png, page-2.png, etc.
    try {
      execFileSync("pdftoppm", ["-png", "-r", "200", pdfPath, path.join(tmpDir, "page")], {
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (e: any) {
      const stderr = e?.stderr ? e.stderr.toString() : String(e?.message || e);
      warnings.push(`pdftoppm failed: ${stderr.trim().substring(0, 300)}`);
      return { pages: [], warnings };
    }

    const pngs = fs.readdirSync(tmpDir)
      .filter(n => /^page-\d+\.png$/.test(n))
      .sort((a, b) => {
        const ai = parseInt((a.match(/^page-(\d+)\.png$/) || ["0", "0"])[1], 10);
        const bi = parseInt((b.match(/^page-(\d+)\.png$/) || ["0", "0"])[1], 10);
        return ai - bi;
      })
      .map(n => path.join(tmpDir, n));

    if (pngs.length === 0) {
      warnings.push("pdftoppm produced no PNG output — the PDF may be empty or malformed");
      return { pages: [], warnings };
    }

    const pages: OcrPageResult[] = [];
    for (let i = 0; i < pngs.length; i++) {
      const png = pngs[i];
      const pageNum = i + 1;
      try {
        // Run tesseract twice: once for plain text (clean output), once for
        // TSV (per-word confidence). The TSV pass is small overhead given
        // tesseract has already loaded the model.
        const text = execFileSync("tesseract", [png, "stdout", "-l", "eng"], {
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: 50 * 1024 * 1024,
        }).toString("utf-8").trim();

        let confidence: number | null = null;
        try {
          const tsv = execFileSync("tesseract", [png, "stdout", "-l", "eng", "tsv"], {
            stdio: ["ignore", "pipe", "pipe"],
            maxBuffer: 50 * 1024 * 1024,
          }).toString("utf-8");
          // TSV columns: level page block para line word_num left top width height conf text
          // We want word-level rows (level 5) with non-empty text.
          const lines = tsv.split("\n").slice(1);
          const wordConfidences: number[] = [];
          for (const line of lines) {
            const cols = line.split("\t");
            if (cols.length < 12) continue;
            if (cols[0] !== "5") continue; // word-level only
            const conf = parseFloat(cols[10]);
            const word = cols[11];
            if (Number.isFinite(conf) && conf >= 0 && word && word.trim().length > 0) {
              wordConfidences.push(conf);
            }
          }
          if (wordConfidences.length > 0) {
            const avg = wordConfidences.reduce((a, b) => a + b, 0) / wordConfidences.length;
            confidence = Math.round(avg * 10) / 10;
          }
        } catch {
          // confidence is best-effort; if TSV pass fails just leave it null
        }

        pages.push({ page_num: pageNum, text, confidence });
      } catch (e: any) {
        const stderr = e?.stderr ? e.stderr.toString() : String(e?.message || e);
        warnings.push(`tesseract failed on page ${pageNum}: ${stderr.trim().substring(0, 200)}`);
        pages.push({ page_num: pageNum, text: "", confidence: null });
      }
    }

    return { pages, warnings };
  } finally {
    // Cleanup temp dir + all rendered PNGs
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ── Main extract result type ────────────────────────────────────────────────
type ExtractResult = {
  source: "text_layer" | "ocr" | "empty";
  text: string;
  num_pages: number;
  warnings: string[];
  ocr_pages?: OcrPageResult[]; // populated only when source === "ocr"
};

async function extractFromBuffer(buf: Buffer): Promise<ExtractResult> {
  const data = await pdfParse(buf);
  const text = (data.text || "").trim();
  const num_pages = data.numpages || 0;

  if (text) {
    return { source: "text_layer", text, num_pages, warnings: [] };
  }

  // No text layer — try OCR fallback
  if (!ocrAvailable()) {
    return {
      source: "empty",
      text: "",
      num_pages,
      warnings: [
        "No text layer found and OCR fallback is unavailable.",
        _ocrUnavailableReason,
      ],
    };
  }

  const ocr = await ocrFromBuffer(buf);
  const combinedText = ocr.pages
    .map(p => `--- Page ${p.page_num} ---\n${p.text || "(empty)"}`)
    .join("\n\n");
  const hasAnyText = ocr.pages.some(p => p.text.trim().length > 0);

  return {
    source: hasAnyText ? "ocr" : "empty",
    text: hasAnyText ? combinedText : "",
    num_pages: ocr.pages.length || num_pages,
    warnings: hasAnyText
      ? ocr.warnings
      : ["OCR ran but produced no text — PDF may be blank, image-corrupted, or in a non-English language", ...ocr.warnings],
    ocr_pages: ocr.pages,
  };
}

// ── Tools ───────────────────────────────────────────────────────────────────

export async function extractPdfText(args: {
  file_path?: string;
  drive_file_id?: string;
  gmail_message_id?: string;
  attachment_id?: string;
  page_range?: string; // currently informational only — pdf-parse returns full doc text
}): Promise<CallToolResult> {
  let buf: Buffer | null = null;
  let label = "";

  try {
    if (args.file_path) {
      if (!fs.existsSync(args.file_path)) {
        return ok(`ERROR: file not found: ${args.file_path}`);
      }
      buf = fs.readFileSync(args.file_path);
      label = `file: ${args.file_path}`;
    } else if (args.drive_file_id) {
      const auth = await getGoogleAuthClient();
      const drive = google.drive({ version: "v3", auth });
      const res = await drive.files.get(
        { fileId: args.drive_file_id, alt: "media" },
        { responseType: "arraybuffer" }
      );
      buf = Buffer.from(res.data as ArrayBuffer);
      label = `drive_file_id: ${args.drive_file_id}`;
    } else if (args.gmail_message_id && args.attachment_id) {
      const auth = await getGoogleAuthClient();
      const gmail = google.gmail({ version: "v1", auth });
      const att = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId: args.gmail_message_id,
        id: args.attachment_id,
      });
      if (!att.data.data) return ok("ERROR: gmail attachment has no data field");
      buf = Buffer.from(att.data.data, "base64url");
      label = `gmail msg ${args.gmail_message_id} attachment ${args.attachment_id}`;
    } else {
      return ok(
        "ERROR: pass exactly one of:\n" +
        "  - file_path (server-local path)\n" +
        "  - drive_file_id (Google Drive file ID)\n" +
        "  - gmail_message_id + attachment_id (Gmail attachment)"
      );
    }
  } catch (e: any) {
    return ok(`ERROR fetching PDF bytes: ${e?.message || e}`);
  }

  try {
    const result = await extractFromBuffer(buf!);
    const lines = [
      `Source:    ${result.source}`,
      `Pages:     ${result.num_pages}`,
      `From:      ${label}`,
      `Bytes:     ${buf!.length}`,
    ];

    // For OCR, surface average confidence so callers can decide whether to
    // trust critical fields (phone numbers, names) or warn the user.
    if (result.source === "ocr" && result.ocr_pages) {
      const confs = result.ocr_pages.map(p => p.confidence).filter((c): c is number => c !== null);
      if (confs.length > 0) {
        const avg = Math.round((confs.reduce((a, b) => a + b, 0) / confs.length) * 10) / 10;
        const min = Math.min(...confs);
        lines.push(`OCR conf:  avg=${avg}%, min=${min}% (per page: ${result.ocr_pages.map(p => p.confidence ?? "n/a").join(", ")})`);
        lines.push(`Caution:   OCR'd text — verify critical fields (phone, name spellings) against the source PDF before relying on them.`);
      }
    }
    if (args.page_range) {
      lines.push(`Note:      page_range "${args.page_range}" was passed but is ignored — full document returned (per-page extraction not yet supported).`);
    }
    lines.push("");
    lines.push("--- TEXT ---");
    lines.push(result.text || "(no text extracted)");
    if (result.warnings.length) {
      lines.push("");
      lines.push("--- WARNINGS ---");
      lines.push(...result.warnings.map(w => `- ${w}`));
    }
    return ok(lines.join("\n"));
  } catch (e: any) {
    return ok(`ERROR parsing PDF: ${e?.message || e}\nLikely an encrypted, malformed, or password-protected PDF.`);
  }
}

// One-call shortcut for the common "I have a Gmail message and want the text
// of one of its PDF attachments" pattern. Avoids forcing the caller to first
// list attachments to find the attachment_id.
export async function gmailAttachmentText(args: {
  message_id: string;
  attachment_filename: string;
}): Promise<CallToolResult> {
  let auth;
  try {
    auth = await getGoogleAuthClient();
  } catch (e: any) {
    return ok(`ERROR: Gmail auth failed: ${e?.message || e}`);
  }
  const gmail = google.gmail({ version: "v1", auth });

  let msg;
  try {
    msg = await gmail.users.messages.get({
      userId: "me",
      id: args.message_id,
      format: "full",
    });
  } catch (e: any) {
    return ok(`ERROR: could not fetch gmail message ${args.message_id}: ${e?.message || e}`);
  }

  // Walk the MIME tree to collect every attachment
  type Att = { filename: string; attachment_id: string; mime_type: string; size: number };
  const found: Att[] = [];
  function walk(p: any) {
    if (!p) return;
    if (p.filename && p.body?.attachmentId) {
      found.push({
        filename: p.filename,
        attachment_id: p.body.attachmentId,
        mime_type: p.mimeType || "application/octet-stream",
        size: Number(p.body?.size ?? 0),
      });
    }
    if (Array.isArray(p.parts)) for (const c of p.parts) walk(c);
  }
  walk((msg.data as any).payload);

  if (found.length === 0) {
    return ok(`No attachments found in message ${args.message_id}.`);
  }

  // Match strategy: exact filename first, then case-insensitive substring.
  // Substring lets the caller pass just "LossNotice" and match
  // "CLM_1226000099_LossNotice_415014795.pdf".
  const target = args.attachment_filename;
  let match = found.find(a => a.filename === target);
  if (!match) {
    const lower = target.toLowerCase();
    match = found.find(a => a.filename.toLowerCase().includes(lower));
  }
  if (!match) {
    return ok(
      `No attachment matching "${target}" in message ${args.message_id}.\n` +
      `Found ${found.length} attachment(s):\n` +
      found.map(a => `  - ${a.filename} (${a.mime_type}, ${(a.size / 1024).toFixed(1)} KB)`).join("\n")
    );
  }

  return extractPdfText({
    gmail_message_id: args.message_id,
    attachment_id: match.attachment_id,
  });
}
