/**
 * Extract the animation names from a Spine JSON skeleton for the upload
 * finalizer. Export dispatch requires an explicit track; an empty or malformed
 * JSON document must never cause the worker to guess one.
 */
export function spineAnimationMetadataFromJson(source) {
  try {
    const skeleton = JSON.parse(String(source || ''));
    const animationsObject = skeleton && typeof skeleton === 'object' &&
      skeleton.animations && typeof skeleton.animations === 'object' &&
      !Array.isArray(skeleton.animations)
      ? skeleton.animations
      : null;
    const animations = animationsObject
      ? Object.keys(animationsObject).filter((name) => name.trim())
      : [];
    return {
      animations,
      defaultAnimation: animations[0] || '',
    };
  } catch {
    return { animations: [], defaultAnimation: '' };
  }
}
