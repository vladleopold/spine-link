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
