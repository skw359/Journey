import { useEffect, useCallback } from 'react';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';
import './PhotoViewer.css';

export default function PhotoViewer({ photos, currentIndex, open, onClose, onNavigate }) {
  const handleKeyDown = useCallback((e) => {
    if (!open) return;
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowLeft' && currentIndex > 0) onNavigate(currentIndex - 1);
    else if (e.key === 'ArrowRight' && currentIndex < photos.length - 1) onNavigate(currentIndex + 1);
  }, [open, currentIndex, photos, onClose, onNavigate]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  if (!photos?.length) return null;

  const photo = photos[currentIndex];

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
        <img src={`/photos/${photo.filename}`} alt={photo.originalName} />
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
