export default async function handler(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    return response.status(405).send('Method not allowed');
  }

  const id = String(request.query?.id || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,180}$/i.test(id)) return response.status(400).send('Invalid preview id');

  // Never redirect to the shared demo clip: every entry must serve only its
  // own media, so a missing preview resolves to 404 and the card falls back to
  // its poster instead of borrowing another animation.
  return response.status(404).send('Generated preview video disabled');
}
