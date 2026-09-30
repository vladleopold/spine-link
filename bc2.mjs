import { chromium } from "playwright";
const b = await chromium.launch({ channel: "chrome" });
for (const url of ["http://127.0.0.1:5174/spine-library.html", "http://127.0.0.1:5174/spine-animations.html", "http://127.0.0.1:5174/spne-lib.html"]) {
  const p = await b.newPage({ viewport: { width: 1280, height: 700 } });
  await p.goto(url, { waitUntil: "load" });
  await p.mouse.move(10, 400);   // курсор далеко от логотипа
  await p.waitForTimeout(800);
  const norm = await p.evaluate(() => {
    const s = document.querySelector(".brand-spine"), l = document.querySelector(".brand-link-part");
    return s && l ? {spine:getComputedStyle(s).color, link:getComputedStyle(l).color} : null;
  });
  const box = await p.evaluate(()=>{const a=document.querySelector("a.brand");const b=a.getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)};});
  await p.mouse.move(box.x, box.y);
  await p.waitForTimeout(700);
  const hov = await p.evaluate(() => {
    const s = document.querySelector(".brand-spine"), l = document.querySelector(".brand-link-part");
    return {spine:getComputedStyle(s).color, link:getComputedStyle(l).color};
  });
  const ok = norm.link === "rgb(255, 106, 40)" && hov.link === "rgb(255, 255, 255)";
  console.log(`${url.split("/").pop().padEnd(24)} обычный=${norm.link}  наведение=${hov.link}  ${ok?"✓":"✗"}`);
  await p.close();
}
await b.close();
