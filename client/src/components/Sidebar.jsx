import './Sidebar.css';

export default function Sidebar({ collapsed, children }) {
  return (
    <aside className={`route-list-container${collapsed ? ' collapsed' : ''}`}>
      {children}
    </aside>
  );
}
