export declare function extractAtlasPageNames(text: string): string[];
export declare function atlasPageMatchesTexture(texturePath: string, pageName: string): boolean;
export declare function isValidSpineAtlasHeader(text: string): boolean;

export declare function matchAtlasPagesToTextures<T>(
  atlasPages: readonly string[],
  textures: readonly T[],
  matchesPage: (texture: T, page: string) => boolean,
): T[] | null;
