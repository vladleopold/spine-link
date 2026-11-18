export type DdsHeader={width:number;height:number;fourCC:"DXT1"|"DXT3"|"DXT5";blockSize:number;blocksWide:number;blocksHigh:number;requiredBytes:number};
export function parseDdsHeader(input: Uint8Array | ArrayBuffer): DdsHeader;
export function decodeDds(input: Uint8Array | ArrayBuffer): {width:number;height:number;format:string;rgba:Uint8ClampedArray};
