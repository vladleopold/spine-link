// Retry transport failures and temporary server responses only. A rejected
// payload must retain its original status and message instead of being replayed.
export async function uploadRequest(url: string, init: RequestInit, attempts = 3): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      if (attempt + 1 >= attempts) throw error;
      await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
      continue;
    }
    if (response.ok || (response.status < 500 && response.status !== 429) || attempt + 1 >= attempts) return response;
    const retryAfter = response.headers.get("Retry-After");
    const seconds = Number(retryAfter);
    const dateDelay = retryAfter ? Date.parse(retryAfter) - Date.now() : 0;
    const requested = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Math.max(0, dateDelay || 0);
    await new Promise(resolve => setTimeout(resolve, requested || 400 * (attempt + 1)));
  }
}
