// Dev-only offline mock for UI work (STV_MOCK=1). Fakes the Live screen GQL query
// with local thumbnails so the stream grid can be styled without Twitch access.
'use strict';

const NAMES = [
    ['PixelPilot', 'Speedrunning the whole trilogy, no deaths today', 'Celeste', 'en'],
    ['NordicNoodle', 'Chill coding & lofi | building a Twitch client', 'Software and Game Development', 'en'],
    ['LunaLumen', 'Ranked grind to Immortal !socials', 'VALORANT', 'en'],
    ['Kartoffelkopf', 'Gemütlicher Abend mit Factorio – Megabase Tag 12', 'Factorio', 'de'],
    ['RetroRaven', 'Blind playthrough – first time ever!', 'Hollow Knight', 'en'],
    ['ChefChaos', 'Cooking ramen from scratch, ask me anything', 'Food & Drink', 'en'],
    ['MidnightMoth', 'Late night horror marathon 🕯️', 'Silent Hill 2', 'en'],
    ['TurboTanuki', 'World record attempts all day', 'Mario Kart 8 Deluxe', 'ja'],
    ['StellarSam', 'Building a space station, viewers pick modules', 'Space Engineers', 'en'],
    ['BassBarista', 'Live music production – making a track from zero', 'Music', 'en'],
    ['ElPatoLoco', 'Torneo comunitario – ¡únete!', 'Rocket League', 'es'],
    ['QuietQuasar', 'Just chatting & coffee ☕', 'Just Chatting', 'en']
];

function liveResponse() {
    const edges = NAMES.map(([name, title, game, lang], i) => ({
        cursor: 'c' + i,
        node: {
            type: 'live',
            game: { displayName: game, id: String(1000 + i) },
            isMature: false,
            title,
            id: String(4000 + i),
            previewImageURL: `app://stv/__test/img/thumb${i}.jpg`,
            viewersCount: Math.round(52000 / (i + 1.3)),
            createdAt: new Date(Date.now() - (i + 1) * 47 * 60000).toISOString(),
            broadcaster: {
                roles: { isPartner: i % 3 === 0 },
                id: String(9000 + i),
                login: name.toLowerCase(),
                displayName: name,
                language: lang,
                profileImageURL: `app://stv/__test/img/avatar${i}.jpg`
            }
        }
    }));
    return { data: { streams: { pageInfo: { hasNextPage: false }, edges } } };
}

// Twitch-style master playlist, variants served locally (web/__test).
const MASTER =
    '#EXTM3U\n' +
    '#EXT-X-TWITCH-INFO:NODE="mock",MANIFEST-NODE="mock",SERVER-TIME="1700000000.00",USER-IP="127.0.0.1",SERVING-ID="mock",CLUSTER="mock",B="false",REGION="EU",BROADCAST-ID="1",STREAM-TIME="100.0"\n' +
    '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="720p30 (source)",AUTOSELECT=YES,DEFAULT=YES\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=2700000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",VIDEO="chunked",FRAME-RATE=30.000\n' +
    'app://stv/__test/v720/index.m3u8\n' +
    '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="360p30",NAME="360p",AUTOSELECT=YES,DEFAULT=YES\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=950000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",VIDEO="360p30",FRAME-RATE=30.000\n' +
    'app://stv/__test/v360/index.m3u8\n';

module.exports = function mock({ url, body, checkResult }) {
    const ok = (obj) => ({ status: 200, responseText: JSON.stringify(obj), checkResult: checkResult || 0 });
    const token = { value: JSON.stringify({ chansub: { restricted_bitrates: [] } }), signature: 'mock' };
    if (url.includes('usher.ttvnw.net')) return { status: 200, responseText: MASTER, checkResult: checkResult || 0 };
    if (url.includes('gql.twitch.tv') && body && body.includes('PlaybackAccessToken')) {
        return ok({ data: { streamPlaybackAccessToken: token, videoPlaybackAccessToken: token } });
    }
    if (url.includes('gql.twitch.tv') && body && body.includes('streams(first')) return ok(liveResponse());
    if (url.includes('gql.twitch.tv')) return ok({ data: {} });
    return { status: 404, responseText: '', checkResult: checkResult || 0 };
};
