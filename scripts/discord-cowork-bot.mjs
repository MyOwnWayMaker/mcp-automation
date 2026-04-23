/**
 * Discord bot — backup channel for Claude Cowork when Dispatch is unavailable.
 *
 * How it works:
 *   1. You send a message in the designated Discord channel (DM or #cowork-tasks)
 *   2. Bot writes it to code_inbox.md and runs Claude Code
 *   3. Bot replies with the response from code_outbox.md
 *
 * Setup:
 *   1. Go to https://discord.com/developers/applications → New Application → Bot
 *   2. Copy the bot token → DISCORD_BOT_TOKEN in .env
 *   3. Copy your user ID (Settings → Advanced → Developer Mode → right-click yourself) → DISCORD_OWNER_ID in .env
 *   4. Optionally set DISCORD_CHANNEL_ID to lock to one channel
 *   5. Invite bot to your server with Send Messages + Read Message History permissions
 *   6. Run: node scripts/discord-cowork-bot.mjs
 *
 * The bot only responds to messages from DISCORD_OWNER_ID (you).
 * It runs Claude Code via CLI and streams the output back.
 *
 * Run as a service: launchctl load ~/Library/LaunchAgents/com.cowork.discord-bot.plist
 */

import { Client, GatewayIntentBits, Events } from "discord.js";
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: "/Users/hakielmcqueen/mcp-automation/.env" });

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_OWNER_ID  = process.env.DISCORD_OWNER_ID;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID; // optional: restrict to one channel

const COMM_DIR  = path.join(process.env.HOME, "Desktop/Dispatch and Claude Communication");
const INBOX     = path.join(COMM_DIR, "code_inbox.md");
const OUTBOX    = path.join(COMM_DIR, "code_outbox.md");
const CLAUDE    = "/usr/local/bin/claude"; // adjust if needed

if (!DISCORD_BOT_TOKEN || !DISCORD_OWNER_ID) {
  console.error("Missing DISCORD_BOT_TOKEN or DISCORD_OWNER_ID in .env");
  console.error("See setup instructions at the top of this file.");
  process.exit(1);
}

// Read outbox, return only the NEWEST entry (everything after the last "---" separator or full file)
function readLatestOutbox() {
  if (!fs.existsSync(OUTBOX)) return "(No response yet — outbox is empty)";
  const content = fs.readFileSync(OUTBOX, "utf-8").trim();
  // Split on horizontal rules or double newlines to get the last entry
  const parts = content.split(/\n---\n|\n====+\n/);
  return parts[parts.length - 1].trim() || content;
}

function getOutboxMtime() {
  if (!fs.existsSync(OUTBOX)) return 0;
  return fs.statSync(OUTBOX).mtimeMs;
}

async function runClaudeCode(task) {
  const prompt = `You have a new task from Hakiel via Discord (Dispatch is unavailable):\n\n${task}\n\nComplete the task, write your response to code_outbox.md, and sync it to Google Drive as usual.`;

  return new Promise((resolve) => {
    const proc = execFile(
      CLAUDE,
      ["--print", "--dangerously-skip-permissions", prompt],
      { cwd: "/Users/hakielmcqueen/mcp-automation", timeout: 300000 },
      (err, stdout, stderr) => {
        if (err) {
          resolve(`Error running Claude Code: ${err.message}\n\nStderr: ${stderr?.slice(0, 500)}`);
        } else {
          resolve(stdout?.trim() || "(Claude Code ran but produced no output)");
        }
      }
    );
    proc.stdout?.on("data", (d) => process.stdout.write(d));
  });
}

// Split long messages for Discord's 2000-char limit
function splitMessage(text, maxLen = 1900) {
  const chunks = [];
  while (text.length > 0) {
    chunks.push(text.slice(0, maxLen));
    text = text.slice(maxLen);
  }
  return chunks;
}

// ── Bot setup ─────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Discord Cowork Bot ready — logged in as ${c.user.tag}`);
  console.log(`Only responding to owner ID: ${DISCORD_OWNER_ID}`);
  if (DISCORD_CHANNEL_ID) console.log(`Restricted to channel: ${DISCORD_CHANNEL_ID}`);
});

client.on(Events.MessageCreate, async (message) => {
  // Ignore bots
  if (message.author.bot) return;

  // Only respond to owner
  if (message.author.id !== DISCORD_OWNER_ID) return;

  // Optionally restrict to one channel
  if (DISCORD_CHANNEL_ID && message.channelId !== DISCORD_CHANNEL_ID) return;

  const task = message.content.trim();
  if (!task) return;

  // Commands
  if (task.toLowerCase() === "!status") {
    const outbox = readLatestOutbox();
    for (const chunk of splitMessage(`**Latest outbox entry:**\n${outbox}`)) {
      await message.reply(chunk);
    }
    return;
  }

  if (task.toLowerCase() === "!ping") {
    await message.reply("Claude Cowork bot is online and ready.");
    return;
  }

  console.log(`\n[${new Date().toISOString()}] Task from Discord: ${task.slice(0, 100)}`);
  await message.react("⏳");

  // Write to inbox
  const inboxEntry = `## Task from Discord — ${new Date().toLocaleString()}\n\n${task}\n\n---\n`;
  fs.appendFileSync(INBOX, inboxEntry, "utf-8");

  const outboxBefore = getOutboxMtime();

  try {
    // Run Claude Code
    await message.reply("Got it — running Claude Code now. I'll reply when done.");
    await runClaudeCode(task);

    // Check if outbox was updated
    const outboxAfter = getOutboxMtime();
    if (outboxAfter > outboxBefore) {
      const response = readLatestOutbox();
      for (const chunk of splitMessage(response)) {
        await message.reply(chunk);
      }
    } else {
      await message.reply("Claude Code ran. Check Code Outbox on Google Drive for the full response.");
    }

    await message.react("✅");
  } catch (err) {
    await message.reply(`Something went wrong: ${err.message}`);
    await message.react("❌");
  }
});

client.login(DISCORD_BOT_TOKEN);
