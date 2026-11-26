export interface GoogleSessionLike {
  clientId?: string;
  accessToken?: string | null;
  expiresAt?: number | string | null;
}

export function hasUsableGoogleSession(
  session: GoogleSessionLike | null | undefined,
  clientId: string,
  now?: number,
): boolean;
