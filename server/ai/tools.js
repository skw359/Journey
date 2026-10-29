'use strict';

const { PERIOD_TOKENS, PERIOD_DEFS } = require('./periods');

/**
 * Tool schemas for the Journey ask layer.
 *
 * Every design choice here exists to remove a degree of freedom from the model:
 *
 *   - Enums, not free text. The only free-text arguments in the entire surface
 *     are the place names on place_visits and trips_between, and they are
 *     matched server-side against values that already exist in the user's data
 *     rather than trusted verbatim.
 *   - No dates. Periods are tokens; server-side code resolves them. The model
 *     cannot emit 2026-08-17 except through the explicitly-flagged `custom`
 *     escape hatch.
 *   - No arithmetic. Every tool returns finished numbers plus a preformatted
 *     `summary` string. The model rephrases; it never computes.
 *   - additionalProperties: false everywhere, so an invented argument is a
 *     schema violation we can detect rather than something we silently accept.
 *
 * The shape is Ollama / OpenAI `tools` format and is passed through untouched.
 */

const TRAVEL_MODES = ['foot', 'scooter', 'drive', 'train', 'metro', 'flight'];

// 'any' is an explicit member rather than "omit the field to mean any",
// because small models are more reliable at picking a listed value than at
// deciding to leave an optional field out.
const TRAVEL_MODE_ENUM = ['any', ...TRAVEL_MODES];

const METRICS = [
    'distance',
    'duration',
    'avg_speed',
    'top_speed',
    'elevation_gain',
    'journey_count',
];

const GRANULARITY = ['city', 'place'];

const SORTS = [
    'distance_desc',
    'distance_asc',
    'start_time_desc',
    'start_time_asc',
    'avg_speed_desc',
    'top_speed_desc',
    'duration_desc',
];

const periodProperty = (description) => ({
    type: 'string',
    enum: PERIOD_TOKENS,
    description,
});

const travelModeProperty = {
    type: 'string',
    enum: TRAVEL_MODE_ENUM,
    description:
        'Restrict to a single travel mode. Use "any" unless the question names a mode. '
        + 'Map everyday words: driving/car/road trip -> drive, walking/running/hiking -> foot, '
        + 'biking/scooter -> scooter, subway/underground -> metro, plane/flying -> flight.',
};

const customDateProperties = {
    start_date: {
        type: 'string',
        description: 'Only when period is "custom". Inclusive start date, YYYY-MM-DD.',
    },
    end_date: {
        type: 'string',
        description: 'Only when period is "custom". Inclusive end date, YYYY-MM-DD.',
    },
};

// stats_summary extras. Both are computed SERVER-side; the model only
// declares intent. The explicit 'none' members exist for the same reason
// travel_mode has 'any' — small models are more reliable picking a listed
// value than deciding to leave an optional field out — and validateToolCall
// normalizes 'none' away.
const averagePerProperty = {
    type: 'string',
    enum: ['none', 'day', 'week', 'month'],
    description:
        'Only when the question asks for a typical rate: "usually", "typically", "on average" '
        + 'per day, week or month. The server computes the average — never compute it yourself. '
        + 'Use "none" for plain totals.',
};

const excludeProperties = {
    exclude: {
        type: 'string',
        enum: ['none', ...PERIOD_TOKENS.filter((t) => t !== 'all_time')],
        description:
            'Only when the question excludes a stretch of time: "excluding last week", "not '
            + 'counting March", "ignoring Aug 17-23". Choose the matching period token, or '
            + '"custom" with exclude_start_date and exclude_end_date when explicit dates or a '
            + 'named month are excluded. Use "none" when nothing is excluded.',
    },
    exclude_start_date: {
        type: 'string',
        description: 'Only when exclude is "custom". Inclusive start of the excluded range, YYYY-MM-DD.',
    },
    exclude_end_date: {
        type: 'string',
        description: 'Only when exclude is "custom". Inclusive end of the excluded range, YYYY-MM-DD.',
    },
};

