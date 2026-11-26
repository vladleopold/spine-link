// Chromium sometimes reports URL-less 404 console messages for optional
// resources (for example, favicons). Callers must separately inspect response
// URLs and fail on missing required Spine assets before ignoring this message.
export function isAmbiguous404ConsoleMessage(message) {
  return /Failed to load resource: the server responded with a status of 404(?:\s|$)/i
    .test(String(message || ''));
}
