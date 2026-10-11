/**
 * The one device a page of the app may use: the microphone, for dictation in the chat composer
 * (src/app/shell/chat/recorder.ts). Audio only, and only for the app's own pages; every other
 * permission request (camera, screen, location, notifications, …) is refused. Nothing here needs
 * Electron, so tests/desktop.test.ts runs it in Node.
 */
export interface PermissionDetails { requestingUrl?: string; mediaTypes?: string[] }

export function allowPermission(base: string, permission: string, details: PermissionDetails): boolean {
  const own = !!details.requestingUrl?.startsWith(`${base}/`);
  const audio = permission === 'media' && !!details.mediaTypes?.length && details.mediaTypes.every((t) => t === 'audio');
  return own && audio;
}
