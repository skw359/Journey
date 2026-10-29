// Journey media = photos plus videos (both live in route.photos; videos have kind === 'video').

export const IMAGE_EXTENSIONS = ['.heic', '.heif', '.jpg', '.jpeg'];
export const VIDEO_EXTENSIONS = ['.mov', '.mp4', '.m4v', '.webm', '.mkv', '.avi'];
export const ACCEPT_ATTR = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS].join(',');

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

export function isVideoFile(file) {
  return file.type.startsWith('video/') || VIDEO_EXTENSIONS.includes(extensionOf(file.name));
}

export function isAcceptedFile(file) {
  const ext = extensionOf(file.name);
  return IMAGE_EXTENSIONS.includes(ext) || VIDEO_EXTENSIONS.includes(ext);
}

export const isVideo = (item) => item?.kind === 'video';

// Items the server is still converting (or couldn't convert) can't be opened in the viewer.
export const isViewable = (item) => !item.status || item.status === 'ready';

// Image that represents an item in previews: a converted photo itself, or a converted video's poster.
export function previewFilename(item) {
  if (!item || !isViewable(item)) return null;
  return isVideo(item) ? item.posterFilename || null : item.filename;
}

// Matches the server's journey cover: the first item (upload order) that has a preview image.
export function coverFilename(items) {
  for (const item of items || []) {
    const preview = previewFilename(item);
    if (preview) return preview;
  }
  return null;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// "3 photos", "1 video", "3 photos and 1 video"
export function describeCounts(photoCount, videoCount, joiner = ' and ') {
  const parts = [];
  if (photoCount || !videoCount) parts.push(plural(photoCount, 'photo'));
  if (videoCount) parts.push(plural(videoCount, 'video'));
  return parts.join(joiner);
}

export function describeFiles(files) {
  const videos = files.filter(isVideoFile).length;
  return describeCounts(files.length - videos, videos);
}

export function describeMedia(items, joiner) {
  const videos = (items || []).filter(isVideo).length;
  return describeCounts((items?.length || 0) - videos, videos, joiner);
}

export function formatVideoDuration(ms) {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
