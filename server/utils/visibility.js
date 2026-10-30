const { MIN_ROUTE_MILES } = require('../config');

// Visible journeys: at least MIN_ROUTE_MILES long, or restored from Trash (force_visible).

/** @param {string} minParam placeholder holding MIN_ROUTE_MILES, e.g. '$1' */
function visibleSql(minParam, alias = '') {
    const p = alias ? `${alias}.` : '';
    return `(${p}distance >= ${minParam} OR ${p}force_visible = TRUE)`;
}

function isVisible(row, minMiles = MIN_ROUTE_MILES) {
    return (row.distance != null && Number(row.distance) >= minMiles) || row.force_visible === true;
}

module.exports = { visibleSql, isVisible, MIN_ROUTE_MILES };
