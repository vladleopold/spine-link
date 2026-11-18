import assert from "node:assert/strict";
import { imageMatchesAtlasPage, matchingAtlasForSkeleton } from "../api/github-preview.js";

assert.equal(matchingAtlasForSkeleton("Werewolf Cowgirl.skel",
  ["Werewolf Doggy.atlas","Werewolf Cowgirl.atlas"]), "Werewolf Cowgirl.atlas");
assert.equal(matchingAtlasForSkeleton("titan.skel",["titan.atlas"]),"titan.atlas");
assert.equal(matchingAtlasForSkeleton("titan.skel",
  ["Wrong.atlas","Another.atlas"]),null);
assert.equal(imageMatchesAtlasPage("basic_titan_dxt5.png","basic_titan_dxt5.dds"),true);
assert.equal(imageMatchesAtlasPage("unrelated.png","basic_titan_dxt5.dds"),false);
assert.equal(imageMatchesAtlasPage("Wolf Pack_21.png","Wolf Pack_21.png"),true);
assert.equal(imageMatchesAtlasPage("hero.png","../textures/hero.png"),true);
console.log("PASS multi-atlas Climax / DDS-to-PNG exact texture matching");
