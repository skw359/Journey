const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const { FFMPEG_PATH, FFPROBE_PATH, VIDEO_MAX_DIMENSION, VIDEO_PRESET } = require('../config');

const POSTER_MAX_DIMENSION = 1280;
// Already-H.264 sources above this bitrate are re-encoded so they stream smoothly off a home server.
const REMUX_MAX_BITRATE = 12_000_000;
const HDR_TRANSFERS = new Set(['arib-std-b67', 'smpte2084']);
// Newer iPhones add an APAC spatial-audio track ffmpeg can't decode, so pick the audio stream explicitly.
const DECODABLE_AUDIO = new Set(['aac', 'mp3', 'alac', 'ac3', 'eac3', 'opus', 'vorbis', 'flac']);

let capabilitiesPromise = null;

function run(cmd, args, onSpawn) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        try {
            // Keep transcodes from starving the web server on small machines.
            os.setPriority(child.pid, 10);
        } catch {
            // Not fatal (pid may be undefined if spawn failed; that surfaces via 'error').
        }
        onSpawn?.(child);

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
        child.on('error', reject);
        child.on('close', (code, signal) => {
            if (code === 0) return resolve(stdout);
            const detail = stderr.trim().split('\n').slice(-3).join(' | ');
            reject(new Error(`${path.basename(cmd)} exited with ${signal || code}${detail ? `: ${detail}` : ''}`));
        });
    });
}

// Resolves once per process: whether ffmpeg/ffprobe exist and whether HDR tone mapping (zscale) is available.
function getCapabilities() {
    if (!capabilitiesPromise) {
        capabilitiesPromise = (async () => {
            try {
                const filters = await run(FFMPEG_PATH, ['-hide_banner', '-filters']);
                await run(FFPROBE_PATH, ['-hide_banner', '-version']);
                return {
                    available: true,
                    toneMapping: /\bzscale\b/.test(filters) && /\btonemap\b/.test(filters),
                };
            } catch {
                return { available: false, toneMapping: false };
            }
        })();
    }
    return capabilitiesPromise;
}

async function probe(file) {
    const out = await run(FFPROBE_PATH, [
        '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
    ]);
    return JSON.parse(out);
}

function parseRate(rate) {
    const [num, den] = String(rate || '').split('/').map(Number);
    return num > 0 && den > 0 ? num / den : 0;
}

function rotationOf(stream) {
    const matrix = (stream.side_data_list || []).find((d) => d.rotation != null);
    const degrees = matrix ? Number(matrix.rotation) : Number(stream.tags?.rotate || 0);
    return ((Math.round(degrees) % 360) + 360) % 360;
}

// Summarises an ffprobe result into what the converter needs, or null if there is no video stream.
function describe(info) {
    const streams = info.streams || [];
    const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
    if (!video) return null;
    const audio = streams.find((s) => s.codec_type === 'audio'
        && (DECODABLE_AUDIO.has(s.codec_name) || s.codec_name?.startsWith('pcm_')));
    const sideways = rotationOf(video) % 180 !== 0;
    const durationSec = parseFloat(info.format?.duration) || parseFloat(video.duration) || 0;

    return {
        video,
        audio,
        width: sideways ? video.height : video.width,
        height: sideways ? video.width : video.height,
        fps: parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate),
        bitRate: Number(info.format?.bit_rate) || 0,
        durationMs: Math.round(durationSec * 1000),
        hdr: HDR_TRANSFERS.has(video.color_transfer),
    };
}

// True when the source already plays everywhere and only needs moving into a fast-start MP4.
function canRemux(desc) {
    const { video, audio } = desc;
    return video.codec_name === 'h264'
        && ['yuv420p', 'yuvj420p'].includes(video.pix_fmt)
        && !desc.hdr
        && Math.max(desc.width, desc.height) <= VIDEO_MAX_DIMENSION
        && desc.fps <= 61
        && desc.bitRate > 0 && desc.bitRate <= REMUX_MAX_BITRATE
        && (!audio || audio.codec_name === 'aac');
}

function fitWithin(max) {
    // Shrinks to fit max x max without ever upscaling; autorotation has already been applied to iw/ih.
    return `scale=w='min(${max},iw)':h='min(${max},ih)':force_original_aspect_ratio=decrease`;
}

function videoFilters(desc, toneMap) {
    const filters = [`${fitWithin(VIDEO_MAX_DIMENSION)}:force_divisible_by=2`];
    if (desc.hdr && toneMap) {
        // HLG/PQ (iPhone HDR) -> SDR BT.709. Downscale first: float tone mapping at 4K is slow.
        filters.push(
            `zscale=tin=${desc.video.color_transfer}:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=100`,
            'format=gbrpf32le',
            'zscale=p=bt709',
            'tonemap=tonemap=hable:desat=0',
            'zscale=t=bt709:m=bt709:r=tv',
        );
    }
    filters.push('format=yuv420p');
    return filters.join(',');
}

// Writes a browser-friendly MP4 (H.264 + AAC, fast start) to `output`.
function convert(input, output, desc, { remux, toneMap }, onSpawn) {
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-i', input, '-map', `0:${desc.video.index}`];
    if (desc.audio) args.push('-map', `0:${desc.audio.index}`);

    if (remux) {
        args.push('-c', 'copy');
    } else {
        args.push(
            '-vf', videoFilters(desc, toneMap),
            '-fpsmax', '60',
            '-c:v', 'libx264', '-preset', VIDEO_PRESET, '-crf', '23',
            '-maxrate', '8M', '-bufsize', '16M', '-profile:v', 'high',
        );
        if (desc.hdr && toneMap) {
            args.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709');
        }
        if (desc.audio) args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2');
    }

    args.push('-map_chapters', '-1', '-movflags', '+faststart', '-max_muxing_queue_size', '1024', '-f', 'mp4', output);
    return run(FFMPEG_PATH, args, onSpawn);
}

function extractPoster(input, output, durationMs, onSpawn) {
    const seek = durationMs > 2000 ? '1' : '0';
    return run(FFMPEG_PATH, [
        '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
        '-ss', seek, '-i', input,
        '-frames:v', '1', '-vf', fitWithin(POSTER_MAX_DIMENSION), '-q:v', '3',
        '-f', 'image2', '-c:v', 'mjpeg', output,
    ], onSpawn);
}

module.exports = {
    getCapabilities,
    probe,
    describe,
    canRemux,
    convert,
    extractPoster,
};
