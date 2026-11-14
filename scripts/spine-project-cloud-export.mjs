#!/usr/bin/env node
// Runs ONLY inside the storage repository's authorized GitHub Actions worker.
// Does not parse .spine with a runtime or pretend a project is a .skel export.
// A licensed, initialized Spine Editor 4.3.26 CLI is required for conversion.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const eventPath = process.env.GITHUB_EVENT_PATH;
const event = eventPath ? JSON.parse(await fs.readFile(eventPath, 'utf8')) : {};
const payload = event.client_payload || {};
const uploadId = String(payload.uploadId || '');
const uploadPath = String(payload.uploadPath || '');
const projectFile = String(payload.projectFile || '');
const token = String(process.env.GITHUB_TOKEN || '');
const repo = String(process.env.GITHUB_REPOSITORY || 'vladleopold/spine');
const root = process.env.GITHUB_WORKSPACE || process.cwd();
const cli = String(process.env.SPINE_CLI || '');
if (!token || !/^[\w.-]{3,180}$/.test(uploadId) ||
    !/^library(?:_\d+)?\/[\w.-]{3,180}$/.test(uploadPath) ||
    uploadPath.split('/').at(-1) !== uploadId ||
    !/^[^/\\]+\.spine$/i.test(projectFile)) {
  throw new Error('Invalid Spine export job payload');
}
const folder = path.resolve(root, uploadPath);
const project = path.resolve(folder, projectFile);
const images = path.resolve(folder, 'images');
const indexPath = uploadPath.split('/')[0] + '/index.json';
if (!project.startsWith(folder + path.sep) || !images.startsWith(folder + path.sep)) {
  throw new Error('Unsafe Spine project location');
}

const apiRoot = 'https://api.github.com/repos/' + repo;
async function api(method, url, body) {
  const response = await fetch(apiRoot + url, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error('GitHub ' + method + ' ' + url + ': ' + response.status + ' ' + String(data.message || '').slice(0,100));
    error.status = response.status;
    throw error;
  }
  return data;
}
async function indexFromHead() {
  const response = await api('GET', '/contents/' + indexPath + '?ref=main');
  const blob = response.sha && await api('GET', '/git/blobs/' + response.sha);
  const items = blob?.content ? JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8')) : [];
  if (!Array.isArray(items)) throw new Error('Invalid storage index');
  const idx = items.findIndex(item => item?.id === uploadId);
  if (idx < 0 || items[idx]?.sourceKind !== 'spine-project' ||
      items[idx]?.projectFile !== projectFile ||
      items[idx]?.previewPath !== uploadPath) {
    throw new Error('Project not present in authorized storage index');
  }
  return {items,idx};
}
let status = 'ready', errorMessage = '';
let exported = [];
const projectExists = await fs.stat(project).then(s => s.isFile()).catch(() => false);
const imagesExist = await fs.stat(images).then(s => s.isDirectory()).catch(() => false);
if (!projectExists || !imagesExist) {
  status = 'failed'; errorMessage = 'Missing stored project or images folder';
} else if (!cli || !await fs.stat(cli).then(s=>s.isFile()).catch(()=>false)) {
  status = 'needs-editor'; errorMessage = 'Licensed Spine Editor 4.3.26 cloud exporter is not configured';
} else {
  const result = spawnSync(cli, ['--update','4.3.26','--input',project,'--output',folder,'--export','json+pack'], {
    timeout: 180000, encoding:'utf8', maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) {
    status = 'failed';
    errorMessage = 'Spine Editor CLI export failed, exit ' + String(result.status ?? 'timeout');
    console.error(errorMessage, String(result.stderr || '').slice(-1600));
  } else {
    const entries = await fs.readdir(folder, {withFileTypes:true});
    exported = entries.filter(item => item.isFile() && /\.(json|skel|atlas|png|jpe?g|webp)$/i.test(item.name))
      .map(item => item.name)
      .filter(name => name !== 'source-proof.json');
    if (!exported.some(name=>/\.(json|skel)$/i.test(name)) ||
        !exported.some(name=>/\.atlas$/i.test(name)) ||
        !exported.some(name=>/\.(png|jpe?g|webp)$/i.test(name))) {
      status = 'failed'; errorMessage = 'Editor returned no complete runtime JSON/atlas/texture output';
      exported = [];
    }
  }
}
console.log('Spine project conversion status:', status, 'files:', exported.length);
const writes = [];
if (status === 'ready') {
  for (const name of exported) {
    const buffer = await fs.readFile(path.join(folder, name));
    const blob = await api('POST', '/git/blobs', { content: buffer.toString('base64'), encoding: 'base64' });
    writes.push({ path: uploadPath + '/' + name, mode:'100644', type:'blob', sha:blob.sha });
  }
}
let committed = false;
for (let attempt=0;attempt<7;attempt++) {
  const {items,idx} = await indexFromHead();
  const existing = items[idx];
  // A duplicate delivery cannot roll a successfully exported work backwards.
  if (existing?.conversionStatus === 'ready') { committed=true; status='ready'; break; }
  const skeleton = exported.find(name => /\.(json|skel)$/i.test(name)) || '';
  const atlas = exported.find(name => /\.atlas$/i.test(name)) || '';
  const textures = exported.filter(name => /\.(png|jpe?g|webp)$/i.test(name));
  let animations = [];
  if (skeleton.endsWith('.json')) {
    try {
      const data = JSON.parse(await fs.readFile(path.join(folder,skeleton),'utf8'));
      animations = Object.keys(data.animations || {});
    } catch {}
  }
  items[idx] = {
    ...existing,
    conversionStatus:status,
    conversionError:errorMessage,
    ...(status === 'ready' ? {
      files:[...new Set([...(existing.files || []),...exported])],
      skeleton,atlas,textures,animations,
      defaultAnimation:animations[0] || '',
      webmStatus:'pending',dispatchStatus:'pending',
    }:{}),
  };
  const indexBlob=await api('POST','/git/blobs',{
    content:Buffer.from(JSON.stringify(items,null,2)).toString('base64'),encoding:'base64',
  });
  const ref=await api('GET','/git/refs/heads/main');
  const head=String(ref?.object?.sha || '');
  const commit=await api('GET','/git/commits/'+head);
  const tree=await api('POST','/git/trees',{
    base_tree:commit.tree.sha,
    tree:[...writes,{path:indexPath,mode:'100644',type:'blob',sha:indexBlob.sha}],
  });
  const next=await api('POST','/git/commits',{
    message:'Spine project editor export: '+uploadId+' ('+status+')',
    tree:tree.sha, parents:[head],
  });
  try {
    await api('PATCH','/git/refs/heads/main',{sha:next.sha,force:false});
    committed=true;
    console.log('Stored conversion status at commit:',next.sha);
    break;
  } catch (error) {
    if (![409,422].includes(error.status) || attempt===6) throw error;
  }
}
if (!committed) throw new Error('Could not update project conversion status');
if (status === 'ready') {
  try {
    await api('POST','/dispatches',{
      event_type:'spine-export-webm',client_payload:{
        uploadId,animation:'',animations:[],origin:String(payload.origin||''),
        owner:repo.split('/')[0],repo:repo.split('/')[1],branch:'main',
      },
    });
  } catch(error) {console.warn('Video export dispatch failed:',String(error));}
}
