const zlib = require('zlib');

// Smaller responses aren't worth the work of compressing
const MIN_COMPRESS_BYTES = 1024;

// res.json, but gzipped when the browser accepts it. Nothing between this
// server and the browser compresses JSON, and some responses (the Atlas map
// data) run to megabytes.
function sendCompressedJson(req, res, body) {
    const json = JSON.stringify(body);
    res.type('json');
    res.vary('Accept-Encoding');
    if (json.length < MIN_COMPRESS_BYTES || !req.acceptsEncodings('gzip')) {
        res.send(json);
        return;
    }
    zlib.gzip(json, (err, compressed) => {
        if (err) {
            res.send(json);
            return;
        }
        res.set('Content-Encoding', 'gzip');
        res.send(compressed);
    });
}

module.exports = { sendCompressedJson };
