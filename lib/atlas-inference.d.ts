export type AtlasInferenceResult = {
 text:string; kind:"inferred-packed-sheet"|"named-pages"; confidence:number; coverage:number;
 matched:number; total:number; inferred:boolean; scale:number;
 regions?:Array<{name:string;score:number;rotated:boolean;box:{x:number;y:number;w:number;h:number}|null}>;
};
export function reconstructAtlas(
 skeleton:Record<string,any>,
 images:Array<{name:string;width:number;height:number;rgba:Uint8Array|Uint8ClampedArray}>,
 options?:{strict?:boolean}
): AtlasInferenceResult;
