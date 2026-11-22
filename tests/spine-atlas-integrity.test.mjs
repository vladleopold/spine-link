import test from 'node:test';
import assert from 'node:assert/strict';
import {isValidSpineAtlasHeader} from '../lib/spine-atlas-integrity.js';
test('valid Spine 3.x and 4.x atlas page headers accepted',()=>{
 assert.equal(isValidSpineAtlasHeader('hero.png\nsize:2048,2048\nfilter:Linear,Linear\npma:true\nhero\nbounds:0,0,5,5'),true);
 assert.equal(isValidSpineAtlasHeader('hero.png\nsize:2048,2048\nformat:RGBA8888\nfilter:Linear,Linear\nrepeat:none'),true);
});
test('binary mislabeled atlas and metadata rejected',()=>{
 assert.equal(isValidSpineAtlasHeader('\\u001dKNPO>FjJS+9G\\u0005\\u000b\\u0018'),false);
 assert.equal(isValidSpineAtlasHeader('{\"defaultSkin\":\"Lamb\"}'),false);
 assert.equal(isValidSpineAtlasHeader(''),false);
});

test('every atlas page must map to one exact distinct source texture', async () => {
 const {matchAtlasPagesToTextures}=await import('../lib/spine-atlas-integrity.js');
 const textures=['body.png','face.png'];
 const exact=(texture,page)=>texture.toLowerCase()===page.toLowerCase();
 assert.deepEqual(matchAtlasPagesToTextures(['body.png','face.png'],textures,exact),textures);
 assert.equal(matchAtlasPagesToTextures(['body.png','missing.png'],textures,exact),null);
 assert.equal(matchAtlasPagesToTextures(['body.png','body.png'],textures,exact),null,
   'one texture must not silently stand in for two atlas pages');
 assert.equal(matchAtlasPagesToTextures(['body.png'],['body.png','BODY.PNG'],exact),null,
   'ambiguous case-insensitive matches must be blocked');
 assert.equal(matchAtlasPagesToTextures([],textures,exact),null);
});

test('preview runtime never injects a transparent placeholder for an unmatched atlas page', async () => {
 const {readFileSync}=await import('node:fs');
 const source=readFileSync(new URL('../api/github-preview.js',import.meta.url),'utf8');
 assert.match(source,/matchAtlasPagesToTextures\(\s*atlasPages,\s*textures,/);
 assert.match(source,/SPINE_ATLAS_TEXTURE_SET_INCOMPLETE/);
 assert.doesNotMatch(source,/data:image\/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB/);
});

test('manual Spine import blocks incomplete or ambiguous atlas textures instead of inventing transparent pages', async () => {
 const {readFileSync}=await import('node:fs');
 const source=readFileSync(new URL('../src/SpineApp.tsx',import.meta.url),'utf8');
 assert.match(source,/matchAtlasPagesToTextures\\(\\s*atlasPages,\\s*images,/);
 assert.match(source,/SPINE_ATLAS_TEXTURE_SET_INCOMPLETE/);
 assert.match(source,/const matchedImage = textureMatches\\[pageIndex\\]/);
 assert.match(source,/imageBase === pageBase/);
 assert.doesNotMatch(source,/transparentPngDataUri/);
});
