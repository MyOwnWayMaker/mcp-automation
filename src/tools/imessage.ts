import { exec } from "child_process";
import { promisify } from "util";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const execAsync = promisify(exec);

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

// Escapes a string for use inside an AppleScript string literal
function escapeAppleScript(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export async function imessageSend(args: {
  recipient: string;
  message: string;
}): Promise<CallToolResult> {
  const { recipient, message } = args;
  const safeMsg = escapeAppleScript(message);
  const safeRecipient = escapeAppleScript(recipient);

  // Try iMessage first, fall back to SMS
  const script = `
    tell application "Messages"
      set targetService to 1st account whose service type = iMessage
      set targetBuddy to participant "${safeRecipient}" of targetService
      send "${safeMsg}" to targetBuddy
    end tell
  `.trim();

  try {
    await execAsync(`/usr/bin/osascript -e '${script}'`);
    return ok(`iMessage sent to ${recipient}`);
  } catch (err) {
    // Fallback: try SMS service
    const smsFallback = `
      tell application "Messages"
        send "${safeMsg}" to buddy "${safeRecipient}" of (1st service whose service type = SMS)
      end tell
    `.trim();
    try {
      await execAsync(`/usr/bin/osascript -e '${smsFallback}'`);
      return ok(`SMS sent to ${recipient}`);
    } catch (smsErr) {
      throw new Error(
        `Failed to send message to ${recipient}.\n` +
        `Make sure:\n` +
        `  1. You are running on macOS\n` +
        `  2. The Messages app is open and logged in to iMessage\n` +
        `  3. The recipient (phone number or email) is correct\n` +
        `Error: ${(smsErr as Error).message}`
      );
    }
  }
}

export async function imessageGetRecentChats(args: {
  max_results?: number;
}): Promise<CallToolResult> {
  const limit = args.max_results ?? 10;
  const script = `
    tell application "Messages"
      set chatList to {}
      repeat with i from 1 to ${limit}
        try
          set c to item i of (get every chat)
          set chatList to chatList & (name of c)
        end try
      end repeat
      return chatList
    end tell
  `.trim();

  try {
    const { stdout } = await execAsync(`/usr/bin/osascript -e '${script}'`);
    return ok(`Recent chats:\n${stdout.trim().split(", ").map((c, i) => `${i + 1}. ${c}`).join("\n")}`);
  } catch (err) {
    throw new Error(`Failed to get chats: ${(err as Error).message}`);
  }
}
