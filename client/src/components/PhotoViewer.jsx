import { useEffect, useCallback } from 'react';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';
import { isVideo } from '../utils/media';
import './PhotoViewer.css';

export default function PhotoViewer({ photos, currentIndex, open, onClose, onNavigate }) {
  const handleKeyDown = useCallback((e) => {
    if (!open) return;
    if (e.key === 'Escape') onClose();
    // A focused <video> uses the arrow keys to seek.
    else if (e.target instanceof HTMLVideoElement) return;
    else if (e.key === 'ArrowLeft' && currentIndex > 0) onNavigate(currentIndex - 1);
    else if (e.key === 'ArrowRight' && currentIndex < photos.length - 1) onNavigate(currentIndex + 1);
  }, [open, currentIndex, photos, onClose, onNavigate]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const photo = photos?.[currentIndex];
  if (!photo) return null;

  // Size videos from their known dimensions so the frame doesn't jump while metadata loads.
  const videoStyle = photo.width && photo.height
    ? { width: `min(90vw, calc(90vh * ${photo.width / photo.height}))`, aspectRatio: `${photo.width} / ${photo.height}` }
    : undefined;

  return (
    <div
      className={`photo-viewer-overlay${open ? ' active' : ''}`}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="photo-viewer-content">
        <button className="photo-viewer-close" onClick={onClose}>
          <X size={32} />
        </button>
        {currentIndex > 0 && (
          <button className="photo-nav-btn prev" onClick={() => onNavigate(currentIndex - 1)}>
            <ChevronLeft size={24} />
          </button>
        )}
        {isVideo(photo) ? (
          // Only mounted while open so closing the viewer stops playback.
          open && (
            <video
              key={photo.id}
              src={`/photos/${photo.filename}`}
              poster={photo.posterFilename ? `/photos/${photo.posterFilename}` : undefined}
              style={videoStyle}
              controls
              autoPlay
              playsInline
              preload="metadata"
            />
          )
        ) : (
          <img src={`/photos/${photo.filename}`} alt={photo.originalName} />
        )}
        {currentIndex < photos.length - 1 && (
          <button className="photo-nav-btn next" onClick={() => onNavigate(currentIndex + 1)}>
            <ChevronRight size={24} />
          </button>
        )}
        <div className="photo-counter">{currentIndex + 1} / {photos.length}</div>
      </div>
    </div>
  );
}
