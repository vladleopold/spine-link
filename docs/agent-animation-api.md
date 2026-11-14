# Spine-Link Agent API v1

Server-to-server integration for 2Spine, 3Spine, an animation generator, CI, or another service. Published files create an ordinary Spine-Link player page.

Endpoint: https://spine-link.vercel.app/api/agent-animation

## Configuration

Set **SPINE_LINK_AGENT_API_KEY** as an encrypted/sensitive production environment variable in the spine-link Vercel project. Generate at least 32 unpredictable bytes (for example, 64 hex characters). Keep GITHUB_TOKEN and optional GITHUB_OWNER / GITHUB_REPO / GITHUB_BRANCH configured as for the existing uploader.

The API returns HTTP 503 until a strong agent key is configured. Do not commit the key, put it in frontend JavaScript, or send it in a URL.

All requests must include the HTTP header:

    Authorization: Bearer <SPINE_LINK_AGENT_API_KEY>

Responses are JSON. No cross-origin CORS is enabled. Only an agent backend, server or CI should use the API. The key is a privileged write key for the storage repository, so revoke/rotate it when compromised.

## Supported input formats

**runtime**: an exported Spine 4.3 JSON/SKEL skeleton, one .atlas (or .atlas.txt), and atlas texture images. The page is playable when completed; WebM preview rendering can continue asynchronously. Spine JSON must declare an animation and be compatible with player 4.3.

**spine-project**: exactly one source .spine file at upload root and images inside images/. The permanent page is created immediately; the private 3Spine-core Ubuntu Spine Editor 4.3.26 workflow exports the playable JSON/atlas/textures. API state is processing until that conversion finishes.

## Direct CLI integration

Use Node.js 20+.

    SPINE_LINK_AGENT_API_KEY="$KEY" node scripts/spine-link-agent-publish.mjs ./export --format runtime --title "Robot walk" --wait

Or for a source project directory:

    SPINE_LINK_AGENT_API_KEY="$KEY" node scripts/spine-link-agent-publish.mjs ./project --format spine-project --title "Robot walk" --wait

The CLI prints machine-readable JSON containing id, pageUrl, state, animations. Omit --wait to return as soon as files are committed. New agent pages are unlisted by default; --public opts into archive listing.

## REST workflow

### 1. Create a job

POST /api/agent-animation

~~~json
{"action":"create","title":"Robot walk","format":"runtime"}
~~~

HTTP 201 response includes id, jobToken, uploadPath, pageUrl, stageMaxBase64Chars=3000000 and expiresAt. The signed jobToken binds the generated ID, file format, target library collection and title.

### 2. Stage each file or chunk

POST /api/agent-animation

~~~json
{"action":"stage","jobToken":"<signed job token>","name":"character.json","contentBase64":"<standard Base64 bytes>"}
~~~

Each response returns a receipt with name, path, sha, bytes, sha256, signature. Store the complete receipt. A single stage supports up to 3,000,000 Base64 characters (roughly 2.25 MB binary). Split larger files into ordered chunks with the **same** file name, collect one receipt per chunk, and preserve order. A staged blob is not yet visible in the site library.

### 2a. Stage up to 8 small independent files in one request

For an atlas with many small texture images, use the batch operation rather than making one HTTP request per texture. The combined Base64 payload must be at most 3,000,000 characters. Each filename must be distinct.

~~~json
{
  "action":"stage-batch",
  "jobToken":"<signed job token>",
  "files":[
    {"name":"actor.json","contentBase64":"<base64>"},
    {"name":"actor.atlas","contentBase64":"<base64>"},
    {"name":"actor.png","contentBase64":"<base64>"}
  ]
}
~~~

HTTP 201 returns `{"ok":true,"receipts":[...]}` with each receipt signed as in the single-file stage operation. The CLI automatically batches small images and falls back to multipart stage for large files.

### 3. Publish all staged files atomically

POST /api/agent-animation

~~~json
{
  "action": "complete",
  "jobToken": "<signed job token>",
  "files": [
    {"name":"character.json","path":"...","sha":"...","bytes":1234,"sha256":"...","signature":"..."},
    {"name":"character.atlas","path":"...","sha":"...","bytes":123,"sha256":"...","signature":"..."},
    {"name":"character.png","path":"...","sha":"...","bytes":3456,"sha256":"...","signature":"..."}
  ],
  "assemblies": [],
  "defaultAnimation": "walk",
  "agentName": "2Spine",
  "public": false
}
~~~

For multipart files, use assemblies of the shape:

~~~json
{"name":"large.json","parts":[{"name":"large.json","path":"...","sha":"...","bytes":123,"sha256":"...","signature":"..."},{"name":"large.json","path":"...","sha":"...","bytes":123,"sha256":"...","signature":"..."}]}
~~~

Put unsplit receipts in files and split files in assemblies. The response contains pageUrl, initial state, animations, conversionStatus, dispatchStatus and commitSha. A second complete call for an already published job returns HTTP 409.

### 4. Query status

GET /api/agent-animation?jobToken=<urlencoded signed job token>

Or use POST /api/agent-animation with the following body to keep the signed token out of proxy logs:

~~~json
{"action":"status","id":"agent-...","collection":"library_02"}
~~~

An agent may query by id and collection at any time, even after its 72-hour signed upload session expires. The Bearer API key is required for both.

The Bearer key is still required.

~~~json
{"ok":true,"id":"agent-...","state":"ready","format":"runtime","conversionStatus":"ready","webmStatus":"pending","animations":["idle","walk"],"pageUrl":"https://spine-link.vercel.app/p/agent-..."}
~~~

States: awaiting_upload, processing, ready, failed. webmStatus is separate: the Spine player may already work while the WebM preview is rendering.

## Security and limits

- Authentication is required on **all** operations; no anonymous publishing.
- Session tokens expire after 72 hours. The permanent page link remains.
- Before publication, runtime skeletons, atlas pages, and textures are validated as a playable set in the same directory. Missing texture pages or incompatible versions produce HTTP 422.
- File and folder paths are relative, and parent traversal is rejected. Accepted suffixes are Spine JSON/SKEL, atlas and textures; source projects accept .spine and images/ textures only.
- Maximum 250 files per job, 95 MB per file, 200 MB per job. Each stage has a request size bound. SHA-256 and server HMAC receipts protect staged bytes.
- Entries and assets become visible in one Git commit with retries for concurrent writers. Existing IDs cannot be overwritten.
- New agent pages default to **unlisted**: anyone with their direct page URL can still view the work. This is not private storage.
- An agent API key is a secret and must never be placed in the website frontend.
- This API does not grant remote code execution or unrestricted repository writes.

## SDK and web documentation

Website guide: https://spine-link.vercel.app/api-docs.html

SDK guide: https://spine-link.vercel.app/sdk.html

Server-side ESM SDK (Node.js 20+, no dependencies): https://spine-link.vercel.app/sdk/spine-link-agent.mjs

Example:

```js
import { SpineLinkAgent } from './spine-link-agent.mjs';
const agent = new SpineLinkAgent({ apiKey: process.env.SPINE_LINK_AGENT_API_KEY });
const published = await agent.publish({title:'Robot walk',format:'runtime',files:[
  {path:'robot.json',bytes:jsonBytes},
  {path:'robot.atlas',bytes:atlasBytes},
  {path:'robot.png',bytes:pngBytes},
]});
console.log(published.pageUrl);
```

The SDK automatically batches small images and uploads large assets in signed parts. It uses POST status polling, keeping the signed upload token out of URL logs. Never embed the secret key in a public website.
