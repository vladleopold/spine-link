import { chromium } from "playwright";
const b = await chromium.launch({ channel: "chrome" });
const p = await b.newPage({ viewport: { width: 1280, height: 700 } });
for (const url of ["http://127.0.0.1:5173/spine-link.html", "http://127.0.0.1:5173/spine-library.html"]) {
  await p.goto(url, { waitUntil: "load" });
  await p.waitForTimeout(1200);
  const r = await p.evaluate(() => {
    const logo = document.querySelector("a.brand");
    if (!logo) return {есть:false};
    const spine = logo.querySelector(".brand-spine");
    const link = logo.querySelector(".brand-link-part");
    return {
      есть: true,
      текст: logo.textContent.trim(),
      spineЦвет: spine ? getComputedStyle(spine).color : null,
      linkЦвет: link ? getComputedStyle(link).color : null,
    };
  });
  console.log(url.split("/").pop(), JSON.stringify(r));
  // наведение
  const box = await p.evaluate(() => { const a=document.querySelector("a.brand"); const b=a.getBoundingClientRect(); return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)}; });
  await p.mouse.move(box.x, box.y);
  await p.waitForTimeout(600);
  const h = await p.evaluate(() => {
    const logo = document.querySelector("a.brand");
    const spine = logo.querySelector(".brand-spine");
    const link = logo.querySelector(".brand-link-part");
    return {spine: getComputedStyle(spine).color, link: getComputedStyle(link).color};
  });
  console.log("   при наведении:", JSON.stringify(h));
}
await b.close();
