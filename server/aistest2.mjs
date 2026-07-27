import WebSocket from 'ws';
const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
const seen = new Map();
let msgs = 0;
const t0 = Date.now();
ws.on('open', () => {
  ws.send(JSON.stringify({
    APIKey: process.env.AISSTREAM_KEY,
    BoundingBoxes: [[[57.0, 20.0], [60.5, 29.0]]],
    FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
  }));
});
ws.on('message', (raw) => {
  msgs++;
  try {
    const m = JSON.parse(raw.toString());
    const mmsi = m.MetaData?.MMSI;
    const p = m.Message?.PositionReport;
    if (mmsi && p) seen.set(mmsi, { lat: p.Latitude, lon: p.Longitude });
  } catch {}
});
const report = () => {
  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  const box = (s,w,n,e)=>[...seen.values()].filter(v=>v.lat>=s&&v.lat<=n&&v.lon>=w&&v.lon<=e).length;
  console.log(`${mins} min: sõnumeid ${msgs}, unikaalseid ${seen.size} | Soome laht ${box(59.3,23.5,60.0,28.5)} | Väinameri ${box(58.3,22.0,59.2,23.7)} | Liivi laht ${box(57.4,22.8,58.5,24.8)}`);
};
[60000,180000,300000].forEach(ms => setTimeout(report, ms));
setTimeout(() => { ws.close(); process.exit(0); }, 305000);
