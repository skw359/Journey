import { useState, useEffect, useMemo } from 'react';
import { feature } from 'topojson-client';

const FIPS_TO_ABBR = {
  '01':'AL','02':'AK','04':'AZ','05':'AR','06':'CA','08':'CO','09':'CT',
  '10':'DE','11':'DC','12':'FL','13':'GA','15':'HI','16':'ID','17':'IL',
  '18':'IN','19':'IA','20':'KS','21':'KY','22':'LA','23':'ME','24':'MD',
  '25':'MA','26':'MI','27':'MN','28':'MS','29':'MO','30':'MT','31':'NE',
  '32':'NV','33':'NH','34':'NJ','35':'NM','36':'NY','37':'NC','38':'ND',
  '39':'OH','40':'OK','41':'OR','42':'PA','44':'RI','45':'SC','46':'SD',
  '47':'TN','48':'TX','49':'UT','50':'VT','51':'VA','53':'WA','54':'WV',
  '55':'WI','56':'WY',
};

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

function geoToPath(geometry) {
  const rings = geometry.type === 'MultiPolygon'
    ? geometry.coordinates.flat()
    : geometry.coordinates;

  return rings.map(ring => {
    const pts = ring.map(([x, y], i) =>
      (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1)
    );
    return pts.join('') + 'Z';
  }).join('');
}

export default function USStateMap({ visitedStates = [] }) {
  const [topology, setTopology] = useState(null);
  const [hovered, setHovered] = useState(null);

  const visitedSet = useMemo(() => new Set(visitedStates), [visitedStates]);

  useEffect(() => {
    fetch('/states-albers-10m.json')
      .then(r => r.json())
      .then(setTopology)
      .catch(() => {});
  }, []);

  const states = useMemo(() => {
    if (!topology) return [];
    const fc = feature(topology, topology.objects.states);
    return fc.features.map(f => ({
      abbr: FIPS_TO_ABBR[f.id] || f.id,
      name: f.properties.name,
      path: geoToPath(f.geometry),
    }));
  }, [topology]);

  if (!states.length) return null;

  return (
    <div className="us-map-container">
      <svg
        viewBox="-60 10 1020 600"
        className="us-map-svg"
        role="img"
        aria-label="Map of US states visited"
      >
        {states.map(s => {
          const visited = visitedSet.has(s.abbr);
          const isHovered = hovered === s.abbr;
          return (
            <path
              key={s.abbr}
              d={s.path}
              className={`us-map-state${visited ? ' visited' : ''}${isHovered ? ' hovered' : ''}`}
              onMouseEnter={() => setHovered(s.abbr)}
              onMouseLeave={() => setHovered(null)}
            >
              <title>{s.name}{visited ? ' ✓' : ''}</title>
            </path>
          );
        })}
      </svg>
      {hovered && (
        <div className="us-map-tooltip">
          {STATE_NAMES[hovered] || hovered}
          {visitedSet.has(hovered) && <span className="us-map-tooltip-check"> ✓</span>}
        </div>
      )}
    </div>
  );
}
