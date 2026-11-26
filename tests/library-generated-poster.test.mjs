import test from 'node:test';
import assert from 'node:assert/strict';
import { publicLibraryEntry } from '../api/github-upload.js';

test('public library entry prefers generated WebP poster tiers over uploaded texture PNG', () => {
  const entry = publicLibraryEntry('https://spine-link.vercel.app', {
    id: 'preview-1',
    uploadedAt: '2026-11-26T10:49:18.492Z',
    previewPath: 'library_02/preview-1',
    thumbnailPoster: 'https://spine-link.vercel.app/assets/library_02/preview-1/character.png',
    webpPosterMedium: 'https://spine-link.vercel.app/assets/library_02/preview-1/preview-medium.webp',
    webpPoster: 'https://spine-link.vercel.app/assets/library_02/preview-1/preview.webp',
    webmPreviewMedium: 'https://spine-link.vercel.app/assets/library_02/preview-1/preview-medium.webm',
  });
  assert.match(entry.thumbnailPoster, /preview-medium\.webp/);
  assert.match(entry.webmPreview, /preview-medium\.webm/);
});

test('public library entry falls back to uploaded poster when no generated WebP exists', () => {
  const entry = publicLibraryEntry('https://spine-link.vercel.app', {
    id: 'preview-2',
    previewPath: 'library_02/preview-2',
    thumbnailPoster: 'https://spine-link.vercel.app/assets/library_02/preview-2/character.png',
  });
  assert.match(entry.thumbnailPoster, /character\.png/);
});