const TOOLS = [
    {
        type: 'function',
        function: {
            name: 'compare_periods',
            description:
                'Compare one numeric metric between two time periods. Use this for any question '
                + 'phrased as more/less/faster/slower/further than another period, or any question '
                + 'containing "compared to", "versus", "than last ...". Returns both values, the '
                + 'absolute difference and the percentage change.',
            parameters: {
                type: 'object',
                properties: {
                    metric: {
                        type: 'string',
                        enum: METRICS,
                        description:
                            'What to compare. distance = miles/km travelled. duration = time in motion. '
                            + 'avg_speed = mean speed across journeys. top_speed = fastest single reading. '
                            + 'elevation_gain = cumulative climb. journey_count = number of journeys.',
                    },
                    period_a: periodProperty(
                        'The recent or primary period — the one the user is asking about.',
                    ),
                    period_b: periodProperty(
                        'The baseline period being compared against, e.g. the "than last week" side.',
                    ),
                    travel_mode: travelModeProperty,
                    ...customDateProperties,
                },
                required: ['metric', 'period_a', 'period_b', 'travel_mode'],
                additionalProperties: false,
            },
        },
    },

    {
        type: 'function',
        function: {
            name: 'new_places',
            description:
                'Find locations visited during one period that were NOT visited during a baseline '
                + 'period. Use this for "new places", "somewhere I have not been", "places I did not '
                + 'go last week", "first time visiting". Returns the set difference plus a count of '
                + 'journeys whose location data is missing, so the answer can be caveated honestly.',
            parameters: {
                type: 'object',
                properties: {
                    period: periodProperty('The period to look for new locations in.'),
                    compared_to: periodProperty('The baseline period that defines "already visited".'),
                    granularity: {
                        type: 'string',
                        enum: GRANULARITY,
                        description:
                            'city = towns and cities passed through. place = named points of interest '
                            + 'such as parks, shops and landmarks. Default to "city" unless the question '
                            + 'clearly means specific venues.',
                    },
                    ...customDateProperties,
                },
                required: ['period', 'compared_to', 'granularity'],
                additionalProperties: false,
            },
        },
    },

    {
        type: 'function',
        function: {
            name: 'stats_summary',
            description:
                'Totals and averages for a single period with no comparison. Use this for "how far '
                + 'did I go", "how much did I travel", "what was my average speed", "how many trips" '
                + 'when only one period is mentioned. Also handles typical rates ("how much do I '
                + 'usually drive per week") via average_per, and questions that exclude a stretch '
                + '("excluding Aug 17-23") via exclude.',
            parameters: {
                type: 'object',
                properties: {
                    period: periodProperty('The period to summarise.'),
                    travel_mode: travelModeProperty,
                    average_per: averagePerProperty,
                    ...excludeProperties,
                    ...customDateProperties,
                },
                required: ['period', 'travel_mode'],
                additionalProperties: false,
            },
        },
    },

    {
        type: 'function',
        function: {
            name: 'list_journeys',
            description:
                'List individual journeys, ordered. Use this for "show me", "which trip", '
                + '"my longest", "my fastest", "what did I do on ..." — anything that wants specific '
                + 'journeys rather than an aggregate.',
            parameters: {
                type: 'object',
                properties: {
                    period: periodProperty('The period to list journeys from.'),
                    travel_mode: travelModeProperty,
                    sort: {
                        type: 'string',
                        enum: SORTS,
                        description:
                            'Ordering. Use distance_desc for "longest", avg_speed_desc or '
                            + 'top_speed_desc for "fastest", start_time_desc for "most recent".',
                    },
                    limit: {
                        type: 'integer',
                        minimum: 1,
                        maximum: 25,
                        description: 'How many journeys to return. Use 5 unless the question asks for more.',
                    },
                    ...customDateProperties,
                },
                required: ['period', 'travel_mode', 'sort', 'limit'],
                additionalProperties: false,
            },
        },
    },

    {
        type: 'function',
        function: {
            name: 'place_visits',
            description:
                'How often a specific named location was visited, and when — including how often it '
                + 'was the start, the end, or a pass-through point. Use this when the question names '
                + 'exactly ONE location, e.g. "how many times did I go to Seattle", "have I ever '
                + 'been to Ocean City", "when was I last at Green Lake Park", "how many times have '
                + 'I traveled in and out of Salisbury". '
                + 'If the question names both a start AND a destination, use trips_between instead.',
            parameters: {
                type: 'object',
                properties: {
                    place: {
                        type: 'string',
                        description:
                            'The location name exactly as the user wrote it, e.g. "Salisbury MD". Do '
                            + 'not expand, translate or correct it — server-side matching handles '
                            + 'capitalization, state suffixes and partial names.',
                    },
                    period: periodProperty('The period to search within. Use all_time unless a period is named.'),
                    granularity: {
                        type: 'string',
                        enum: GRANULARITY,
                        description: 'city for towns and cities, place for named points of interest.',
                    },
                    ...customDateProperties,
                },
                required: ['place', 'period', 'granularity'],
                additionalProperties: false,
            },
        },
    },

    {
        type: 'function',
        function: {
            name: 'trips_between',
            description:
                'Count journeys from one named location to another, using the ordered city and '
                + 'place sequences of each journey. Use this whenever the question names BOTH a starting '
                + 'place and a destination: "how many times have I gone from A to B", "trips '
                + 'between A and B", "when did I last go from A to B". For a single named '
                + 'location use place_visits instead.',
            parameters: {
                type: 'object',
                properties: {
                    from_place: {
                        type: 'string',
                        description:
                            'The starting location exactly as the user wrote it — a city ("Ellicott '
                            + 'City MD") or a named place ("Hyattsville Fire Department"). Do not '
                            + 'expand, translate or correct it — server-side matching handles '
                            + 'capitalization, state suffixes and partial or word-level names.',
                    },
                    to_place: {
                        type: 'string',
                        description:
                            'The destination location exactly as the user wrote it. Same matching '
                            + 'rules as from_place. For "between A and B", A is from_place and B '
                            + 'is to_place; the reverse direction is reported automatically.',
                    },
                    period: periodProperty('The period to search within. Use all_time unless a period is named.'),
                    travel_mode: travelModeProperty,
                    ...customDateProperties,
                },
                required: ['from_place', 'to_place', 'period', 'travel_mode'],
                additionalProperties: false,
            },
        },
    },

    {
        type: 'function',
        function: {
            name: 'travel_mode_breakdown',
            description:
                'Split a period by travel mode, showing distance, time and journey count per mode. '
                + 'Use this for "how much of my travel was driving", "do I walk more than I drive", '
                + '"breakdown by mode".',
            parameters: {
                type: 'object',
                properties: {
                    period: periodProperty('The period to break down.'),
                    ...customDateProperties,
                },
                required: ['period'],
                additionalProperties: false,
            },
        },
    },
];

