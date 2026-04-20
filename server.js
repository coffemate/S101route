const path = require('path');
const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const AMAP_WEB_KEY = process.env.AMAP_WEB_KEY;
const AMAP_DRIVING_API = 'https://restapi.amap.com/v3/direction/driving';

if (!AMAP_WEB_KEY) {
  console.warn('[WARN] AMAP_WEB_KEY 未配置，请在 .env 中设置后再启动。');
}

app.use(express.static(__dirname));

const routeCache = new Map();

function parseAndFlattenPolyline(steps = []) {
  const points = [];
  for (const step of steps) {
    if (!step || !step.polyline) continue;
    const segments = String(step.polyline).split(';');
    for (const segment of segments) {
      const [lng, lat] = segment.split(',').map(Number);
      if (Number.isFinite(lng) && Number.isFinite(lat)) {
        points.push([lng, lat]);
      }
    }
  }
  return points;
}

app.get('/api/route', async (req, res) => {
  const { origin, destination, waypoints = '' } = req.query;

  if (!origin || !destination) {
    return res.status(400).json({
      success: false,
      message: '参数缺失：origin 和 destination 为必填，格式示例：lng,lat'
    });
  }

  if (!AMAP_WEB_KEY) {
    return res.status(500).json({
      success: false,
      message: '服务端未配置 AMAP_WEB_KEY'
    });
  }

  const cacheKey = `${origin}|${destination}|${waypoints}`;
  if (routeCache.has(cacheKey)) {
    const cached = routeCache.get(cacheKey);
    console.log(`[cache-hit] ${cacheKey} -> ${cached.polyline.length} points`);
    return res.json(cached);
  }

  try {
    console.log(`[route-request] origin=${origin} destination=${destination} waypoints=${waypoints || '(none)'}`);

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
    if (!(data && data.status === '1' && data.route && Array.isArray(data.route.paths) && data.route.paths.length > 0)) {
      console.error('[amap-error]', data);
      return res.status(502).json({
        success: false,
        message: data?.info || '高德路径规划返回失败'
      });
    }

    const steps = data.route.paths[0].steps || [];
    const polyline = parseAndFlattenPolyline(steps);
    if (!polyline.length) {
      return res.status(502).json({
        success: false,
        message: '高德返回成功，但未解析出有效路线点'
      });
    }

    const payload = { success: true, polyline };
    routeCache.set(cacheKey, payload);
    console.log(`[route-success] ${cacheKey} -> ${polyline.length} points`);
    return res.json(payload);
  } catch (error) {
    console.error('[route-fail]', error.message);
    return res.status(500).json({
      success: false,
      message: '路径规划请求失败，请稍后重试'
    });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server started: http://localhost:${PORT}`);
});
