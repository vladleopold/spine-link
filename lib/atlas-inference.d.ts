export type AtlasImage = {name:string;width:number;height:number;alpha?:Uint8Array};
export type AtlasRegion = {name:string;type:string;width:number;height:number};
export type AtlasInferenceResult = {
  atlas:string;
  confidence:"matched"|"inferred"|"low";
  regionCount:number;matched:number;alphaAssigned:number;unverified:number;
  pages:string[];details:string;
};
export function attachmentRegions(json:unknown):AtlasRegion[];
export function reconstructAtlas(json:unknown,images:AtlasImage[]):AtlasInferenceResult;
