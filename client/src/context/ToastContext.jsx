import React, { createContext, useContext, useState, useCallback } from 'react';
import { X, CheckCircle, AlertCircle, Info } from 'lucide-react';
import './Toast.css';

const ToastContext = createContext(null);

export const useToast = () => {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
};

export const ToastProvider = ({ children }) => {
  const [toasts, setToasts] = useState([]);

  const removeToast = useCallback((id) => {
    setToasts((prev) => prev.map(t => t.id === id ? { ...t, isExiting: true } : t));
    setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, 300);
  }, []);

  const addToast = useCallback((message, type = 'success', duration = 5000, options = {}) => {
    const id = Math.random().toString(36).substr(2, 9);
    setToasts((prev) => [
      ...prev,
      {
        id,
        message,
        type,
        duration,
        isExiting: false,
        actionLabel: options.actionLabel,
        onAction: options.onAction
      }
    ]);

    if (type !== 'loading') {
      setTimeout(() => {
        setToasts((prev) => prev.map(t => t.id === id ? { ...t, isExiting: true } : t));
      }, duration - 300);

      setTimeout(() => {
        removeToast(id);
      }, duration);
    }
    return id;
  }, [removeToast]);

  const success = (msg, dur, options) => addToast(msg, 'success', dur, options);
  const error = (msg, dur, options) => addToast(msg, 'error', dur, options);
  const info = (msg, dur, options) => addToast(msg, 'info', dur, options);
  const loading = (msg, dur, options) => addToast(msg, 'loading', dur, options);

  return (
    <ToastContext.Provider value={{ success, error, info, loading, dismiss: removeToast }}>
      {children}
      <div className="toast-container">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.type}${toast.isExiting ? ' exiting' : ''}`}>
            <div className="toast-content">
              <div className="toast-icon">
                {toast.type === 'success' && <CheckCircle size={18} />}
                {toast.type === 'error' && <AlertCircle size={18} />}
                {toast.type === 'info' && <Info size={18} />}
                {toast.type === 'loading' && <div className="toast-spinner" />}
              </div>
              <div className="toast-message">{toast.message}</div>
              {toast.actionLabel && typeof toast.onAction === 'function' && (
                <button
                  className="toast-action"
                  type="button"
                  onClick={() => {
                    toast.onAction(toast.id);
                    removeToast(toast.id);
                  }}
                >
                  {toast.actionLabel}
                </button>
              )}
              <button className="toast-close" onClick={() => removeToast(toast.id)}>
                <X size={14} />
              </button>
            </div>
            {toast.type !== 'loading' && (
              <div 
                className="toast-progress" 
                style={{ animationDuration: `${toast.duration}ms` }}
              />
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};
