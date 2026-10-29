import { useRef, useState, useCallback } from 'react';
import { Plus, X, Image, Play, Film, AlertCircle } from 'lucide-react';
import { ACCEPT_ATTR, isAcceptedFile, isVideo, describeMedia, formatVideoDuration } from '../utils/media';
import './PhotoGallery.css';

// Stands in for an upload the server is still converting, or couldn't convert.
function MediaStatus({ item }) {
  if (item.status === 'processing') {
    return (
      <div className="media-status">
        <div className="upload-spinner" />
        <span>Processing {isVideo(item) ? 'video' : 'photo'}...</span>
      </div>
    );
  }
  return (
    <div className="media-status failed">
      <AlertCircle size={28} />
      <span>{isVideo(item) ? "Couldn't convert this video" : "Couldn't process this photo"}</span>
    </div>
  );
}

function VideoThumb({ video }) {
  return (
    <>
      {video.posterFilename
        ? <img src={`/photos/thumb/${video.posterFilename}`} alt={video.originalName} loading="lazy" decoding="async" />
        : <Film size={56} strokeWidth={1.5} className="video-placeholder" />}
      <div className="video-play-badge"><Play size={22} fill="currentColor" /></div>
      {video.durationMs > 0 && <span className="video-duration">{formatVideoDuration(video.durationMs)}</span>}
    </>
  );
}

export default function PhotoGallery({
  photos,
  uploading,
  uploadLabel,
  uploadProgress,
  onUpload,
  onDeletePhoto,
  onViewPhoto,
}) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const dragCounter = useRef(0);

  const handleChange = (e) => {
    const files = Array.from(e.target.files);
    if (files.length > 0) onUpload(files);
    e.target.value = '';
  };

  const triggerUpload = () => inputRef.current?.click();

  const handleDragEnter = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.items?.length > 0) setDragging(true);
  }, []);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) setDragging(false);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    dragCounter.current = 0;
    const files = Array.from(e.dataTransfer.files).filter(isAcceptedFile);
    if (files.length > 0) onUpload(files);
  }, [onUpload]);

  const percent = uploadProgress != null ? Math.round(uploadProgress * 100) : null;

  return (
    <div
      className={`photos-section${dragging ? ' drag-over' : ''}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="photos-header">
        <div>
          <h3>Photos &amp; Videos</h3>
          <div className="photo-count">{describeMedia(photos, ' · ')}</div>
        </div>
        {photos?.length > 0 && (
          <button className="add-photos-btn" onClick={triggerUpload}>
            <Plus size={18} />
            Add Media
          </button>
        )}
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT_ATTR}
          multiple
          style={{ display: 'none' }}
          onChange={handleChange}
        />
      </div>

      {uploading && (
        <div className="photo-upload-progress">
          <div className="upload-spinner" />
          <span>Uploading {uploadLabel}...{percent != null && ` ${percent}%`}</span>
          {percent != null && (
            <div className="upload-progress-bar">
              <div className="upload-progress-fill" style={{ width: `${percent}%` }} />
            </div>
          )}
        </div>
      )}

      {!uploading && photos?.length > 0 && (
        <div className="photos-grid">
          {photos.map((photo) => {
            const ready = photo.status === 'ready';
            return (
              <div
                key={photo.id}
                className={`photo-card${ready ? '' : ' not-ready'}`}
                onClick={ready ? () => onViewPhoto(photo.id) : undefined}
              >
                {!ready
                  ? <MediaStatus item={photo} />
                  : isVideo(photo)
                    ? <VideoThumb video={photo} />
                    : <img src={`/photos/thumb/${photo.filename}`} alt={photo.originalName} loading="lazy" decoding="async" />}
                <button
                  className="photo-delete-btn"
                  onClick={(e) => { e.stopPropagation(); onDeletePhoto(photo); }}
                >
                  <X size={18} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {!uploading && (!photos || photos.length === 0) && (
        <div className="empty-photos" onClick={triggerUpload} title="Add photos or videos">
          <Image size={64} strokeWidth={1.5} />
          <p>No photos or videos yet<br />Drag &amp; drop photos or videos here, or click to browse</p>
        </div>
      )}
    </div>
  );
}
