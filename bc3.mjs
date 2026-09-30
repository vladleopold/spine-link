import { chromium } from "playwright";
import fs from "fs";
const files = fs.readdirSync("public").filter(f => f.endsWith(".html"));
const b = await chromium.launch({ channel: "chrome" });
let ok = 0, bad = [];
for (const f of files) {
  const html = fs.readFileSync("public/" + f, "utf8");
  if (!html.includes('class="brand-spine"')) continue;
  const p = await b.newPage({ viewport: { width: 1280, height: 700 } });
  await p.goto(`http://127.0.0.1:5174/${f}`, { waitUntil: "domcontentloaded" });
  await p.mouse.move(10, 400);
  await p.waitForTimeout(400);
  const norm = await p.evaluate(() => {
    const s=document.querySelector(".brand-spine"), l=document.querySelector(".brand-link-part");
    return s&&l ? {link:getComputedStyle(l).color} : null;
  });
  const box = await p.evaluate(()=>{const a=document.querySelector("a.brand");if(!a)return null;const b=a.getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)};});
  if (!box || !norm) { bad.push(f + " (нет логотипа)"); await p.close(); continue; }
  await p.mouse.move(box.x, box.y);
  await p.waitForTimeout(500);
  const hov = await p.evaluate(()=>getComputedStyle(document.querySelector(".brand-link-part")).color);
  const good = norm.link === "rgb(255, 106, 40)" && hov === "rgb(255, 255, 255)";
  good ? ok++ : bad.push(`${f} link=${norm.link}→${hov}`);
  await p.close();
}
console.log(`статических страниц с логотипом: ${ok} из ${ok+bad.length}`);
if (bad.length) console.log("неверные:", bad);
await b.close();
