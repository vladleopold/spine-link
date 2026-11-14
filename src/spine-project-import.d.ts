export function rememberProjectFilePath<T extends File>(file: T, path: string): T;
export function projectFilePath(file: File): string;
export function isSpineProjectFile(file: { name: string }): boolean;
export function isSpineImageFile(file: { name: string }): boolean;
export function normalizeProjectPath(file: File, relativePath?: string): string;
export function validateProjectSelection(files: File[]): File[];
export function readDroppedProjectEntries(entries: unknown[]): Promise<File[]>;
