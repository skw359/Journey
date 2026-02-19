import { useRef } from 'react';
import { Plus, X, Image } from 'lucide-react';
import './PhotoGallery.css';

export default function PhotoGallery({
  photos,
  uploading,
  uploadCount,
  onUpload,
  onDeletePhoto,
  onViewPhoto,
}) {
  const inputRef = useRef(null);

  const handleChange = (e) => {
    const files = Array.from(e.target.files);
    if (files.length > 0) onUpload(files);
    e.target.value = '';
  };

  const triggerUpload = () => inputRef.current?.click();

  return (
    <div className="photos-section">
      <div className="photos-header">
        <div>
          <h3>Photos</h3>
          <div className="photo-count">
            {photos?.length || 0} photo{(photos?.length || 0) !== 1 ? 's' : ''}
          </div>
        </div>
        {photos?.length > 0 && (
          <button className="add-photos-btn" onClick={triggerUpload}>
            <Plus size={18} />
            Add Photos
          </button>
        )}
        <input
          ref={inputRef}
          type="file"
          accept=".heic,.heif,.jpg,.jpeg"
          multiple
          style={{ display: 'none' }}
          onChange={handleChange}
        />
      </div>

      {uploading && (
        <div className="photo-upload-progress">
          <div className="upload-spinner" />
          <span>Uploading {uploadCount} photo{uploadCount !== 1 ? 's' : ''}...</span>
        </div>
      )}

      {!uploading && photos?.length > 0 && (
        <div className="photos-grid">
          {photos.map((photo, index) => (
            <div key={photo.id} className="photo-card" onClick={() => onViewPhoto(index)}>
              <img src={`/photos/${photo.filename}`} alt={photo.originalName} loading="lazy" />
              <button
                className="photo-delete-btn"
                onClick={(e) => { e.stopPropagation(); onDeletePhoto(photo.id, photo.filename); }}
              >
                <X size={18} />
              </button>
            </div>
          ))}
        </div>
      )}

      {!uploading && (!photos || photos.length === 0) && (
        <div className="empty-photos" onClick={triggerUpload} title="Add Photos">
          <Image size={64} strokeWidth={1.5} />
          <p>No photos yet<br />Add photos to remember this journey!</p>
        </div>
      )}
    </div>
  );
}