const TOOL_NAMES = TOOLS.map((t) => t.function.name);
const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.function.name, t]));

/**
 * Validate a tool call against its schema before any SQL runs.
 *
 * Returns { ok: true, name, args } or { ok: false, code, message }. There is no
 * repair path and no second attempt at the model: an invalid call becomes a
 * canned capability message. Retrying a small model on a malformed call mostly
 * produces a differently malformed call while doubling latency.
 */
/**
 * Small models sometimes emit a period-shaped argument as a nested OBJECT —
 * observed live from gemma at temperature 0, identically every time:
 *
 *   exclude: { custom: true, exclude_start_date: '2026-08-17',
 *              exclude_end_date: '2026-08-23' }
 *
 * instead of the flat token + date fields the schema asks for. The encoding is
 * complete and unambiguous, so flatten it deterministically before validation:
 * this is parsing a known shape, not repairing a guess — nothing is invented,
 * nothing is retried, and an object we cannot read stays in place so the enum
 * check rejects it honestly.
 */
const PERIOD_ARG_DATES = {
    period: ['start_date', 'end_date'],
    period_a: ['start_date', 'end_date'],
    period_b: ['start_date', 'end_date'],
    compared_to: ['start_date', 'end_date'],
    exclude: ['exclude_start_date', 'exclude_end_date'],
};

function flattenPeriodObjects(tool, args) {
    const schema = tool.function.parameters;
    const out = { ...args };
    for (const [field, [startArg, endArg]] of Object.entries(PERIOD_ARG_DATES)) {
        if (!(field in schema.properties)) continue;
        const v = out[field];
        if (!v || typeof v !== 'object' || Array.isArray(v)) continue;

        // Hoist nested dates to their canonical top-level names (either
        // spelling), never overwriting dates the model already put there.
        const nestedStart = v[startArg] ?? v.start_date ?? v.exclude_start_date;
        const nestedEnd = v[endArg] ?? v.end_date ?? v.exclude_end_date;
        if (typeof nestedStart === 'string' && !(startArg in args)) out[startArg] = nestedStart;
        if (typeof nestedEnd === 'string' && !(endArg in args)) out[endArg] = nestedEnd;

        // Recover the token: an explicit period/token key, a token-named key
        // with a truthy value ({ custom: true }), or dates alone = custom.
        let token = null;
        if (typeof v.period === 'string') token = v.period;
        else if (typeof v.token === 'string') token = v.token;
        else {
            const flagged = PERIOD_TOKENS.filter((t) => v[t] === true || v[t] === 'true');
            if (flagged.length === 1) token = flagged[0];
        }
        if (!token && typeof nestedStart === 'string' && typeof nestedEnd === 'string') token = 'custom';
        if (token) out[field] = token;
    }
    return out;
}

