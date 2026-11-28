import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../api/github-preview.js", import.meta.url), "utf8");

test("phone player height is reduced independently of desktop player sizing", () => {
  assert.match(source, /@media\s*\(max-width:\s*700px\)/);
  assert.match(source, /\.player-frame\s*\{[^}]*height:\s*clamp\(/s);
  assert.match(source, /#player\s*\{[^}]*min-height:\s*0\s*!important/s);
});

test("mobile player appears before the animation picker and its first control", () => {
  const mobile = source.slice(
    source.indexOf("@media (max-width: 700px)"),
    source.indexOf("@media (min-width: 1001px)")
  );
  assert.match(mobile, /\.player-frame\s*\{[^}]*order:\s*1\s*!important/s);
  assert.match(mobile, /#sidebar\s*>\s*#animation-card\s*\{\s*order:\s*2\s*!important/s);
  assert.match(mobile, /#sidebar\s*>\s*\.preview-video-card\s*\{\s*order:\s*3\s*!important/s);
  assert.match(mobile, /#sidebar\s*>\s*\.animation-download-block\s*\{\s*order:\s*4\s*!important/s);
});

test("desktop owner sidebar shows at most seven other user video works in two columns", () => {
  assert.match(source, /ownerEntries[\s\S]*?item\?\.id[\s\S]*?entry\?\.id/);
  assert.match(source, /library:\s*ownerLibraryItems\.slice\(0,\s*7\)/);
  assert.match(source, /visibleItems\s*=\s*items\.slice\(0,\s*7\)/);
  assert.match(source, /\.filter\(\(item\)\s*=>\s*item\.webmPreview\)/);
  assert.match(source, /\.owner-library\.is-visible\s*\{[^}]*grid-template-columns:\s*repeat\(2,/s);
  assert.match(source, /#sidebar\s*>\s*#owner-library\s*\{\s*order:\s*4/);
  assert.match(source, /Other animations by this user/);
});

test("legacy entries show the owner library by default but explicit privacy opt-out is respected", () => {
  assert.match(source, /if\s*\(entry\?\.showOwnerLibrary\s*!==\s*false\)/);
  assert.match(source, /sameOwner\s*&&\s*item\?\.showOwnerLibrary\s*!==\s*false/);
});

test("owner preview videos autoplay in a loop only while intersecting the viewport", () => {
  const observer = source.slice(source.indexOf("function installOwnerLibraryChaos()"), source.indexOf("// Кадр зафиксирован"));
  assert.match(observer, /IntersectionObserver/);
  assert.match(observer, /entry\.isIntersecting/);
  assert.match(observer, /playOwnerThumb\(video\)/);
  assert.match(observer, /stopOwnerThumb\(video\)/);
  assert.doesNotMatch(observer, /runChaos|Math\.random/);
});
