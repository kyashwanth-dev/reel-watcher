import dotenv from "dotenv";
dotenv.config();

import { IgApiClient } from "instagram-private-api";
import Anthropic from "@anthropic-ai/sdk";
import Database from "better-sqlite3";
import cron from "node-cron";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOT = path.resolve(__dirname, "..");
const DB_PATH = path.join(ROOT, "data", "reels.db");
const SESSION_PATH = path.join(ROOT, "data", "ig-session.json");

const REELS_TO_FETCH = parseInt(process.env.REELS_TO_FETCH || "5", 10);
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "0 */6 * * *";

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function initDB() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  const db = new Database(DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS reels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      watched_at TEXT,
      media_id TEXT UNIQUE,
      username TEXT,
      caption TEXT,
      summary TEXT,
      importance TEXT,
      category TEXT,
      plays INTEGER,
      likes INTEGER
    )
  `);

  return db;
}

async function saveSession(ig) {
  const state = await ig.exportState();

  fs.mkdirSync(path.dirname(SESSION_PATH), { recursive: true });

  fs.writeFileSync(SESSION_PATH, JSON.stringify(state));
}

async function login(ig) {
  ig.state.generateDevice(process.env.IG_USERNAME);

  if (fs.existsSync(SESSION_PATH)) {
    try {
      log("Restoring Instagram session...");

      const session = JSON.parse(fs.readFileSync(SESSION_PATH, "utf8"));

      await ig.importState(session);
      await ig.account.currentUser();

      log("Session restored successfully");
      return;
    } catch (e) {
      log("Session invalid, logging in again...");
    }
  }

  log("Logging into Instagram...");

  await ig.simulate.preLoginFlow();

  await ig.account.login(
    process.env.IG_USERNAME,
    process.env.IG_PASSWORD
  );

  await ig.simulate.postLoginFlow();

  await saveSession(ig);

  log("Instagram login successful");
}

function extractReel(media) {
  return {
    media_id: media.id,
    username: media.user?.username || "unknown",
    caption: media.caption?.text || "",
    plays: media.play_count || 0,
    likes: media.like_count || 0,
    video_url: media.video_versions?.[0]?.url || null,
  };
}

async function fetchReels(ig) {
  const feed = ig.feed.topicalExplore();

  const items = await feed.items();

  const reels = [];

  for (const item of items) {
    for (const media of item.layout_content?.medias || []) {
      if (media.media?.media_type === 2) {
        reels.push(extractReel(media.media));
      }

      if (reels.length >= REELS_TO_FETCH) {
        return reels;
      }
    }
  }

  return reels;
}

async function summarize(client, reel) {
  try {
    const response = await client.messages.create({
      model: "claude-3-7-sonnet-latest",
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: `
Summarize this Instagram reel briefly.

Caption: ${reel.caption}
Plays: ${reel.plays}
Likes: ${reel.likes}

Return JSON only:
{
  "summary": "short summary",
  "importance": "low|medium|high",
  "category": "topic"
}
`,
        },
      ],
    });

    return JSON.parse(response.content[0].text);
  } catch (e) {
    return {
      summary: reel.caption.slice(0, 120),
      importance: "low",
      category: "other",
    };
  }
}

async function runWatcher() {
  const db = initDB();

  const ig = new IgApiClient();

  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  try {
    await login(ig);

    log("Fetching reels...");

    const reels = await fetchReels(ig);

    log(`Fetched ${reels.length} reels`);

    for (const reel of reels) {
      log(`Processing @${reel.username}`);

      const ai = await summarize(anthropic, reel);

      db.prepare(`
        INSERT OR IGNORE INTO reels (
          watched_at,
          media_id,
          username,
          caption,
          summary,
          importance,
          category,
          plays,
          likes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        new Date().toISOString(),
        reel.media_id,
        reel.username,
        reel.caption,
        ai.summary,
        ai.importance,
        ai.category,
        reel.plays,
        reel.likes
      );

      log(`Saved reel from @${reel.username}`);

      await sleep(3000);
    }

    await saveSession(ig);

    log("Completed successfully");
  } catch (e) {
    log("ERROR:", e.message);
  } finally {
    db.close();
  }
}

if (process.argv.includes("--now")) {
  runWatcher();
} else {
  log(`Scheduler running: ${CRON_SCHEDULE}`);

  cron.schedule(CRON_SCHEDULE, () => {
    runWatcher();
  });
}