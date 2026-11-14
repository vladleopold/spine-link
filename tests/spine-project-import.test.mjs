import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSpineProjectFile, normalizeProjectPath, validateProjectSelection,
  rememberProjectFilePath, readDroppedProjectEntries,
} from '../src/spine-project-import.js';

const fake = (name, webkitRelativePath='') => ({name,webkitRelativePath});
test('Spine editor project is source not runtime skeleton', () => {
  assert.equal(isSpineProjectFile(fake('hero.spine')),true);
  assert.equal(isSpineProjectFile(fake('hero.skel')),false);
});
test('images folder, nested textures, arbitrary selected root are preserved', () => {
  assert.equal(normalizeProjectPath(fake('body.png','images/character/body.png')),'images/character/body.png');
  assert.equal(normalizeProjectPath(fake('body.png','art/character/body.png')),'images/character/body.png');
  assert.equal(normalizeProjectPath(fake('body.png','body.png')),'images/body.png');
});
test('one source and images are required, duplicate destination files are rejected', () => {
  const source=fake('hero.spine'), image=fake('body.webp','images/body.webp');
  assert.deepEqual(validateProjectSelection([source,image]),[source,image]);
  assert.throws(()=>validateProjectSelection([source]),/images folder/);
  assert.throws(()=>validateProjectSelection([source,source,image]),/exactly one/);
  assert.throws(()=>validateProjectSelection([source,image,fake('body.webp','assets/body.webp')]),/Duplicate/);
});
test('directory traversal is rejected',()=>{
  assert.throws(()=>normalizeProjectPath(fake('tex.png'), 'images/../secret/tex.png'),/Invalid/);
});
test('recursive directory drop preserves tree and reads all reader pages', async()=>{
  const a=fake('torso.png'), b=fake('arm.png');
  const fileEntry=(name,file)=>({name,isFile:true,file(resolve){resolve(file)}});
  let pages=0;
  const folder={name:'images',isDirectory:true,createReader(){return {readEntries(resolve){
    resolve(pages++===0?[fileEntry('torso.png',a),
       {name:'sub',isDirectory:true,createReader(){let n=0;return{readEntries(done){done(n++===0?[fileEntry('arm.png',b)]:[])}}}}]:[]);
  }}}};
  const files=await readDroppedProjectEntries([folder]);
  assert.equal(files.length,2);
  assert.equal(normalizeProjectPath(a),'images/torso.png');
  assert.equal(normalizeProjectPath(b),'images/sub/arm.png');
});
test('remember original nested path for IndexedDB upload recovery',()=>{
  const f=fake('eye.png');
  rememberProjectFilePath(f,'images/skin/eye.png');
  assert.equal(normalizeProjectPath(f),'images/skin/eye.png');
});
