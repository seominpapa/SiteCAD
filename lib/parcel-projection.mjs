import proj4 from 'proj4';
import { createHash } from 'node:crypto';
import { mmPerUnit } from '../public/units.js';
import { parseGeoReference, PROJ_DEFINITION, ANCHOR_FIELDS } from '../public/geo-reference.js';

const projection = proj4('EPSG:4326', PROJ_DEFINITION);
const error = () => { throw new Error('필지 도형이나 공간 기준 정보가 유효하지 않습니다.'); };
const coordinate = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite) && value[0] >= 124 && value[0] <= 132 && value[1] >= 32 && value[1] <= 39.5;
const localCoordinate = value => Number.isFinite(value) && Math.abs(value) <= 100_000_000;

function area(points) {
  const origin = points[0];
  let twiceArea = 0, extent = 0;
  for (let i = 0; i < points.length; i++) {
    const a = [points[i][0] - origin[0], points[i][1] - origin[1]];
    const b = [points[(i + 1) % points.length][0] - origin[0], points[(i + 1) % points.length][1] - origin[1]];
    twiceArea += a[0] * b[1] - b[0] * a[1];
    extent = Math.max(extent, Math.abs(a[0]), Math.abs(a[1]));
  }
  if (!Number.isFinite(twiceArea) || Math.abs(twiceArea) <= extent * extent * 1e-12) error();
  return Math.abs(twiceArea) / 2;
}

function checkedSource(source) {
  if (!source || source.type !== 'FeatureCollection' || source.crs !== 'EPSG:4326' || !Array.isArray(source.features) || source.features.length < 1 || source.features.length > 100 ||
      (source.count !== undefined && source.count !== source.features.length) || !Array.isArray(source.bbox) || source.bbox.length !== 4 || !coordinate(source.bbox.slice(0, 2)) || !coordinate(source.bbox.slice(2)) || source.bbox[0] >= source.bbox[2] || source.bbox[1] >= source.bbox[3] || typeof source.possiblyTruncated !== 'boolean') error();
  return [(source.bbox[0] + source.bbox[2]) / 2, (source.bbox[1] + source.bbox[3]) / 2];
}

export function anchorFor(source, { units, georeference, x_mm, y_mm }) {
  const center = checkedSource(source);
  if (!Number.isInteger(units)) error();
  const scale = mmPerUnit(units);
  const previous = parseGeoReference(georeference);
  if (georeference != null && !previous) error();
  if (previous) {
    if (previous.units !== units || (x_mm !== undefined && x_mm !== previous.insertionMm[0]) || (y_mm !== undefined && y_mm !== previous.insertionMm[1])) throw new Error('기존 공간 기준의 도면 단위와 삽입 위치를 유지해 주세요.');
    const origin = projection.forward(previous.originLonLat);
    if (origin.some((value, index) => Math.abs(value - previous.originProjectedM[index]) > 0.001)) throw new Error('저장된 공간 기준 원점이 좌표계와 일치하지 않습니다.');
    return Object.fromEntries(ANCHOR_FIELDS.map(key => [key, previous[key]]));
  }
  const insertionMm = [x_mm ?? 0, y_mm ?? 0];
  if (!insertionMm.every(localCoordinate)) error();
  return { version: 1, sourceCRS: 'EPSG:4326', targetCRS: 'EPSG:5179', originLonLat: center, originProjectedM: projection.forward(center), insertionMm, units, mmPerUnit: scale,
    metresToDrawingUnits: 1000 / scale, axis: 'E,N', modelScale: 1, projDefinition: PROJ_DEFINITION, projectionLibrary: 'proj4@2.21.0' };
}

export function projectParcels(source, { units, georeference = null, x_mm, y_mm } = {}) {
  const anchor = anchorFor(source, { units, georeference, x_mm, y_mm });
  let vertexCount = 0, ringCount = 0, netAreaM2 = 0;
  const rings = source.features.flatMap(feature => {
    if (feature?.type !== 'Feature' || !feature.geometry || !['Polygon', 'MultiPolygon'].includes(feature.geometry.type)) error();
    const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    if (!Array.isArray(polygons) || !polygons.length || polygons.length > 200) error();
    const pnu = typeof feature.properties?.pnu === 'string' && /^\d{19}$/.test(feature.properties.pnu) ? feature.properties.pnu : undefined;
    return polygons.flatMap(polygon => {
      if (!Array.isArray(polygon) || !polygon.length || polygon.length > 200) error();
      let polygonArea = 0;
      const projectedRings = polygon.map((ring, index) => {
        if (!Array.isArray(ring) || ring.length < 4 || vertexCount + ring.length > 20_000 || ++ringCount > 200 || !ring.every(coordinate)) error();
        vertexCount += ring.length;
        const first = ring[0], last = ring.at(-1);
        if (first[0] !== last[0] || first[1] !== last[1] || new Set(ring.map(point => point.join(','))).size < 3 || ring.some((point, i) => i > 0 && point[0] === ring[i - 1][0] && point[1] === ring[i - 1][1])) error();
        const vertices = ring.slice(0, -1);
        area(vertices);
        const projected = vertices.map(point => projection.forward(point));
        const measuredArea = area(projected);
        polygonArea += index === 0 ? measuredArea : -measuredArea;
        const verticesMm = projected.map(point => point.map((value, axis) => (value - anchor.originProjectedM[axis]) * 1000 + anchor.insertionMm[axis]));
        if (verticesMm.some(point => !point.every(localCoordinate))) error();
        return { verticesMm, role: index === 0 ? 'outer' : 'hole', ...(pnu ? { pnu } : {}) };
      });
      if (!(polygonArea > 0)) error();
      netAreaM2 += polygonArea;
      return projectedRings;
    });
  });
  const metadata = parseGeoReference({ ...anchor, sourceId: source.id ?? source.sourceId, url: source.sourceUrl ?? source.url, retrievedAt: source.retrievedAt,
    geometrySha256: createHash('sha256').update(JSON.stringify(source.features.map(feature => feature.geometry))).digest('hex'), featureCount: source.features.length, ringCount, netAreaM2, possiblyTruncated: source.possiblyTruncated });
  const holeRingCount = rings.filter(ring => ring.role === 'hole').length;
  const summary = { featureCount: metadata.featureCount, ringCount, outerRingCount: ringCount - holeRingCount, holeRingCount, netAreaM2, sourceCRS: metadata.sourceCRS, targetCRS: metadata.targetCRS,
    units, mmPerUnit: metadata.mmPerUnit, metresToDrawingUnits: metadata.metresToDrawingUnits, modelScale: 1, possiblyTruncated: metadata.possiblyTruncated };
  return { rings, metadata, summary };
}
