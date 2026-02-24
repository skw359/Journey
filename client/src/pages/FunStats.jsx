import { useEffect, useState } from 'react';
import { useUnits } from '../context/UnitsContext';
import { formatCompactDurationMs } from '../utils/formatters';
import './FunStats.css';

function formatHour(h) {
  if (h === 0) return '12 AM';
  if (h < 12) return `${h} AM`;
  if (h === 12) return '12 PM';
  return `${h - 12} PM`;
}

function formatMonth(monthStr) {
  const [y, m] = monthStr.split('-');
  const date = new Date(Number(y), Number(m) - 1);
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function formatShortMonth(monthStr) {
  const [y, m] = monthStr.split('-');
  const date = new Date(Number(y), Number(m) - 1);
  return date.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatSigned(value, digits = 1) {
  if (!Number.isFinite(value)) return '--';
  if (value > 0) return `+${value.toFixed(digits)}`;
  return value.toFixed(digits);
}

const STATE_NAMES = {
  AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',
  CT:'Connecticut',DE:'Delaware',DC:'D.C.',FL:'Florida',GA:'Georgia',HI:'Hawaii',
  ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',
  LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',
  MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',
  NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',
  OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',
  SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',
  WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',
};

export default function FunStats() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const { convertDistance, convertSpeed, distanceUnit, speedUnit } = useUnits();

  useEffect(() => {
    fetch('/api/fun-stats', { credentials: 'include' })
      .then(r => { if (!r.ok) throw new Error('Failed to load stats'); return r.json(); })
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div id="main-app" className="settings-page">
        <main className="funstats-main">
          <div className="funstats-container">
            <div className="funstats-loading"><div className="funstats-spinner" /></div>
          </div>
        </main>
      </div>
    );
  }

  if (error) {
    return (
      <div id="main-app" className="settings-page">
        <main className="funstats-main">
          <div className="funstats-container">
            <div className="funstats-empty"><h2>Error</h2><p>{error}</p></div>
          </div>
        </main>
      </div>
    );
  }

  if (!data || data.empty) {
    return (
      <div id="main-app" className="settings-page">
        <main className="funstats-main">
          <div className="funstats-container">
            <div className="funstats-empty"><h2>No Data Yet</h2><p>Record some journeys to see your fun stats!</p></div>
          </div>
        </main>
      </div>
    );
  }

  const cd = (miles) => convertDistance(miles);
  const cs = (mph) => convertSpeed(mph);
  const seasonLabel = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const modeLabel = (m) => m === 'drive' ? 'Driving' : m === 'scooter' ? 'Scooter' : 'Walking';
  const habitInsights = data.habitInsights || {};
  const routineExplorerIndex = habitInsights.routineExplorer?.index;
  const routineExplorerLabel = !Number.isFinite(routineExplorerIndex)
    ? 'Balanced'
    : routineExplorerIndex >= 10
      ? 'Routine'
      : routineExplorerIndex <= -10
        ? 'Explorer'
        : 'Balanced';
  const predictableWeekdayHour = Number.isFinite(habitInsights.mostPredictableWeekday?.avgStartHour)
    ? ((Math.round(habitInsights.mostPredictableWeekday.avgStartHour) % 24) + 24) % 24
    : null;

  // Monthly chart max for bar scaling
  const chartMax = data.monthlyChart?.length > 0
    ? Math.max(...data.monthlyChart.map(m => m.distanceMiles))
    : 1;

  // Activity heatmap: build 52-week grid from today
  const heatmapWeeks = [];
  if (data.activityHeatmap) {
    const today = new Date();
    for (let w = 51; w >= 0; w--) {
      const week = [];
      for (let d = 0; d < 7; d++) {
        const date = new Date(today);
        date.setDate(date.getDate() - (w * 7 + (6 - d)));
        const key = date.toISOString().slice(0, 10);
        week.push({ date: key, count: data.activityHeatmap[key] || 0 });
      }
      heatmapWeeks.push(week);
    }
  }

  const heatColor = (count) => {
    if (count === 0) return 'var(--bg-tertiary)';
    if (count === 1) return 'rgba(2, 216, 127, 0.3)';
    if (count === 2) return 'rgba(2, 216, 127, 0.5)';
    if (count <= 4) return 'rgba(2, 216, 127, 0.7)';
    return 'rgba(2, 216, 127, 0.9)';
  };

  // Next 3 locked achievements for progress bars
  const nextAchievements = (data.achievementProgress || [])
    .filter(a => !a.unlocked && a.current > 0)
    .sort((a, b) => (b.current / b.target) - (a.current / a.target))
    .slice(0, 4);

  return (
    <div id="main-app" className="settings-page">
      <main className="funstats-main">
        <div className="funstats-container">

          {/* Level & Spirit Animal header */}
          <section className="funstats-panel funstats-hero">
            <div className="funstats-hero-row">
              {data.spiritAnimal && (
                <div className="funstats-spirit">
                  <span className="funstats-spirit-icon">{
                    { hawk: '\uD83E\uDD85', fox: '\uD83E\uDD8A', bear: '\uD83D\uDC3B', dolphin: '\uD83D\uDC2C',
                      wolf: '\uD83D\uDC3A', owl: '\uD83E\uDD89', eagle: '\uD83E\uDD85', hummingbird: '\uD83D\uDC26' }[data.spiritAnimal.key]
                  }</span>
                  <div className="funstats-spirit-info">
                    <span className="funstats-spirit-name">{data.spiritAnimal.name}</span>
                    <span className="funstats-spirit-trait">{data.spiritAnimal.trait}</span>
                  </div>
                </div>
              )}
              {data.level && (
                <div className="funstats-level">
                  <div className="funstats-level-header">
                    <span className="funstats-level-name">{data.level.name}</span>
                    <span className="funstats-level-xp">{data.level.xp.toLocaleString()} XP</span>
                  </div>
                  {data.level.nextLevelXp && (
                    <div className="funstats-level-bar-wrap">
                      <div className="funstats-level-bar"
                        style={{ width: `${Math.min(100, ((data.level.xp - data.level.currentLevelXp) / (data.level.nextLevelXp - data.level.currentLevelXp)) * 100)}%` }}
                      />
                    </div>
                  )}
                  {data.level.nextLevelName && (
                    <span className="funstats-level-next">Next: {data.level.nextLevelName}</span>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* Travel Profile */}
          <section className="funstats-panel">
            <h2 className="funstats-panel-title">Travel Profile</h2>
            <div className="funstats-profile-grid">
              <div className="funstats-profile-item">
                <span className="funstats-profile-label">Total Distance</span>
                <span className="funstats-profile-value">{cd(data.totalDistance)?.toFixed(1) ?? '--'}<span className="unit">{distanceUnit}</span></span>
              </div>
              <div className="funstats-profile-item">
                <span className="funstats-profile-label">Total Journeys</span>
                <span className="funstats-profile-value">{data.totalRoutes.toLocaleString()}</span>
              </div>
              <div className="funstats-profile-item">
                <span className="funstats-profile-label">Time Traveled</span>
                <span className="funstats-profile-value">{data.totalTimeMs > 0 ? formatCompactDurationMs(data.totalTimeMs) : '--'}</span>
              </div>
              <div className="funstats-profile-item">
                <span className="funstats-profile-label">Avg Speed</span>
                <span className="funstats-profile-value">{cs(data.avgSpeed)?.toFixed(1) ?? '--'}<span className="unit">{speedUnit}</span></span>
              </div>
              <div className="funstats-profile-item">
                <span className="funstats-profile-label">Top Speed</span>
                <span className="funstats-profile-value">{cs(data.topSpeed)?.toFixed(0) ?? '--'}<span className="unit">{speedUnit}</span></span>
              </div>
              <div className="funstats-profile-item">
                <span className="funstats-profile-label">Unique Locations</span>
                <span className="funstats-profile-value">{data.uniqueLocations.toLocaleString()}</span>
              </div>
              <div className="funstats-profile-item">
                <span className="funstats-profile-label">Avg Journey</span>
                <span className="funstats-profile-value">{cd(data.avgJourneyDistanceMiles)?.toFixed(1) ?? '--'}<span className="unit">{distanceUnit}</span></span>
              </div>
              <div className="funstats-profile-item">
                <span className="funstats-profile-label">Per Week</span>
                <span className="funstats-profile-value">{data.journeysPerWeek.toFixed(1)}<span className="unit">journeys</span></span>
              </div>
            </div>
          </section>

          {/* How Far Is That? */}
          <section className="funstats-panel">
            <h2 className="funstats-panel-title">How Far Is That?</h2>
            <div className="funstats-stat-grid">
              <div className="funstats-stat-card">
                <h4>Around the Earth</h4>
                <div className="value">{data.funComparisons.earthLaps >= 1 ? `${data.funComparisons.earthLaps.toFixed(1)}x` : `${(data.funComparisons.earthLaps * 100).toFixed(1)}%`}</div>
                <div className="sub">of Earth's circumference</div>
              </div>
              <div className="funstats-stat-card">
                <h4>To the Moon</h4>
                <div className="value">{data.funComparisons.moonPercent.toFixed(2)}%</div>
                <div className="sub">of the way there</div>
              </div>
              {data.fuelEstimate && (
                <div className="funstats-stat-card">
                  <h4>Est. Fuel Used</h4>
                  <div className="value">{data.fuelEstimate.gallons.toLocaleString()}<span className="unit">gal</span></div>
                  <div className="sub">~{data.fuelEstimate.co2Kg.toLocaleString()} kg CO2</div>
                </div>
              )}
              {data.fuelEstimate && data.fuelEstimate.co2SavedKg > 0 && (
                <div className="funstats-stat-card">
                  <h4>CO2 Saved</h4>
                  <div className="value">{data.fuelEstimate.co2SavedKg.toLocaleString()}<span className="unit">kg</span></div>
                  <div className="sub">By walking/scootering</div>
                </div>
              )}
              {data.firstJourney && (
                <div className="funstats-stat-card">
                  <h4>First Journey</h4>
                  <div className="value">{formatDate(data.firstJourney.date)}</div>
                  <div className="sub">{data.firstJourney.name || 'Your very first trip'}</div>
                </div>
              )}
              <div className="funstats-stat-card">
                <h4>Data Points</h4>
                <div className="value">{data.totalDataPoints.toLocaleString()}</div>
                <div className="sub">GPS coordinates recorded</div>
              </div>
            </div>
          </section>

          {/* States Visited */}
          {data.statesVisited?.length > 0 && (
            <section className="funstats-panel">
              <h2 className="funstats-panel-title">States Visited</h2>
              <div className="funstats-states-count">{data.statesVisited.length} <span>/ 50 states</span></div>
              <div className="funstats-states-list">
                {data.statesVisited.map(s => (
                  <span key={s} className="funstats-state-tag">{STATE_NAMES[s] || s}</span>
                ))}
              </div>
            </section>
          )}

          {/* Monthly Distance Chart */}
          {data.monthlyChart?.length > 1 && (
            <section className="funstats-panel">
              <h2 className="funstats-panel-title">Distance Over Time</h2>
              {data.yoyComparison && (
                <div className="funstats-yoy">
                  {data.yoyComparison.changePercent >= 0
                    ? <span className="funstats-yoy-up">+{data.yoyComparison.changePercent}% vs last year</span>
                    : <span className="funstats-yoy-down">{data.yoyComparison.changePercent}% vs last year</span>
                  }
                </div>
              )}
              {data.monthlyChallenge && (
                <div className="funstats-challenge">
                  <span className="funstats-challenge-label">Monthly challenge: beat last month's {cd(data.monthlyChallenge.targetMiles)?.toFixed(0)} {distanceUnit}</span>
                  <div className="funstats-challenge-bar-wrap">
                    <div className="funstats-challenge-bar" style={{ width: `${data.monthlyChallenge.percent}%` }} />
                  </div>
                  <span className="funstats-challenge-pct">{data.monthlyChallenge.percent}%{data.monthlyChallenge.beatLastMonth ? ' — Done!' : ''}</span>
                </div>
              )}
              <div className="funstats-barchart">
                {data.monthlyChart.slice(-24).map((m) => (
                  <div key={m.month} className="funstats-bar-col" title={`${formatShortMonth(m.month)}: ${cd(m.distanceMiles)?.toFixed(0)} ${distanceUnit}`}>
                    <div className="funstats-bar" style={{ height: `${Math.max(2, (m.distanceMiles / chartMax) * 100)}%` }} />
                    <span className="funstats-bar-label">{formatShortMonth(m.month)}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Activity Heatmap */}
          {heatmapWeeks.length > 0 && (
            <section className="funstats-panel">
              <h2 className="funstats-panel-title">Activity</h2>
              <div className="funstats-heatmap-scroll">
                <div className="funstats-heatmap">
                  {heatmapWeeks.map((week, wi) => (
                    <div key={wi} className="funstats-heatmap-col">
                      {week.map((day) => (
                        <div
                          key={day.date}
                          className="funstats-heatmap-cell"
                          style={{ background: heatColor(day.count) }}
                          title={`${day.date}: ${day.count} journeys`}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}

          {/* Exploration */}
          <section className="funstats-panel">
            <h2 className="funstats-panel-title">Exploration</h2>
            <div className="funstats-stat-grid">
              <div className="funstats-stat-card">
                <h4>Exploration Score</h4>
                <div className="value">{data.explorationScore.toFixed(1)}%</div>
                <div className="sub">Unique area coverage</div>
              </div>
              <div className="funstats-stat-card">
                <h4>Coverage Radius</h4>
                <div className="value">{cd(data.coverageRadiusMiles)?.toFixed(1) ?? '--'}<span className="unit">{distanceUnit}</span></div>
                <div className="sub">Max range from home</div>
              </div>
              <div className="funstats-stat-card">
                <h4>Furthest Point</h4>
                <div className="value">{cd(data.furthestPointMiles)?.toFixed(1) ?? '--'}<span className="unit">{distanceUnit}</span></div>
                {data.furthestPointCoord && <div className="sub">{data.furthestPointCoord[0].toFixed(4)}, {data.furthestPointCoord[1].toFixed(4)}</div>}
              </div>
              <div className="funstats-stat-card">
                <h4>Route Diversity</h4>
                <div className="value">{data.routeDiversity.toFixed(1)}%</div>
                <div className="sub">Unique route pairs</div>
              </div>
              {data.favoriteDirection && (
                <div className="funstats-stat-card">
                  <h4>Favorite Direction</h4>
                  <div className="value">{data.favoriteDirection.direction}</div>
                  <div className="sub">{data.favoriteDirection.count} journeys headed this way</div>
                </div>
              )}
              <div className="funstats-stat-card">
                <h4>Round Trips</h4>
                <div className="value">{data.roundTripPercent}%</div>
                <div className="sub">{data.roundTripCount} journeys back to start</div>
              </div>
              {data.newTerritory && data.newTerritory.newCellsThisMonth > 0 && (
                <div className="funstats-stat-card">
                  <h4>New Territory</h4>
                  <div className="value">{data.newTerritory.newCellsThisMonth}</div>
                  <div className="sub">New locations this month</div>
                </div>
              )}
            </div>
          </section>

          {/* Extreme Points */}
          {data.extremePoints && (data.extremePoints.north || data.extremePoints.south) && (
            <section className="funstats-panel">
              <h2 className="funstats-panel-title">Extreme Points</h2>
              <div className="funstats-stat-grid">
                {[['Northernmost', 'north'], ['Southernmost', 'south'], ['Easternmost', 'east'], ['Westernmost', 'west']].map(([label, key]) => {
                  const pt = data.extremePoints[key];
                  if (!pt) return null;
                  return (
                    <div key={key} className="funstats-stat-card">
                      <h4>{label}</h4>
                      <div className="value" style={{ fontSize: '1rem' }}>{pt[0].toFixed(4)}, {pt[1].toFixed(4)}</div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Speed Percentiles */}
          {data.speedPercentiles && (
            <section className="funstats-panel">
              <h2 className="funstats-panel-title">Speed Distribution</h2>
              <div className="funstats-stat-grid">
                {[['25th %ile', 'p25'], ['Median', 'p50'], ['75th %ile', 'p75'], ['95th %ile', 'p95']].map(([label, key]) => (
                  <div key={key} className="funstats-stat-card">
                    <h4>{label}</h4>
                    <div className="value">{cs(data.speedPercentiles[key])?.toFixed(1) ?? '--'}<span className="unit">{speedUnit}</span></div>
                    <div className="sub">avg speed</div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Habits & Patterns */}
          <section className="funstats-panel">
            <h2 className="funstats-panel-title">Habits & Patterns</h2>
            <div className="funstats-stat-grid">
              {data.timeOfDay?.[0]?.count > 0 && (
                <div className="funstats-stat-card">
                  <h4>Time of Day</h4>
                  <div className="value">{data.timeOfDay[0].name}</div>
                  <div className="sub">{data.timeOfDay.filter(t => t.count > 0).map(t => `${t.name}: ${t.count}`).join(', ')}</div>
                </div>
              )}
              <div className="funstats-stat-card">
                <h4>Weekday vs Weekend</h4>
                <div className="value">{data.weekendPercent}% weekend</div>
                <div className="sub">{data.weekdayCount} weekday, {data.weekendCount} weekend</div>
              </div>
              {data.peakDayOfWeek && (
                <div className="funstats-stat-card">
                  <h4>Most Active Day</h4>
                  <div className="value">{data.peakDayOfWeek.day}</div>
                  <div className="sub">{data.peakDayOfWeek.count} journeys</div>
                </div>
              )}
              {data.peakHour && (
                <div className="funstats-stat-card">
                  <h4>Peak Hour</h4>
                  <div className="value">{formatHour(data.peakHour.hour)}</div>
                  <div className="sub">{data.peakHour.count} journeys</div>
                </div>
              )}
              {data.favoriteSeason?.count > 0 && (
                <div className="funstats-stat-card">
                  <h4>Favorite Season</h4>
                  <div className="value">{seasonLabel(data.favoriteSeason.season)}</div>
                  <div className="sub">{data.favoriteSeason.count} journeys, {cd(data.favoriteSeason.distanceMiles)?.toFixed(0) ?? '--'} {distanceUnit}</div>
                </div>
              )}
              {data.longestStreak > 0 && (
                <div className="funstats-stat-card">
                  <h4>Longest Streak</h4>
                  <div className="value">{data.longestStreak} days</div>
                  <div className="sub">{data.longestStreakStart && data.longestStreakEnd ? `${formatDate(data.longestStreakStart)} – ${formatDate(data.longestStreakEnd)}` : ''}</div>
                </div>
              )}
              {data.currentStreak > 0 && (
                <div className="funstats-stat-card">
                  <h4>Current Streak</h4>
                  <div className="value">{data.currentStreak} days</div>
                  <div className="sub">Keep it going!</div>
                </div>
              )}
              {data.busiestDay && (
                <div className="funstats-stat-card">
                  <h4>Busiest Day</h4>
                  <div className="value">{data.busiestDay.count} journeys</div>
                  <div className="sub">{formatDate(data.busiestDay.date)}</div>
                </div>
              )}
              {data.longestBreak && (
                <div className="funstats-stat-card">
                  <h4>Longest Break</h4>
                  <div className="value">{formatCompactDurationMs(data.longestBreak.durationMs)}</div>
                  <div className="sub">Your longest hiatus</div>
                </div>
              )}
              {habitInsights.startTimeConsistencyHours != null && (
                <div className="funstats-stat-card">
                  <h4>Start-Time Consistency</h4>
                  <div className="value">{habitInsights.startTimeConsistencyHours.toFixed(1)}h</div>
                  <div className="sub">Lower means more routine start times</div>
                </div>
              )}
              {habitInsights.commuteWindow && (
                <div className="funstats-stat-card">
                  <h4>Commute Window</h4>
                  <div className="value">{habitInsights.commuteWindow.percent}%</div>
                  <div className="sub">{habitInsights.commuteWindow.count} weekday journeys in 6-9 AM or 4-7 PM</div>
                </div>
              )}
              {habitInsights.routineExplorer && (
                <div className="funstats-stat-card">
                  <h4>Routine vs Explorer</h4>
                  <div className="value">{routineExplorerLabel}</div>
                  <div className="sub">
                    {`Index ${formatSigned(habitInsights.routineExplorer.index)} (${habitInsights.routineExplorer.repeatedRouteRate}% repeat vs ${habitInsights.routineExplorer.newTerritoryRate}% new territory)`}
                  </div>
                </div>
              )}
              {habitInsights.activeDays30 && (
                <div className="funstats-stat-card">
                  <h4>Active Days / 30</h4>
                  <div className="value">{habitInsights.activeDays30.current} / 30</div>
                  <div className="sub">{`${formatSigned(habitInsights.activeDays30.delta, 0)} vs previous 30 days`}</div>
                </div>
              )}
              {habitInsights.burstiness && (
                <div className="funstats-stat-card">
                  <h4>Burstiness Score</h4>
                  <div className="value">{habitInsights.burstiness.percent}%</div>
                  <div className="sub">{habitInsights.burstiness.top10JourneyCount} journeys on your top 10 busiest days</div>
                </div>
              )}
              {habitInsights.medianGapDays != null && (
                <div className="funstats-stat-card">
                  <h4>Median Gap</h4>
                  <div className="value">{habitInsights.medianGapDays.toFixed(1)} days</div>
                  <div className="sub">Typical gap between active days</div>
                </div>
              )}
              {habitInsights.modeSwitch?.transitions > 0 && (
                <div className="funstats-stat-card">
                  <h4>Mode Switch Rate</h4>
                  <div className="value">{habitInsights.modeSwitch.percent}%</div>
                  <div className="sub">{habitInsights.modeSwitch.switches} switches across {habitInsights.modeSwitch.transitions} transitions</div>
                </div>
              )}
              {habitInsights.weekendDistanceBias && (
                <div className="funstats-stat-card">
                  <h4>Weekend Distance Bias</h4>
                  <div className="value">{formatSigned(habitInsights.weekendDistanceBias.biasPercent)}%</div>
                  <div className="sub">{habitInsights.weekendDistanceBias.distancePercent}% weekend distance vs {habitInsights.weekendDistanceBias.tripPercent}% weekend trips</div>
                </div>
              )}
              {habitInsights.mostPredictableWeekday && (
                <div className="funstats-stat-card">
                  <h4>Most Predictable Weekday</h4>
                  <div className="value">{habitInsights.mostPredictableWeekday.day}</div>
                  <div className="sub">
                    {predictableWeekdayHour != null
                      ? `${formatHour(predictableWeekdayHour)} starts, spread ${habitInsights.mostPredictableWeekday.stdDevHours.toFixed(1)}h`
                      : `${habitInsights.mostPredictableWeekday.sampleCount} journeys`}
                  </div>
                </div>
              )}
              {habitInsights.roundTripSplit && (
                <div className="funstats-stat-card">
                  <h4>Round-Trip Split</h4>
                  <div className="value">{habitInsights.roundTripSplit.weekendPercent}% wknd / {habitInsights.roundTripSplit.weekdayPercent}% wkday</div>
                  <div className="sub">{habitInsights.roundTripSplit.weekendCount} weekend and {habitInsights.roundTripSplit.weekdayCount} weekday round trips</div>
                </div>
              )}
              {habitInsights.streakReliability && (
                <div className="funstats-stat-card">
                  <h4>Streak Reliability</h4>
                  <div className="value">{habitInsights.streakReliability.startsPerMonth}/mo</div>
                  <div className="sub">
                    {habitInsights.streakReliability.bestMonth
                      ? `${habitInsights.streakReliability.streakStarts3Plus} starts of 3+ day streaks, best in ${formatMonth(habitInsights.streakReliability.bestMonth.month)}`
                      : `${habitInsights.streakReliability.streakStarts3Plus} starts of 3+ day streaks`}
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* Travel Modes */}
          {data.modeCounts && (data.modeCounts.drive + data.modeCounts.scooter + data.modeCounts.foot > 0) && (
            <section className="funstats-panel">
              <h2 className="funstats-panel-title">Travel Modes</h2>
              <div className="funstats-stat-grid">
                {['drive', 'scooter', 'foot'].filter(m => data.modeCounts[m] > 0).map(m => (
                  <div key={m} className="funstats-stat-card">
                    <h4>{modeLabel(m)}</h4>
                    <div className="value">{data.modeCounts[m]}</div>
                    <div className="sub">{cd(data.modeDistances[m])?.toFixed(1) ?? '--'} {distanceUnit} · {((data.modeCounts[m] / data.totalRoutes) * 100).toFixed(0)}%</div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Elevation */}
          {data.elevation && (
            <section className="funstats-panel">
              <h2 className="funstats-panel-title">Elevation</h2>
              <div className="funstats-stat-grid">
                <div className="funstats-stat-card">
                  <h4>Total Gain</h4>
                  <div className="value">{data.elevation.totalGainFt.toLocaleString()}<span className="unit">ft</span></div>
                </div>
                <div className="funstats-stat-card">
                  <h4>Total Loss</h4>
                  <div className="value">{data.elevation.totalLossFt.toLocaleString()}<span className="unit">ft</span></div>
                </div>
                {data.elevation.peakElevationFt != null && (
                  <div className="funstats-stat-card">
                    <h4>Peak Elevation</h4>
                    <div className="value">{data.elevation.peakElevationFt.toLocaleString()}<span className="unit">ft</span></div>
                  </div>
                )}
                {data.elevation.totalGainFt > 0 && (
                  <div className="funstats-stat-card">
                    <h4>Everests Climbed</h4>
                    <div className="value">{(data.elevation.totalGainFt / 29032).toFixed(1)}x</div>
                    <div className="sub">29,032 ft each</div>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Superlatives */}
          {data.superlatives?.length > 0 && (
            <section className="funstats-panel">
              <h2 className="funstats-panel-title">Journey Superlatives</h2>
              <div className="funstats-stat-grid">
                {data.superlatives.map((s, i) => (
                  <div key={i} className="funstats-stat-card">
                    <h4>{s.title}</h4>
                    <div className="value" style={{ fontSize: '0.95rem' }}>{s.desc}</div>
                    <div className="sub">{s.detail}</div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Achievement Progress */}
          {nextAchievements.length > 0 && (
            <section className="funstats-panel">
              <h2 className="funstats-panel-title">Next Up</h2>
              <div className="funstats-progress-list">
                {nextAchievements.map(a => {
                  const pct = Math.min(100, (a.current / a.target) * 100);
                  return (
                    <div key={a.key} className="funstats-progress-item">
                      <div className="funstats-progress-header">
                        <span className="funstats-progress-title">{a.title}</span>
                        <span className="funstats-progress-nums">{Math.round(a.current)} / {a.target} {a.unit}</span>
                      </div>
                      <div className="funstats-progress-bar-wrap">
                        <div className="funstats-progress-bar" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Records */}
          <section className="funstats-panel">
            <h2 className="funstats-panel-title">Records</h2>
            <div className="funstats-stat-grid">
              {data.longestByDistance && (
                <div className="funstats-stat-card">
                  <h4>Longest Journey</h4>
                  <div className="value">{cd(data.longestByDistance.distanceMiles)?.toFixed(1) ?? '--'}<span className="unit">{distanceUnit}</span></div>
                  <div className="sub">{data.longestByDistance.name || data.longestByDistance.date}</div>
                </div>
              )}
              {data.shortestByDistance && (
                <div className="funstats-stat-card">
                  <h4>Shortest Journey</h4>
                  <div className="value">{cd(data.shortestByDistance.distanceMiles)?.toFixed(2) ?? '--'}<span className="unit">{distanceUnit}</span></div>
                  <div className="sub">{data.shortestByDistance.name || data.shortestByDistance.date}</div>
                </div>
              )}
              {data.longestByTime && (
                <div className="funstats-stat-card">
                  <h4>Longest by Time</h4>
                  <div className="value">{formatCompactDurationMs(data.longestByTime.durationMs)}</div>
                  <div className="sub">{data.longestByTime.name || data.longestByTime.date}</div>
                </div>
              )}
              {data.fastestByAvgSpeed && (
                <div className="funstats-stat-card">
                  <h4>Fastest Avg Speed</h4>
                  <div className="value">{cs(data.fastestByAvgSpeed.avgSpeedMph)?.toFixed(1) ?? '--'}<span className="unit">{speedUnit}</span></div>
                  <div className="sub">{data.fastestByAvgSpeed.name || data.fastestByAvgSpeed.date}</div>
                </div>
              )}
              {data.mostProductiveDay && (
                <div className="funstats-stat-card">
                  <h4>Best Day</h4>
                  <div className="value">{cd(data.mostProductiveDay.distanceMiles)?.toFixed(1) ?? '--'}<span className="unit">{distanceUnit}</span></div>
                  <div className="sub">{formatDate(data.mostProductiveDay.date)}</div>
                </div>
              )}
              {data.mostProductiveMonth && (
                <div className="funstats-stat-card">
                  <h4>Best Month</h4>
                  <div className="value">{cd(data.mostProductiveMonth.distanceMiles)?.toFixed(1) ?? '--'}<span className="unit">{distanceUnit}</span></div>
                  <div className="sub">{formatMonth(data.mostProductiveMonth.month)}</div>
                </div>
              )}
              {data.mostProductiveWeek && (
                <div className="funstats-stat-card">
                  <h4>Best Week</h4>
                  <div className="value">{cd(data.mostProductiveWeek.distanceMiles)?.toFixed(1) ?? '--'}<span className="unit">{distanceUnit}</span></div>
                  <div className="sub">{formatDate(data.mostProductiveWeek.startDate)} – {formatDate(data.mostProductiveWeek.endDate)}</div>
                </div>
              )}
            </div>
          </section>

          {/* Bingo Card */}
          {data.bingoCard?.length === 25 && (
            <section className="funstats-panel">
              <h2 className="funstats-panel-title">Travel Bingo</h2>
              <div className="funstats-bingo-count">{data.bingoCard.filter(c => c.completed).length} / 25</div>
              <div className="funstats-bingo-grid">
                {data.bingoCard.map((cell, i) => (
                  <div
                    key={i}
                    className={`funstats-bingo-cell${cell.completed ? ' completed' : ''}`}
                    title={cell.desc}
                  >
                    <span className="funstats-bingo-label">{cell.label}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Most Visited Locations */}
          {data.clusters?.length > 0 && (
            <section className="funstats-panel">
              <h2 className="funstats-panel-title">Most Visited Locations</h2>
              <ul className="funstats-cluster-list">
                {data.clusters.map((c, i) => (
                  <li key={i} className="funstats-cluster-item">
                    <span className="funstats-cluster-rank">{i + 1}</span>
                    <div className="funstats-cluster-info">
                      <div className="funstats-cluster-coord">{c.lat.toFixed(4)}, {c.lon.toFixed(4)}</div>
                      <div className="funstats-cluster-visits">{c.visitCount} departure{c.visitCount !== 1 ? 's' : ''}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

        </div>
      </main>
    </div>
  );
}
