const MODES = new Set(["google-account", "anonymous-browser"]);

/**
 * Public source-origin evidence deliberately records only the authentication
 * mode. Device/browser fingerprints and contact/account identifiers are
 * private operational data and must never be copied into public proof files.
 */
export function createPublicUploaderEvidence(_uploader = {}, modeOverride) {
  const requestedMode = modeOverride || _uploader?.mode;
  return {
    mode: MODES.has(requestedMode) ? requestedMode : "anonymous-browser",
  };
}
