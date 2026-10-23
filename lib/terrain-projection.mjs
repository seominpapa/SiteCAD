import proj4 from 'proj4';
import { createHash } from 'node:crypto';
import { anchorFor } from './parcel-projection.mjs';
import { parseGeoReference, PROJ_DEFINITION } from '../public/geo-reference.js';

const projection = proj4('EPSG:4326', PROJ_DEFINITION);
const fail = () => { throw new Error('지형 도형·표고 또는 원본 좌표계 정보가 유효하지 않습니다.'); };
const coordinate = point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite) && point[0] >= 124 && point[0] <= 132 && point[1] >= 32 && point[1] <= 39.5;
const localCoordinate = value => Number.isFinite(value) && Math.abs(value) <= 100_000_000;
const same = (a, b) => a[0] === b[0] && a[1] === b[1];

function checkedProvenance(source) {
  if (typeof source?.originalCRS !== 'string' || source.originalCRS.length > 4096 || !/^(?:EPSG:\d{4,6}$|(?:PROJCS|GEOGCS|PROJCRS|GEOGCRS|GEODCRS)\s*\[)/.test(source.originalCRS) ||
      source.verticalDatum !== 'unknown' || typeof source.sourceSha256 !== 'string' || !/^[a-f\d]{64}$/.test(source.sourceSha256)) fail();
}

function checkedExtent(source) {
  const [west, south, east, north] = source.bbox;
  const width = (east - west) * 111_320 * Math.cos((south + north) / 2 * Math.PI / 180);
  const height = (north - south) * 111_320;
  if (width > 2000 || height > 2000 || width * height > 1_000_000) fail();
}

export function projectTerrain(source, { units, georeference = null, x_mm, y_mm } = {}) {
  checkedProvenance(source);
  const anchor = anchorFor(source, { units, georeference, x_mm, y_mm });
  checkedExtent(source);
  const { version, sourceCRS, targetCRS, originLonLat, originProjectedM, insertionMm, mmPerUnit, metresToDrawingUnits, axis, modelScale, projDefinition, projectionLibrary } = anchor;
  let vertexCount = 0, contourCount = 0, spotCount = 0;
  const project = point => {
    if (!coordinate(point) || point[0] < source.bbox[0] - 1e-12 || point[0] > source.bbox[2] + 1e-12 || point[1] < source.bbox[1] - 1e-12 || point[1] > source.bbox[3] + 1e-12) fail();
    const result = projection.forward(point).map((value, i) => (value - originProjectedM[i]) * 1000 + insertionMm[i]);
    if (!result.every(localCoordinate)) fail();
    return result;
  };
  const heights = source.features.map(feature => feature?.properties?.elevation_m);
  if (heights.some(value => !Number.isFinite(value) || value < -500 || value > 9000)) fail();
  const entities = source.features.flatMap((feature, featureIndex) => {
    if (feature?.type !== 'Feature' || !feature.geometry) fail();
    const { type, coordinates } = feature.geometry;
    const elevationM = heights[featureIndex];
    if (type === 'Point') {
      if (++vertexCount > 20_000 || ++spotCount + contourCount > 500) fail();
      return [{ kind: 'spot', positionMm: project(coordinates), elevationM }];
    }
    if (!['LineString', 'MultiLineString'].includes(type)) fail();
    const parts = type === 'LineString' ? [coordinates] : coordinates;
    if (!Array.isArray(parts) || !parts.length || parts.length > 500) fail();
    return parts.map(points => {
      if (!Array.isArray(points) || points.length < 2 || (vertexCount += points.length) > 20_000 || ++contourCount + spotCount > 500 || !points.every(coordinate)) fail();
      const closed = same(points[0], points.at(-1));
      const vertices = closed ? points.slice(0, -1) : points;
      if (new Set(vertices.map(point => point.join(','))).size < (closed ? 3 : 2) || points.some((point, i) => i > 0 && same(point, points[i - 1]))) fail();
      return { kind: 'contour', verticesMm: vertices.map(project), elevationM, closed };
    });
  });
  const minElevationM = Math.min(...heights), maxElevationM = Math.max(...heights);
  const metadata = parseGeoReference({ version, sourceCRS, targetCRS, originLonLat, originProjectedM, insertionMm, units, mmPerUnit, metresToDrawingUnits, axis, modelScale, projDefinition, projectionLibrary,
    kind: 'terrain', sourceId: source.id, url: source.sourceUrl, retrievedAt: source.retrievedAt,
    geometrySha256: createHash('sha256').update(JSON.stringify(source.features.map(feature => ({ geometry: feature.geometry, elevation_m: feature.properties.elevation_m })))).digest('hex'),
    featureCount: source.features.length, ringCount: 0, netAreaM2: null, possiblyTruncated: source.possiblyTruncated,
    terrain: { sourceCRS: source.originalCRS, sourceKind: source.sourceKind ?? 'local-file', verticalDatum: source.verticalDatum, sourceSha256: source.sourceSha256, contourCount, spotCount, minElevationM, maxElevationM,
      ...(source.sourceKind === 'public-download' ? { sourceLabel: source.sourceLabel, downloadedAt: source.downloadedAt } : {}) } });
  const summary = { featureCount: metadata.featureCount, contourCount, spotCount, minElevationM, maxElevationM, sourceCRS, originalCRS: source.originalCRS, targetCRS,
    units, mmPerUnit, metresToDrawingUnits, modelScale, possiblyTruncated: metadata.possiblyTruncated, verticalDatum: source.verticalDatum };
  return { entities, metadata, summary };
}
