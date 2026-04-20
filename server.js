const path = require('path');
const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const cors = require('cors');

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const AMAP_WEB_KEY = process.env.AMAP_WEB_KEY;

const AMAP_DRIVING_API = 'https://restapi.amap.com/v3/direction/driving';
const AMAP_GEOCODE_API = 'https://restapi.amap.com/v3/geocode/geo';

if (!AMAP_WEB_KEY) {
  console.warn('[WARN] AMAP_WEB_KEY is missing. Please configure .env before using route/geocode APIs.');
}

app.use(express.static(__dirname));
app.use(cors());
app.use((req, _res, next) => {
  console.log('请求:', req.method, req.url);
  next();
});

app.use((req, _res, next) => {
  console.log('====== API Request ======');
  console.log('Path:', req.path);
  console.log('Query:', req.query);
  console.log('Time:', new Date().toISOString());
  next();
});

const routeCache = new Map();

const closurePoints = [
  { name: 'K21+730 起点', lng: 87.185, lat: 43.885, desc: '封闭段起点', color: '#d32f2f' },
  { name: 'K64+300 终点', lng: 86.637, lat: 43.910, desc: '封闭段终点', color: '#d32f2f' }
];

const westRoute = [
  [87.278, 44.009], [87.207, 43.930], [87.18, 43.92],
  [87.10, 43.93], [86.82, 43.97], [86.78, 43.92],
  [86.68, 43.89], [86.637, 43.91]
];

const g312Route = [
  [86.88, 44.18], [86.600, 44.182], [86.65, 44.12],
  [86.70, 44.02], [86.68, 43.89], [86.637, 43.91]
];

const scenicPoints = [
  { name: '百里丹霞观景台', lng: 86.95, lat: 43.895, desc: '核心观景点，俯瞰连绵丹霞地貌', color: '#ff9800' },
  { name: '康家石门子岩画', lng: 86.85, lat: 43.902, desc: '古代游牧民族岩画', color: '#ff9800' },
  { name: '赤壁天湖', lng: 86.75, lat: 43.888, desc: '碧水映红崖，夏季避暑露营好去处', color: '#ff9800' },
  { name: '锦绣丹霞台', lng: 86.90, lat: 43.898, desc: '视野开阔，适合拍摄日出和星空', color: '#ff9800' },
  { name: '骆驼峰', lng: 86.80, lat: 43.893, desc: '象形石峰，徒步爱好者打卡点', color: '#ff9800' },
  { name: '杏花谷口', lng: 87.05, lat: 43.890, desc: '春季杏花漫山', color: '#ff9800' },
  { name: '百里丹霞风景道入口', lng: 87.10, lat: 43.92, desc: '风景道入口', color: '#ff9800' }
];

const s101Waypoints = [
  [87.26, 43.40],
  [87.185, 43.885],
  [87.10, 43.92],
  [86.95, 43.895],
  [86.85, 43.902],
  [86.80, 43.893],
  [86.75, 43.888],
  [86.68, 43.89],
  [86.637, 43.910],
  [85.97, 43.94]
];

function convertCoordinates(lng, lat) {
  const x = Number(lng);
  const y = Number(lat);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  // 当前数据直接输出 GCJ-02，经统一入口可扩展为其他坐标系转换。
  return [x, y];
}

function parseAndFlattenPolyline(steps = []) {
  const result = [];
  let last = null;
  for (const step of steps) {
    if (!step?.polyline) continue;
    const parts = String(step.polyline).split(';');
    for (const part of parts) {
      const [lng, lat] = part.split(',');
      const point = convertCoordinates(lng, lat);
      if (!point) continue;
      if (!last || last[0] !== point[0] || last[1] !== point[1]) {
        result.push(point);
        last = point;
      }
    }
  }
  return result;
}

function normalizePointList(points = []) {
  return points.map(([lng, lat]) => convertCoordinates(lng, lat)).filter(Boolean);
}

app.get('/api/map-data', (_req, res) => {
  res.json({
    closurePoints,
    westRoute: normalizePointList(westRoute),
    g312Route: normalizePointList(g312Route),
    scenicPoints,
    s101Waypoints: normalizePointList(s101Waypoints)
  });
  console.log('====== END ======');
});

app.get('/api/route', async (req, res) => {
  const { origin, destination, waypoints = '' } = req.query;

  if (!origin || !destination) {
    console.log('====== END ======');
    return res.status(400).json({ success: false, message: 'origin 和 destination 必填' });
  }
  if (!AMAP_WEB_KEY) {
    console.log('====== END ======');
    return res.status(500).json({ success: false, message: '缺少 AMAP_WEB_KEY' });
  }

  const cacheKey = `${origin}|${destination}|${waypoints}`;
  if (routeCache.has(cacheKey)) {
    const cached = routeCache.get(cacheKey);
    console.log('路线点数量:', cached.polyline.length);
    console.log('====== END ======');
    return res.json(cached);
  }

  try {
    const response = await axios.get(AMAP_DRIVING_API, {
      params: {
        key: AMAP_WEB_KEY,
        origin,
        destination,
        waypoints,
        extensions: 'all',
        output: 'json'
      },
      timeout: 15000
    });

    const data = response.data;
    if (!data || data.status !== '1' || !Array.isArray(data.route?.paths) || !data.route.paths.length) {
      console.log('====== END ======');
      return res.status(502).json({ success: false, message: data?.info || '高德路径规划失败' });
    }

    const polyline = parseAndFlattenPolyline(data.route.paths[0].steps || []);
    if (!polyline.length) {
      console.log('====== END ======');
      return res.status(502).json({ success: false, message: '路线解析为空' });
    }

    const payload = { success: true, polyline };
    routeCache.set(cacheKey, payload);

    console.log('路线点数量:', polyline.length);
    console.log('====== END ======');
    return res.json(payload);
  } catch (error) {
    console.error('接口错误:', error.message);
    console.log('====== END ======');
    return res.status(500).json({ success: false, message: '路径规划请求异常' });
  }
});

app.get('/api/geocode', async (req, res) => {
  const { address } = req.query;
  if (!address) {
    console.log('====== END ======');
    return res.status(400).json({ success: false, message: 'address 必填' });
  }
  if (!AMAP_WEB_KEY) {
    console.log('====== END ======');
    return res.status(500).json({ success: false, message: '缺少 AMAP_WEB_KEY' });
  }

  try {
    const response = await axios.get(AMAP_GEOCODE_API, {
      params: {
        key: AMAP_WEB_KEY,
        address,
        output: 'json'
      },
      timeout: 15000
    });

    const data = response.data;
    if (!data || data.status !== '1' || !Array.isArray(data.geocodes) || !data.geocodes.length) {
      console.log('====== END ======');
      return res.status(502).json({ success: false, message: data?.info || '地理编码失败' });
    }

    const first = data.geocodes[0];
    const [lng, lat] = String(first.location || '').split(',');
    const location = convertCoordinates(lng, lat);
    if (!location) {
      console.log('====== END ======');
      return res.status(502).json({ success: false, message: '地理编码坐标无效' });
    }

    console.log('====== END ======');
    return res.json({
      success: true,
      address,
      location,
      formattedAddress: first.formatted_address || first.formattedAddress || ''
    });
  } catch (error) {
    console.error('接口错误:', error.message);
    console.log('====== END ======');
    return res.status(500).json({ success: false, message: '地理编码请求异常' });
  }
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server started at http://localhost:${PORT}`);
});
