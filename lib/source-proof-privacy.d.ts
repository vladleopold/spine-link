export type PublicUploaderMode = "google-account" | "anonymous-browser";

export function createPublicUploaderEvidence(
  uploader?: Record<string, unknown>,
  modeOverride?: PublicUploaderMode,
): { mode: PublicUploaderMode };
