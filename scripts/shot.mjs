// Dev screenshot tool — renders the running dashboard in headless Chromium and
// captures PNGs so we can iterate on the visual restyle with evidence.
// Usage: node scripts/shot.mjs [url] [outdir]
//   url    default http://localhost:5173
//   outdir default ./.shots
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const url = process.argv[2] ?? "http://localhost:5173";
const outdir = process.argv[3] ?? ".shots";
mkdirSync(outdir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1024 }, deviceScaleFactor: 1 });
await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
// Let the overview poll fill in the project cards.
await page.waitForSelector(".card", { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(800);

// 1) full page
await page.screenshot({ path: join(outdir, "full.png"), fullPage: true });
// 2) just the cards grid (the Proyectos section)
const grid = await page.$(".proj-grid");
if (grid) await grid.screenshot({ path: join(outdir, "cards.png") });
// 3) a single card (the first) to inspect inner spacing
const card = await page.$(".card");
if (card) await card.screenshot({ path: join(outdir, "card.png") });

const cardCount = await page.$$eval(".card", (els) => els.length);
// report each card's rendered height so we can verify uniformity
const heights = await page.$$eval(".card", (els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
console.log(JSON.stringify({ url, cardCount, heights }));

await browser.close();
