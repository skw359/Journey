import StatsGrid from './StatsGrid';
import ElevationChart from './ElevationChart';
import SpeedChart from './SpeedChart';
import AccelerationChart from './AccelerationChart';
import PhotoGallery from './PhotoGallery';
import './JourneyDetails.css';

/** Everything below the map: the stats, every graph, then photos. */
export default function JourneyDetails({
  route,
  onPointClick,
  uploading,
  uploadLabel,
  uploadProgress,
  onUpload,
  onDeletePhoto,
  onViewPhoto,
  showPhotos = true,
}) {
  if (!route) return null;

  const hasGraphs = Boolean(route.profileTimeMs && route.profileDistMi);

  return (
    <div className="journey-details">
      <StatsGrid route={route} weather={route.weather} />

      {hasGraphs && (
        <div className="graphs-section">
          <ElevationChart route={route} onPointClick={onPointClick} />
          <SpeedChart route={route} onPointClick={onPointClick} />
          <AccelerationChart route={route} onPointClick={onPointClick} />
        </div>
      )}

      {showPhotos && (
        <PhotoGallery
          photos={route.photos}
          uploading={uploading}
          uploadLabel={uploadLabel}
          uploadProgress={uploadProgress}
          onUpload={onUpload}
          onDeletePhoto={onDeletePhoto}
          onViewPhoto={onViewPhoto}
        />
      )}
    </div>
  );
}
