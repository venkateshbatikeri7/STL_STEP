/**
 * Optional end-to-end smoke test against a real Chrome.
 *
 * Not part of `npm test`, because it needs a browser and a running preview
 * server:
 *
 *   npm i -D playwright-core
 *   npm run build && npm run preview -- --port 4173
 *   node scripts/browser-smoke.mjs
 *
 * Override the targets with BASE_URL and CHROME_PATH if needed.
 */
import { writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://localhost:4173";
const CHROME = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));

const step = (name) => console.log(`\n== ${name}`);

step("load page");
await page.goto(BASE, { waitUntil: "networkidle" });
console.log("title:", await page.title());
console.log("privacy note:", await page.locator(".privacy").innerText());

step("reject a corrupt file (right extension, wrong contents)");
await page.setInputFiles('input[type="file"]', "public/samples/corrupt.stl");
await page.waitForSelector(".alert--error", { timeout: 10000 });
console.log("title:", await page.locator(".alert__title").innerText());
console.log("detail:", await page.locator(".alert__detail").innerText());
await page.locator(".alert__dismiss").click();

step("load cube.stl");
await page.setInputFiles('input[type="file"]', "public/samples/cube.stl");
await page.waitForSelector(".stats", { timeout: 10000 });
const stats = await page.locator(".stats__item").allInnerTexts();
console.log(stats.join(" | "));
// The preview chunk is lazy, so wait for the renderer to actually mount.
await page.waitForSelector("canvas", { timeout: 20000 });
console.log("canvas:", await page.locator("canvas").count(), "element(s)");
console.log(
  "webgl rendered:",
  await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (canvas === null) return "no canvas";
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    return gl === null ? "context already taken (ok)" : "context ok";
  }),
);
await page.waitForTimeout(1200);

step("screenshot");
await page.screenshot({ path: "verify-output/screenshot-ready.png", fullPage: true });

step("convert (downloads the 22 MB engine on first run)");
const started = Date.now();
await page.getByRole("button", { name: "Convert to STEP" }).click();
await page.waitForSelector('a[download]', { timeout: 180_000 });
console.log("converted in", ((Date.now() - started) / 1000).toFixed(1), "s");
console.log("result:", (await page.locator(".result__meta").innerText()).replace(/\n/g, " "));
console.log("stats:", (await page.locator(".result__stats").innerText()).replace(/\n/g, " · "));

step("download the STEP bytes");
const bytes = await page.evaluate(async () => {
  const anchor = document.querySelector("a[download]");
  const buffer = await (await fetch(anchor.href)).arrayBuffer();
  return Array.from(new Uint8Array(buffer));
});
await writeFile("verify-output/browser-cube.step", Buffer.from(bytes));
const text = Buffer.from(bytes).toString("utf8");
console.log("bytes:", bytes.length);
console.log("header ok:", text.startsWith("ISO-10303-21;"));
console.log("footer ok:", text.trimEnd().endsWith("END-ISO-10303-21;"));
console.log("ADVANCED_FACE count:", (text.match(/ADVANCED_FACE\s*\(/g) ?? []).length);
console.log("CLOSED_SHELL count:", (text.match(/CLOSED_SHELL\s*\(/g) ?? []).length);
console.log("download filename:", await page.locator("a[download]").getAttribute("download"));

step("screenshot of the result");
await page.screenshot({ path: "verify-output/screenshot-done.png", fullPage: true });

step("inch units");
await page.getByRole("button", { name: "Convert another file" }).click();
await page.setInputFiles('input[type="file"]', "public/samples/cylinder.stl");
await page.waitForSelector(".stats", { timeout: 10000 });
await page.locator('input[name="output-unit"][value="inch"]').check();
await page.getByRole("button", { name: "Convert to STEP" }).click();
await page.waitForSelector('a[download]', { timeout: 180_000 });
const inchBytes = await page.evaluate(async () => {
  const anchor = document.querySelector("a[download]");
  const buffer = await (await fetch(anchor.href)).arrayBuffer();
  return Array.from(new Uint8Array(buffer));
});
const inchText = Buffer.from(inchBytes).toString("utf8");
await writeFile("verify-output/browser-cylinder-inch.step", Buffer.from(inchBytes));
console.log("bytes:", inchBytes.length);
console.log("declares INCH:", inchText.includes("CONVERSION_BASED_UNIT('INCH'"));
console.log("faces:", (inchText.match(/ADVANCED_FACE\s*\(/g) ?? []).length, "(expect 256)");
console.log("closed shell:", (inchText.match(/CLOSED_SHELL\s*\(/g) ?? []).length);

step("console errors");
console.log(consoleErrors.length === 0 ? "none" : consoleErrors.join("\n"));

await browser.close();