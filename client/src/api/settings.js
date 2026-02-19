export async function getDatabaseConfig() {
  const res = await fetch('/api/settings/database');
  if (!res.ok) throw new Error('Failed to get database config');
  return res.json();
}

export async function getUnitPreference() {
  const res = await fetch('/api/settings/units');
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to get unit preference');
  return data;
}

export async function updateUnitPreference(unitPreference) {
  const res = await fetch('/api/settings/units', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unitPreference }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to update unit preference');
  return data;
}

export async function updateDatabaseConfig(config) {
  const res = await fetch('/api/settings/database', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to update database config');
  return data;
}

export async function testDatabaseConnection(config) {
  const res = await fetch('/api/settings/database/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  return res.json();
}
