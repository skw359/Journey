#!/usr/bin/env node
'use strict';

/**
 * Ground-truth probe for "why did the assistant say zero?" — runs the same
 * matching the ask handlers run, directly against the database, and shows
 * what the geocoded place index actually contains.
 *
 * Usage (reads DATABASE_URL from .env, like the server):
 *
 *   node server/scripts/diagnose-places.js "Ellicott City MD"                 # one place
 *   node server/scripts/diagnose-places.js "Ellicott City MD" "Ashburn VA"    # from -> to
 *   node server/scripts/diagnose-places.js --user mason "Salisbury MD"        # one account only
 *
 * Read the output bottom-up:
 *   - NULL counts tell you how much of the index simply hasn't been computed
 *     yet (Fun Stats -> Compute Cities / Compute Places fixes that).
 *   - "similar stored city names" tells you when the geocoder stored a
 *     different name than the one you're asking with.
 *   - The pair section tells you whether ANY single journey's city sequence
 *     contains both places in order — that is exactly what trips_between needs.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { pool, withTenantClient } = require('../db');
const { placeCandidates } = require('../ai/handlers');
const { MIN_ROUTE_MILES } = require('../config');

const VIS = '(distance >= $1 OR force_visible = TRUE)';

function escapeLike(value) {
    return String(value).replace(/([\\%_])/g, '\\$1');
}

async function main() {
    const argv = process.argv.slice(2);
    let user = null;
    const places = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--user') user = argv[++i];
        else places.push(argv[i]);
    }
    if (places.length < 1 || places.length > 2) {
        console.log('Usage: node server/scripts/diagnose-places.js [--user <username>] "<place>" ["<to place>"]');
        process.exit(1);
    }

    const { rows: users } = await pool.query('SELECT id, username FROM users ORDER BY created_at ASC');
    const targets = user ? users.filter((u) => u.username === user) : users;
    if (targets.length === 0) {
        console.log(user ? `No user named "${user}".` : 'No users found.');
        process.exit(1);
    }

    for (const u of targets) {
        console.log(`\n================ user: ${u.username} ================`);
        await withTenantClient(u.id, async (db) => {
            const { rows: [tot] } = await db.query(`
                SELECT COUNT(*)::int AS total,
                       COUNT(*) FILTER (WHERE cities_passed IS NULL)::int AS cities_null,
                       COUNT(*) FILTER (WHERE cities_passed IS NOT NULL AND jsonb_array_length(cities_passed) = 0)::int AS cities_empty,
                       COUNT(*) FILTER (WHERE places_passed IS NULL)::int AS places_null
                FROM routes WHERE ${VIS}`, [MIN_ROUTE_MILES]);
            console.log(`visible journeys: ${tot.total}`
                + ` | cities_passed NULL (never computed): ${tot.cities_null}`
                + ` | computed-but-empty []: ${tot.cities_empty}`
                + ` | places_passed NULL: ${tot.places_null}`);

            const { rows: top } = await db.query(`
                SELECT v AS city, COUNT(*)::int AS journeys
                FROM routes, jsonb_array_elements_text(COALESCE(cities_passed, '[]'::jsonb)) v
                WHERE ${VIS}
                GROUP BY v ORDER BY journeys DESC LIMIT 25`, [MIN_ROUTE_MILES]);
            console.log(`top stored city names: ${top.map((r) => `${r.city} (${r.journeys})`).join(', ') || '(none — index not computed yet)'}`);

            for (const place of places) {
                const cands = placeCandidates(place);
                console.log(`\n-- "${place}"  ->  candidate forms ${JSON.stringify(cands)}`);
                for (const column of ['cities_passed', 'places_passed']) {
                    const { rows: [exact] } = await db.query(`
                        SELECT COUNT(*)::int AS n FROM routes
                        WHERE ${VIS} AND EXISTS (
                            SELECT 1 FROM jsonb_array_elements_text(COALESCE(${column}, '[]'::jsonb)) v
                            WHERE LOWER(v) = ANY($2::text[]))`,
                    [MIN_ROUTE_MILES, cands.map((c) => c.toLowerCase())]);
                    const { rows: [part] } = await db.query(`
                        SELECT COUNT(*)::int AS n FROM routes
                        WHERE ${VIS} AND EXISTS (
                            SELECT 1 FROM jsonb_array_elements_text(COALESCE(${column}, '[]'::jsonb)) v
                            WHERE v ILIKE ANY($2::text[]))`,
                    [MIN_ROUTE_MILES, cands.map((c) => `%${escapeLike(c)}%`)]);
                    console.log(`   ${column}: exact-match journeys ${exact.n} | substring-match ${part.n}`);
                }

                const words = cands[cands.length - 1].toLowerCase().split(/\s+/).filter((w) => w.length >= 4);
                if (words.length) {
                    const { rows: near } = await db.query(`
                        SELECT DISTINCT v AS name
                        FROM routes, jsonb_array_elements_text(COALESCE(cities_passed, '[]'::jsonb)) v
                        WHERE ${VIS} AND LOWER(v) LIKE ANY($2::text[]) LIMIT 12`,
                    [MIN_ROUTE_MILES, words.map((w) => `%${w}%`)]);
                    console.log(`   similar stored city names: ${near.map((r) => r.name).join(', ') || '(none)'}`);
                }
            }

            if (places.length === 2) {
                const [f, t] = places.map((p) => placeCandidates(p).map((c) => c.toLowerCase()));
                // Same union semantics as the trips_between handler: either
                // route-ordered index may prove the FROM-then-TO ordering.
                const op = (col) => `EXISTS (
                    SELECT 1
                    FROM jsonb_array_elements_text(COALESCE(${col}, '[]'::jsonb)) WITH ORDINALITY a(nm, i),
                         jsonb_array_elements_text(COALESCE(${col}, '[]'::jsonb)) WITH ORDINALITY b(nm, j)
                    WHERE b.j > a.i AND LOWER(a.nm) = ANY($2::text[]) AND LOWER(b.nm) = ANY($3::text[])
                )`;
                const ee = (col) => `(LOWER(${col}->>0) = ANY($2::text[])
                    AND LOWER(${col}->>(jsonb_array_length(${col})-1)) = ANY($3::text[]))`;
                const { rows: [pair] } = await db.query(`
                    SELECT
                        COUNT(*) FILTER (WHERE ${op('cities_passed')})::int AS via_cities,
                        COUNT(*) FILTER (WHERE ${op('places_passed')})::int AS via_places,
                        COUNT(*) FILTER (WHERE ${op('cities_passed')} OR ${op('places_passed')})::int AS ordered_union,
                        COUNT(*) FILTER (WHERE ${ee('cities_passed')} OR ${ee('places_passed')})::int AS end_to_end
                    FROM routes WHERE ${VIS}`, [MIN_ROUTE_MILES, f, t]);
                console.log(`\n-- pair "${places[0]}" -> "${places[1]}" (what trips_between sees):`
                    + ` in order via cities: ${pair.via_cities}`
                    + ` | via places: ${pair.via_places}`
                    + ` | either: ${pair.ordered_union}`
                    + ` | strict end-to-end: ${pair.end_to_end}`);

                const { rows: samples } = await db.query(`
                    SELECT id, name, to_char(start_time, 'YYYY-MM-DD') AS d, cities_passed, places_passed
                    FROM routes
                    WHERE ${VIS} AND (
                        EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(cities_passed, '[]'::jsonb)) v
                                WHERE LOWER(v) = ANY($2::text[]) OR LOWER(v) = ANY($3::text[]))
                        OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(places_passed, '[]'::jsonb)) v
                                WHERE LOWER(v) = ANY($2::text[]) OR LOWER(v) = ANY($3::text[])))
                    ORDER BY start_time DESC NULLS LAST LIMIT 5`, [MIN_ROUTE_MILES, f, t]);
                console.log('   recent journeys touching either place (cities first -> last):');
                for (const s of samples) {
                    const arr = Array.isArray(s.cities_passed) ? s.cities_passed : [];
                    const shown = arr.length > 8 ? [...arr.slice(0, 4), `… ${arr.length - 8} more …`, ...arr.slice(-4)] : arr;
                    const parr = Array.isArray(s.places_passed) ? s.places_passed : [];
                    const pshown = parr.length > 6 ? [...parr.slice(0, 3), '…', ...parr.slice(-2)] : parr;
                    const ptxt = parr.length ? ` | places(${parr.length}): [${pshown.join(' -> ')}]` : '';
                    console.log(`     ${s.d || 'undated'} | ${s.name} | [${shown.join(' -> ')}]${ptxt}`);
                }
                if (samples.length === 0) console.log('     (none)');
            }
        });
    }

    await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
