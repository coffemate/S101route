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
const geocodeCache = new Map();

const ROUTE_PLANS = {
  s101: {
    origin: '乌鲁木齐西山农牧场',
    destination: '玛纳斯县',
    waypoints: ['硫磺沟镇', '呼图壁县', '雀尔沟镇']
  },
  west: {
    origin: '昌吉市',
    destination: '雀尔沟镇',
    waypoints: ['三工镇', 'S335', 'X146县道']
  },
  g312: {
    origin: '昌吉市',
    destination: '雀尔沟镇',
    waypoints: ['G312', '大丰镇', 'X146县道']
  }
};

const SCENIC_SPOTS = [
  { name: '百里丹霞观景台', desc: '百里丹霞风景带核心观景点' },
  { name: '康家石门子岩画', desc: 'S101沿线人文历史景点' },
  { name: '赤壁天湖', desc: '丹霞地貌湖泊景观点' },
  { name: '锦绣丹霞', desc: '沿道路分布的丹霞观景点' }
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

function isLngLatText(v) {
  return typeof v === 'string' && /^\s*-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?\s*$/.test(v);
}

async function geocodeAddress(address) {
  if (geocodeCache.has(address)) return geocodeCache.get(address);
  const response = await axios.get(AMAP_GEOCODE_API, {
    params: { key: AMAP_WEB_KEY, address, output: 'json' },
    timeout: 15000
  });
  const data = response.data;
  if (!data || data.status !== '1' || !Array.isArray(data.geocodes) || !data.geocodes.length) {
    throw new Error(`地理编码失败: ${address}`);
  }
  const [lng, lat] = String(data.geocodes[0].location || '').split(',');
  const point = convertCoordinates(lng, lat);
  if (!point) throw new Error(`地理编码结果无效: ${address}`);
  geocodeCache.set(address, point);
  return point;
}

async function resolveLocation(input) {
  if (isLngLatText(input)) {
    const [lng, lat] = input.split(',');
    const point = convertCoordinates(lng, lat);
    if (!point) throw new Error(`坐标无效: ${input}`);
    return point;
  }
  return geocodeAddress(String(input).trim());
}

app.get('/api/map-data', (_req, res) => {
  Promise.all(SCENIC_SPOTS.map(async (spot) => {
    const [lng, lat] = await geocodeAddress(spot.name);
    return { ...spot, lng, lat, color: '#ff9800' };
  }))
    .then((scenicPoints) => {
      res.json({
        routePlans: ROUTE_PLANS,
        scenicPoints,
        closureRangeKm: { start: 21, end: 64 }
      });
      console.log('====== END ======');
    })
    .catch((error) => {
      console.error('接口错误:', error.message);
      console.log('====== END ======');
      res.status(500).json({ success: false, message: '地图基础数据生成失败' });
    });
});

app.get('/api/route', async (req, res) => {
  const { origin, destination, waypoints = '' } = req.query;
  console.log('路径请求:', origin, destination);

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
    const resolvedOrigin = await resolveLocation(origin);
    const resolvedDestination = await resolveLocation(destination);
    const waypointNames = String(waypoints).trim()
      ? String(waypoints).split('|').map((x) => x.trim()).filter(Boolean)
      : [];
    const resolvedWaypoints = [];
    for (const wp of waypointNames) {
      resolvedWaypoints.push(await resolveLocation(wp));
    }

    const response = await axios.get(AMAP_DRIVING_API, {
      params: {
        key: AMAP_WEB_KEY,
        origin: `${resolvedOrigin[0]},${resolvedOrigin[1]}`,
        destination: `${resolvedDestination[0]},${resolvedDestination[1]}`,
        waypoints: resolvedWaypoints.map(([lng, lat]) => `${lng},${lat}`).join('|'),
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
    const location = await geocodeAddress(address);

    console.log('====== END ======');
    return res.json({
      success: true,
      address,
      location
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
