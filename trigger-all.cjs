const https = require('https');
const { execSync } = require('child_process');

const indexUrl = 'https://raw.githubusercontent.com/vladleopold/spine/main/library/index.json';
const origin = 'https://world.spine.chat';

https.get(indexUrl, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    const indexData = JSON.parse(body);
    console.log(`Found ${indexData.length} entries.`);

    for (const entry of indexData) {
      if (!entry.id) continue;
      
      console.log(`Triggering export for: ${entry.id}`);
      
      const payload = {
        uploadId: entry.id,
        owner: 'vladleopold',
        repo: 'spine',
        branch: 'main',
        origin: origin
      };
      
      const token = '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';
      
      try {
        fetch('https://api.github.com/repos/vladleopold/spine/dispatches', {
          method: 'POST',
          headers: {
            'Accept': 'application/vnd.github.v3+json',
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'Node.js',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            event_type: 'spine-export-webm',
            client_payload: payload
          })
        }).then(res => {
          if (res.ok) {
            console.log(`✅ Success for ${entry.id}`);
          } else {
            res.text().then(text => console.error(`❌ Failed for ${entry.id}`, res.status, text));
          }
        });
      } catch (err) {
        console.error(`❌ Failed for ${entry.id}`, err.message);
      }
    }
    console.log('All triggers sent.');
  });
}).on('error', (e) => {
  console.error("Failed to fetch index.json:", e);
});
