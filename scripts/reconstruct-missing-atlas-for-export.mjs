#!/usr/bin/env node
// Recover a missing atlas for the native CI WebM export path.
// Ambiguous geometry is rejected using the same confidence gate as browser import.
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { reconstructAtlas } from '../lib/atlas-inference.js';
import { assertAtlasInferenceUsable } from '../lib/atlas-inference-acceptance.js';
import { entryForUpload } from './resolve-library.mjs';

const id = process.argv.find(a => a.startsWith('--upload-id='))?.slice(12);
if (!id || !/^[\w.-]+$/.test(id)) throw new Error('Invalid upload id');
const root = process.cwd();
const found = entryForUpload(root,id);
if (!found) throw new Error('Upload not found: '+id);
const folder = path.resolve(root, found.entry.previewPath || path.posix.join(found.basePath,id));
const dirs = (await fs.readdir(folder,{withFileTypes:true})).filter(x=>x.isDirectory()).map(x=>path.join(folder,x.name));
let recovered = 0;
let browser;
try {
  for (const dir of dirs) {
    const files = await fs.readdir(dir);
    const skeleton = files.find(x=>/\.json$/i.test(x));
    const imageNames = files.filter(x=>/\.(png|jpe?g|webp)$/i.test(x));
    if (!skeleton || !imageNames.length || files.some(x=>/\.atlas(?:\.txt|\.docx)?$/i.test(x))) continue;
    const json = JSON.parse(await fs.readFile(path.join(dir,skeleton),'utf8'));
    browser ||= await chromium.launch({headless:true});
    const page = await browser.newPage();
    try {
      const images = [];
      for (const name of imageNames) {
        const bytes = await fs.readFile(path.join(dir,name));
        const type = /\.png$/i.test(name)?'image/png':/\.webp$/i.test(name)?'image/webp':'image/jpeg';
        const decoded = await page.evaluate(async ({b64,type})=>{
          const image = new Image();
          image.src='data:'+type+';base64,'+b64;
          await image.decode();
          const canvas=document.createElement('canvas');
          canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
          const ctx=canvas.getContext('2d',{willReadFrequently:true});
          ctx.drawImage(image,0,0);
          return {width:canvas.width,height:canvas.height,rgba:Array.from(ctx.getImageData(0,0,canvas.width,canvas.height).data)};
        },{b64:bytes.toString('base64'),type});
        images.push({name,width:decoded.width,height:decoded.height,rgba:new Uint8ClampedArray(decoded.rgba)});
      }
      const inferred=reconstructAtlas(json,images);
      const matchRatio=assertAtlasInferenceUsable(inferred);
      const target=path.join(dir,path.parse(skeleton).name+'.atlas');
      await fs.writeFile(target,inferred.text,'utf8');
      // Keep the receipt beside the set directory: export scripts scan inside the set for the first *.json skeleton.
      await fs.writeFile(path.join(folder,path.basename(dir)+'-atlas-inference-receipt.json'),JSON.stringify({
        kind:inferred.kind,confidence:inferred.confidence,coverage:inferred.coverage,
        matched:inferred.matched,total:inferred.total,matchRatio:Number(matchRatio.toFixed(4)),
        previewOnly:Boolean(inferred.inferred),source:'reconstructed-from-json-and-images'
      },null,2));
      console.log(
        'Reconstructed missing atlas:',target,
        'confidence',inferred.confidence,
        'coverage',inferred.coverage,
        'matched',inferred.matched+'/'+inferred.total
      );
      recovered++;
    } finally {await page.close();}
  }
} finally {if(browser)await browser.close();}
console.log('Recovered atlases:',recovered);
