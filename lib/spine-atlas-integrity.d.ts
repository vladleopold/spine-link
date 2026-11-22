export declare function isValidSpineAtlasHeader(text: string): boolean;

export declare function matchAtlasPagesToTextures<T>(
  atlasPages: readonly string[],
  textures: readonly T[],
  matchesPage: (texture: T, page: string) => boolean,
): T[] | null;
