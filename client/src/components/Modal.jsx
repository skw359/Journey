import { useEffect, useCallback } from 'react';
import './Modal.css';

export default function Modal({ open, onClose, children }) {
  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') onClose?.();
  }, [onClose]);

  useEffect(() => {
    if (open) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [open, handleKeyDown]);

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) onClose?.();
  };

  return (
    <div className={`modal-overlay${open ? ' active' : ''}`} onClick={handleOverlayClick}>
      <div className="modal-content">
        {children}
      </div>
    </div>
  );
}
