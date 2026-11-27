import test from 'node:test';
import assert from 'node:assert/strict';
import {selectSpineRuntimeSkeleton as select} from '../lib/spine-runtime-file-selection.js';

test('selects actual large Spine JSON when config.json is also uploaded',()=>{
 const files=[{name:'config.json',size:91},{name:'player-main.json',size:18980882},{name:'player-main.atlas'}];
 assert.equal(select(files,'player-main.atlas')?.name,'player-main.json');
});
test('prefers matching binary skeleton over unrelated JSON metadata',()=>{
 const files=[{name:'config.json'},{name:'cowgirl.skel'},{name:'doggy.skel'}];
 assert.equal(select(files,'doggy.atlas')?.name,'doggy.skel');
});
test('never treats lone config JSON as a runtime skeleton',()=>{
 assert.equal(select([{name:'config.json'}]),null);
});
test('supports single JSON with missing atlas as a recoverable import',()=>{
 assert.equal(select([{name:'boss_1.json'},{name:'boss_1.png'}])?.name,'boss_1.json');
});

test('prefers matching JSON skeleton over same-basename binary when Spine player requires JSON',()=>{
 const files=[{name:'hero.skel'},{name:'hero.json'},{name:'hero.atlas'},{name:'hero.png'}];
 assert.equal(select(files,'hero.atlas')?.name,'hero.json');
});

import {runtimeVersionOverrideForSpineSkeleton as runtimeOverride} from '../lib/spine-runtime-file-selection.js';

test('routes Spine 3.7 binary exports through the 4.3 conversion pipeline', () => {
 assert.equal(runtimeOverride('3.7.94', true), '4.3');
 assert.equal(runtimeOverride('3.7.94', false), '');
 assert.equal(runtimeOverride('3.8.99', true), '');
});