function validateToolCall(name, rawArgs) {
    const tool = TOOL_BY_NAME.get(name);
    if (!tool) {
        return { ok: false, code: 'unknown_tool', message: `No such tool: ${name}` };
    }

    let args = rawArgs;
    if (typeof args === 'string') {
        try {
            args = JSON.parse(args);
        } catch {
            return { ok: false, code: 'bad_json', message: 'Tool arguments were not valid JSON' };
        }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        return { ok: false, code: 'bad_args', message: 'Tool arguments must be a JSON object' };
    }

    args = flattenPeriodObjects(tool, args);

    const schema = tool.function.parameters;
    const known = new Set(Object.keys(schema.properties));
    const cleaned = {};

    for (const [key, value] of Object.entries(args)) {
        if (!known.has(key)) {
            return { ok: false, code: 'unknown_argument', message: `${name} has no argument "${key}"` };
        }
        if (value === null || value === undefined || value === '') continue;
        cleaned[key] = value;
    }

    for (const key of schema.required) {
        if (!(key in cleaned)) {
            return { ok: false, code: 'missing_argument', message: `${name} requires "${key}"` };
        }
    }

    for (const [key, value] of Object.entries(cleaned)) {
        const prop = schema.properties[key];
        if (prop.enum && !prop.enum.includes(value)) {
            return {
                ok: false,
                code: 'bad_enum_value',
                message: `${name}.${key} must be one of: ${prop.enum.join(', ')} (got ${JSON.stringify(value)})`,
            };
        }
        if (prop.type === 'integer') {
            const n = Number(value);
            if (!Number.isInteger(n)) {
                return { ok: false, code: 'bad_integer', message: `${name}.${key} must be an integer` };
            }
            if (prop.minimum !== undefined && n < prop.minimum) {
                return { ok: false, code: 'out_of_range', message: `${name}.${key} must be >= ${prop.minimum}` };
            }
            if (prop.maximum !== undefined && n > prop.maximum) {
                return { ok: false, code: 'out_of_range', message: `${name}.${key} must be <= ${prop.maximum}` };
            }
            cleaned[key] = n;
        }
        if (prop.type === 'string' && typeof value !== 'string') {
            return { ok: false, code: 'bad_type', message: `${name}.${key} must be a string` };
        }
    }

    // Cross-field rule: custom periods need their dates, and non-custom periods
    // must not smuggle dates in.
    const periodFields = ['period', 'period_a', 'period_b', 'compared_to'].filter((f) => f in cleaned);
    const usesCustom = periodFields.some((f) => cleaned[f] === 'custom');
    const hasDates = 'start_date' in cleaned || 'end_date' in cleaned;
    if (usesCustom && !('start_date' in cleaned && 'end_date' in cleaned)) {
        return {
            ok: false,
            code: 'missing_custom_range',
            message: 'period "custom" requires both start_date and end_date',
        };
    }
    if (!usesCustom && hasDates) {
        delete cleaned.start_date;
        delete cleaned.end_date;
    }

    // stats_summary extras: normalize the explicit "none" members away, then
    // hold the exclusion window to the same custom-range discipline as period.
    if (cleaned.average_per === 'none') delete cleaned.average_per;
    if (cleaned.exclude === 'none') delete cleaned.exclude;
    const hasBothExcludeDates = 'exclude_start_date' in cleaned && 'exclude_end_date' in cleaned;
    if (!('exclude' in cleaned) && hasBothExcludeDates) {
        // Deterministic fill-in, not model repair: both dates name the range
        // completely — the same spirit as a missing period_b defaulting to its
        // comparison partner instead of failing the whole call.
        cleaned.exclude = 'custom';
    }
    if (cleaned.exclude === 'custom' && !hasBothExcludeDates) {
        return {
            ok: false,
            code: 'missing_custom_range',
            message: 'exclude "custom" requires both exclude_start_date and exclude_end_date',
        };
    }
    if (cleaned.exclude !== 'custom' && ('exclude_start_date' in cleaned || 'exclude_end_date' in cleaned)) {
        delete cleaned.exclude_start_date;
        delete cleaned.exclude_end_date;
    }

    return { ok: true, name, args: cleaned };
}

/** One-line capability message, used whenever the model fails to produce a valid call. */
function capabilityMessage() {
    return [
        'I can answer questions about your journeys, such as:',
        '  • how far you travelled in a period, or compared with another period',
        '  • which cities or places were new to you',
        '  • your average or top speed, overall or for one travel mode',
        '  • your longest, fastest or most recent journeys',
        '  • how often you visited a specific place',
        '  • your typical travel per day, week or month — with any stretch excluded',
        '  • how many times you went from one place to another',
        '  • a breakdown of your travel by mode',
    ].join('\n');
}

module.exports = {
    TOOLS,
    TOOL_NAMES,
    TOOL_BY_NAME,
    TRAVEL_MODES,
    TRAVEL_MODE_ENUM,
    METRICS,
    GRANULARITY,
    SORTS,
    PERIOD_DEFS,
    validateToolCall,
    capabilityMessage,
};
