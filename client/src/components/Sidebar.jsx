import './Sidebar.css';

export default function Sidebar({ collapsed, children, floating }) {
  const classes = ['route-list-container'];
  if (collapsed) classes.push('collapsed');
  if (floating) classes.push('floating');
  return (
    <aside className={classes.join(' ')}>
      {children}
    </aside>
  );
}
