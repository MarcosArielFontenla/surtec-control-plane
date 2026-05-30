// Generic full-page screenshot tool (for reference designs like the Boreal landing).
// Usage: node scripts/shot-page.mjs <url> [outfile] [waitSelector]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const url = process.argv[2];
const out = process.argv[3] ?? ".shots/page.png";
const waitSel = process.argv[4] ?? "#root > *";
mkdirSync(dirname(out), { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
await page.waitForSelector(waitSel, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(1800); // let in-browser Babel/React finish
await page.screenshot({ path: out, fullPage: true });
console.log("saved", out);
await browser.close();
