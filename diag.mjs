import { chromium } from 'playwright';
const b=await chromium.launch({channel:'chrome'});
const p=await b.newPage({viewport:{width:800,height:600}}); await p.goto('https://spine-link.vercel.app/',{waitUntil:'domcontentloaded',timeout:60000});
const r=await p.evaluate(async ()=>{
  const g=async(u)=>{ const res=await fetch(u); return {status:res.status, body:(await res.text()).slice(0,90)}; };
  return {
    ex: await g('/assets/library/archive-exclusions.json'),
    cens: await g('/assets/library/censorship.json'),
  };
});
console.log(JSON.stringify(r,null,1));
await b.close();
