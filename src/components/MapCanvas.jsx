import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { createProjectLocationIndex } from "../utils/uniqueProjects";

const BASE_MAPS = {
  claro: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  satelite: {
    version: 8,
    sources: {
      satellite: {
        type: "raster",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256,
        attribution: "Tiles © Esri",
      },
    },
    layers: [{ id: "satellite-imagery", type: "raster", source: "satellite" }],
  },
  osm: "https://tiles.openfreemap.org/styles/bright",
};
const BASE_URL = import.meta.env.BASE_URL;
const DATA_URLS = {
  provincias: `${BASE_URL}data/provincias.geojson`,
  distritos: `${BASE_URL}data/distritos.geojson`,
};
console.info("BASE_URL:", import.meta.env.BASE_URL);
console.info("URL provincias:", DATA_URLS.provincias);
console.info("URL distritos:", DATA_URLS.distritos);
console.info("DATA_URLS producción:", DATA_URLS);
const SOURCE_IDS = { provinces: "provinces-source", districts: "districts-source", projects: "projects-source" };
const LAYER_IDS = {
  provincesFill: "provinces-fill", provincesLine: "provinces-line",
  provincesHalo: "provinces-halo", districtsFill: "districts-fill",
  districtsHalo: "districts-halo", districtsLine: "districts-line",
  clusters: "project-clusters", clusterCount: "project-cluster-count",
  points: "project-points", selected: "selected-project-ring", selectedLocation: "selected-location-ring",
};
const SOURCE = SOURCE_IDS;
const LAYER = LAYER_IDS;

async function fetchGeoJSON(url, signal) {
  if (!url || typeof url !== "string") throw new Error(`URL GeoJSON inválida: ${String(url)}`);
  console.info("Cargando GeoJSON:", url);
  const response = await fetch(url, { signal });
  console.info("Respuesta GeoJSON:", url, response.status, response.ok);
  if (!response.ok) throw new Error(`No se pudo cargar GeoJSON: ${url} (${response.status} ${response.statusText})`);
  const data = await response.json();
  if (data?.type !== "FeatureCollection") throw new Error(`${url} no contiene un FeatureCollection válido`);
  return data;
}

function canUseStyle(map) { return Boolean(map?.isStyleLoaded()); }

function styleSupportsGlyphs(map) {
  const style = map?.getStyle?.();
  return Boolean(style?.glyphs);
}

export function normalizeTerritory(value) {
  const result = String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/\s+/g, " ");
  return ["", "todos", "todas"].includes(result) ? "" : result;
}

export const normalizeText = normalizeTerritory;

export function detectField(properties = {}, candidates = []) {
  const keys = Object.keys(properties);
  return keys.find((key) => candidates.includes(normalizeTerritory(key)))
    || keys.find((key) => candidates.some((candidate) => normalizeTerritory(key).includes(candidate)))
    || null;
}

export function getProvinceName(feature) {
  const properties = feature?.properties || {};
  const field = detectField(properties, ["provincia", "nombprov", "nom_prov", "nombre", "prov"]);
  return field ? properties[field] : "";
}

export function getDistrictName(feature) {
  const properties = feature?.properties || {};
  const field = detectField(properties, ["distrito", "nombdist", "nom_dist", "nombre", "dist"]);
  return field ? properties[field] : "";
}

export function getDistrictProvinceName(feature) { return getProvinceName(feature); }

function enrichProvinces(data) {
  data.features.forEach((feature) => {
    feature.properties ||= {};
    feature.properties.__province_norm = normalizeTerritory(getProvinceName(feature));
  });
  console.info("Provincia normalizada de ejemplo:", data.features[0]?.properties?.__province_norm);
  return data;
}

function enrichDistricts(data) {
  data.features.forEach((feature) => {
    feature.properties ||= {};
    feature.properties.__province_norm = normalizeTerritory(getDistrictProvinceName(feature));
    feature.properties.__district_norm = normalizeTerritory(getDistrictName(feature));
  });
  console.info("Distrito normalizado de ejemplo:", data.features[0]?.properties?.__district_norm);
  return data;
}

function featureCollectionFromProjects(projects = []) {
  return {
    type: "FeatureCollection",
    features: projects.map((project) => project?.feature).filter((feature) => feature?.type === "Feature" && feature?.geometry?.type === "Point"),
  };
}

export function getGeoJSONBounds(input) {
  const features = input?.type === "FeatureCollection" ? input.features : input ? [input] : [];
  const coordinates = [];
  const collect = (value) => typeof value?.[0] === "number" ? coordinates.push(value) : value?.forEach(collect);
  features.forEach((feature) => collect(feature?.geometry?.coordinates));
  if (!coordinates.length) return null;
  return coordinates.reduce((bounds, coordinate) => bounds.extend(coordinate), new maplibregl.LngLatBounds(coordinates[0], coordinates[0]));
}

export function getFeatureBounds(feature) {
  const bounds = new maplibregl.LngLatBounds();
  const extendCoordinates = (coordinates) => {
    if (!Array.isArray(coordinates)) return;
    if (coordinates.length >= 2 && typeof coordinates[0] === "number" && typeof coordinates[1] === "number") {
      bounds.extend([coordinates[0], coordinates[1]]);
      return;
    }
    coordinates.forEach(extendCoordinates);
  };
  const extendGeometry = (geometry) => {
    if (!geometry) return;
    if (geometry.type === "GeometryCollection") geometry.geometries?.forEach(extendGeometry);
    else extendCoordinates(geometry.coordinates);
  };
  extendGeometry(feature?.geometry);
  return bounds.isEmpty() ? null : bounds;
}

function softenBaseStyle(map) {
  map.getStyle().layers?.forEach((layer) => {
    try {
      if (layer.type === "raster") {
        map.setPaintProperty(layer.id, "raster-opacity", 0.76);
        map.setPaintProperty(layer.id, "raster-saturation", -0.18);
        map.setPaintProperty(layer.id, "raster-contrast", -0.08);
      }
      if (layer.type === "symbol" && layer.layout?.["text-field"]) map.setPaintProperty(layer.id, "text-opacity", 0.76);
    } catch { /* El estilo puede bloquear algunas propiedades. */ }
  });
}

function runMapOperation(label, operation, optional = false) {
  console.info(`Añadiendo ${label}`);
  try {
    operation();
    console.info(`${label} OK`);
    return true;
  } catch (error) {
    const logger = optional ? console.warn : console.error;
    logger(`Falló ${label}:`, error);
    if (!optional) throw new Error(`Falló ${label}: ${error?.message || error}`, { cause: error });
    return false;
  }
}

function addTerritorialLayers(map, provinces, districts) {
  if (!map.getSource(SOURCE.provinces)) runMapOperation(SOURCE.provinces, () => map.addSource(SOURCE.provinces, { type: "geojson", data: provinces, generateId: true }));
  if (!map.getLayer(LAYER.provincesFill)) runMapOperation(LAYER.provincesFill, () => map.addLayer({ id: LAYER.provincesFill, type: "fill", source: SOURCE.provinces, paint: { "fill-color": "#0f5132", "fill-opacity": 0.05, "fill-antialias": true } }));
  if (!map.getLayer(LAYER.provincesHalo)) runMapOperation(LAYER.provincesHalo, () => map.addLayer({ id: LAYER.provincesHalo, type: "line", source: SOURCE.provinces, paint: { "line-color": "#ffffff", "line-width": 3.2, "line-opacity": 0.72, "line-blur": 0.35 } }));
  if (!map.getLayer(LAYER.provincesLine)) runMapOperation(LAYER.provincesLine, () => map.addLayer({ id: LAYER.provincesLine, type: "line", source: SOURCE.provinces, paint: { "line-color": "#16856f", "line-width": 1.25, "line-opacity": 0.92 } }));
  if (!map.getSource(SOURCE.districts)) runMapOperation(SOURCE.districts, () => map.addSource(SOURCE.districts, { type: "geojson", data: districts, generateId: true }));
  if (!map.getLayer(LAYER.districtsFill)) runMapOperation(LAYER.districtsFill, () => map.addLayer({ id: LAYER.districtsFill, type: "fill", source: SOURCE.districts, paint: { "fill-color": "#d99a2b", "fill-opacity": 0 } }));
  if (!map.getLayer(LAYER.districtsHalo)) runMapOperation(LAYER.districtsHalo, () => map.addLayer({ id: LAYER.districtsHalo, type: "line", source: SOURCE.districts, paint: { "line-color": "#ffffff", "line-width": 1.4, "line-opacity": 0.58, "line-blur": 0.25 } }));
  if (!map.getLayer(LAYER.districtsLine)) runMapOperation(LAYER.districtsLine, () => map.addLayer({ id: LAYER.districtsLine, type: "line", source: SOURCE.districts, paint: { "line-color": "#2a9d8f", "line-width": 0.45, "line-opacity": 0.55 } }));
}

function addProjectLayers(map, data) {
  if (!map.getSource(SOURCE.projects)) runMapOperation(SOURCE.projects, () => map.addSource(SOURCE.projects, { type: "geojson", data, cluster: true, clusterMaxZoom: 13, clusterRadius: 55, generateId: true }));
  if (!map.getLayer(LAYER.clusters)) runMapOperation(LAYER.clusters, () => map.addLayer({ id: LAYER.clusters, type: "circle", source: SOURCE.projects, filter: ["has", "point_count"], paint: {
    "circle-color": "#0f5132", "circle-radius": ["step", ["get", "point_count"], 15, 10, 18, 25, 21, 50, 24],
    "circle-stroke-width": 3, "circle-stroke-color": "#ffffff",
  } }));
  if (styleSupportsGlyphs(map)) {
    if (!map.getLayer(LAYER.clusterCount)) {
      runMapOperation(LAYER.clusterCount, () => map.addLayer({ id: LAYER.clusterCount, type: "symbol", source: SOURCE.projects, filter: ["has", "point_count"], layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 12 }, paint: { "text-color": "#ffffff" } }), true);
    }
  } else {
    console.warn("El mapa base no define glyphs; se muestran clústeres sin etiqueta.");
  }
  if (!map.getLayer(LAYER.points)) runMapOperation(LAYER.points, () => map.addLayer({ id: LAYER.points, type: "circle", source: SOURCE.projects, filter: ["!", ["has", "point_count"]], paint: {
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, 4, 10, 5, 13, 7, 16, 9], "circle-color": ["match", ["get", "estado"], "Planificado", "#d99a2b", "Finalizado", "#8aa7b3", "#169B62"], "circle-stroke-width": 2, "circle-stroke-color": "#ffffff", "circle-opacity": 0.9,
  } }));
  if (!map.getLayer(LAYER.selected)) runMapOperation(LAYER.selected, () => map.addLayer({ id: LAYER.selected, type: "circle", source: SOURCE.projects, filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "__project_key"], ""]], paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, 7, 10, 8, 13, 10, 16, 12], "circle-color": "rgba(255,255,255,0)", "circle-stroke-width": 1.5, "circle-stroke-opacity":0.65, "circle-stroke-color": "#0f5132" } }));
  if (!map.getLayer(LAYER.selectedLocation)) runMapOperation(LAYER.selectedLocation, () => map.addLayer({ id:LAYER.selectedLocation, type:"circle", source:SOURCE.projects, filter:["all", ["!", ["has", "point_count"]], ["==", ["get", "__location_key"], ""]], paint:{ "circle-radius":["interpolate", ["linear"], ["zoom"], 7, 9, 10, 10, 13, 12, 16, 14], "circle-color":"rgba(255,255,255,0)", "circle-stroke-width":3, "circle-stroke-color":"#0b4d31" } }));
}

export function fitMapToGeometry(map, geometry, options = {}) {
  const bounds = getGeoJSONBounds({ type: "Feature", geometry });
  if (!canUseStyle(map) || !bounds) return;
  map.fitBounds(bounds, { padding: 60, maxZoom: 12, duration: 850, ...options });
}

export function selectProject(map, feature, onSelect) {
  const projectKey = feature?.properties?.__project_key;
  if (projectKey) onSelect?.(projectKey, feature);
  if (feature?.geometry?.type === "Point") map.easeTo({ center:feature.geometry.coordinates, zoom:Math.max(map.getZoom(), 13), duration:700 });
}

function focusLogicalProject(map, locationsByProject, projectKey, options = {}) {
  const features = locationsByProject.get(projectKey) || []
  const bounds = getGeoJSONBounds({ type:"FeatureCollection", features })
  if (!bounds) return
  if (features.length === 1) map.easeTo({ center:features[0].geometry.coordinates, zoom:Math.max(map.getZoom(), 13), duration:700, ...options })
  else map.fitBounds(bounds, { padding:60, maxZoom:12, duration:850, ...options })
}

export function changeBaseMap(map, style = BASE_MAPS.claro) {
  if (!map || !style) return false;
  try { map.setStyle(style); return true; } catch (error) { console.error("No se pudo cambiar el mapa base:", error); return false; }
}

export default function MapCanvas({ projects, selectedId, selectedLocationKey, onSelect, selectedProvince = "", selectedDistrict = "", onSelectProvince, onSelectDistrict, filtersOpen, projectPanelOpen, baseMap = "claro", mapAction }) {
  const mapContainer = useRef(null);
  const mapRef = useRef(null);
  const mapReadyRef = useRef(false);
  const provincesDataRef = useRef(null);
  const districtsDataRef = useRef(null);
  const projectsDataRef = useRef(null);
  const selectedProvinceRef = useRef(selectedProvince);
  const selectedDistrictRef = useRef(selectedDistrict);
  const projectsRef = useRef(projects);
  const locationsByProjectRef = useRef(new globalThis.Map());
  const locationsByKeyRef = useRef(new globalThis.Map());
  const selectedIdRef = useRef(selectedId);
  const selectedLocationKeyRef = useRef(selectedLocationKey);
  const hoveredProjectRef = useRef(null);
  const onSelectRef = useRef(onSelect);
  const callbacksRef = useRef({ onSelectProvince, onSelectDistrict });
  const restorePromiseRef = useRef(null);
  const baseMapRef = useRef("claro");
  const [isMapLoading, setIsMapLoading] = useState(true);
  const [mapError, setMapError] = useState(null);

  const waitForStyleReady = (map, timeout = 10000) => new Promise((resolve, reject) => {
    if (!map) { reject(new Error("La instancia del mapa no existe")); return; }
    if (map.isStyleLoaded()) { resolve(); return; }
    const startedAt = Date.now();
    const check = () => {
      if (!mapRef.current || map !== mapRef.current) { reject(new Error("El mapa fue desmontado")); return; }
      if (map.isStyleLoaded()) { resolve(); return; }
      if (Date.now() - startedAt >= timeout) {
        reject(new Error("El estilo de MapLibre no terminó de cargar dentro del tiempo esperado"));
        return;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });

  const applyTerritorialSelection = (map) => {
    if (!map) return;
    const province = normalizeTerritory(selectedProvinceRef.current);
    const district = normalizeTerritory(selectedDistrictRef.current);
    const provinceMatch = ["==", ["get", "__province_norm"], province];
    const districtMatch = ["all", provinceMatch, ["==", ["get", "__district_norm"], district]];
    try {
      if (map.getLayer(LAYER.provincesFill)) {
        map.setPaintProperty(LAYER.provincesFill, "fill-color", province ? ["case", provinceMatch, "#1f9d68", "#0f5132"] : "#0f5132");
        map.setPaintProperty(LAYER.provincesFill, "fill-opacity", province ? ["case", provinceMatch, 0.24, 0.01] : 0.05);
      }
      if (map.getLayer(LAYER.provincesLine)) {
        map.setPaintProperty(LAYER.provincesLine, "line-color", province ? ["case", provinceMatch, "#00b884", "#5fa99a"] : "#16856f");
        map.setPaintProperty(LAYER.provincesLine, "line-opacity", province ? ["case", provinceMatch, 1, 0.22] : 0.92);
        map.setPaintProperty(LAYER.provincesLine, "line-width", province ? ["case", provinceMatch, 3, 0.7] : 1.25);
      }
      if (map.getLayer(LAYER.provincesHalo)) {
        map.setPaintProperty(LAYER.provincesHalo, "line-width", province ? ["case", provinceMatch, 5, 2.2] : 3.2);
        map.setPaintProperty(LAYER.provincesHalo, "line-opacity", province ? ["case", provinceMatch, 0.88, 0.42] : 0.72);
      }
      if (map.getLayer(LAYER.districtsFill)) {
        map.setPaintProperty(LAYER.districtsFill, "fill-color", province && district ? ["case", districtMatch, "#d99a2b", "#ffffff"] : "#ffffff");
        map.setPaintProperty(LAYER.districtsFill, "fill-opacity", province && district ? ["case", districtMatch, 0.42, 0] : 0);
      }
      if (map.getLayer(LAYER.districtsLine)) {
        if (province && district) {
          map.setPaintProperty(LAYER.districtsLine, "line-color", ["case", districtMatch, "#f4b942", "#2a9d8f"]);
          map.setPaintProperty(LAYER.districtsLine, "line-opacity", ["case", districtMatch, 1, ["case", provinceMatch, 0.35, 0.02]]);
          map.setPaintProperty(LAYER.districtsLine, "line-width", ["case", districtMatch, 4, ["case", provinceMatch, 0.8, 0.15]]);
        } else if (province) {
          map.setPaintProperty(LAYER.districtsLine, "line-color", "#2a9d8f");
          map.setPaintProperty(LAYER.districtsLine, "line-opacity", ["case", provinceMatch, 0.85, 0.03]);
          map.setPaintProperty(LAYER.districtsLine, "line-width", ["case", provinceMatch, 0.9, 0.2]);
        } else {
          map.setPaintProperty(LAYER.districtsLine, "line-color", "#2a9d8f");
          map.setPaintProperty(LAYER.districtsLine, "line-opacity", 0.55);
          map.setPaintProperty(LAYER.districtsLine, "line-width", 0.45);
        }
      }
      if (map.getLayer(LAYER.districtsHalo)) {
        map.setPaintProperty(LAYER.districtsHalo, "line-width", province && district ? ["case", districtMatch, 6, ["case", provinceMatch, 1.8, 0.8]] : province ? ["case", provinceMatch, 2.1, 0.7] : 1.4);
        map.setPaintProperty(LAYER.districtsHalo, "line-opacity", province && district ? ["case", districtMatch, 0.92, ["case", provinceMatch, 0.48, 0.12]] : province ? ["case", provinceMatch, 0.65, 0.1] : 0.58);
      }
      const districtFeature = district ? districtsDataRef.current?.features?.find((feature) => feature.properties?.__province_norm === province && feature.properties?.__district_norm === district) : null;
      console.info("Distrito seleccionado normalizado:", district);
      console.info("Primer distrito:", districtsDataRef.current?.features?.[0]?.properties);
      if (district === "pacaycasa") console.info("Feature Pacaycasa encontrado:", Boolean(districtFeature), districtFeature?.properties);
      console.info("Selección territorial aplicada:", { province, district, provinceLayersExist: Boolean(map.getLayer(LAYER.provincesFill)), districtLayersExist: Boolean(map.getLayer(LAYER.districtsFill)) });
    } catch (error) { console.error("No se pudo aplicar la selección territorial:", error); }
  };

  const focusSelectedTerritory = (map) => {
    if (!map || !provincesDataRef.current || !districtsDataRef.current) return;
    const province = normalizeTerritory(selectedProvinceRef.current);
    const district = normalizeTerritory(selectedDistrictRef.current);
    const districtFeature = district ? districtsDataRef.current.features.find((feature) => feature.properties.__province_norm === province && feature.properties.__district_norm === district) : null;
    const provinceFeature = province ? provincesDataRef.current.features.find((feature) => feature.properties.__province_norm === province) : null;
    const feature = districtFeature || provinceFeature || { type: "Feature", properties: {}, geometry: { type: "GeometryCollection", geometries: provincesDataRef.current.features.map((item) => item.geometry).filter(Boolean) } };
    console.info("Feature territorial encontrada:", { type: district ? "district" : province ? "province" : "general", found: Boolean(district ? districtFeature : province ? provinceFeature : provincesDataRef.current.features.length) });
    if ((district && !districtFeature) || (province && !provinceFeature)) {
      console.warn("No se encontró feature para enfocar", { provinceValue: province, districtValue: district });
      return;
    }
    const bounds = getFeatureBounds(feature);
    if (!bounds) { console.warn("No se pudieron calcular límites", feature); return; }
    const width = window.innerWidth;
    const padding = width >= 1200 ? { top: 120, right: 390, bottom: 80, left: 350 }
      : width >= 768 ? { top: 110, right: 60, bottom: 80, left: 280 }
        : { top: 100, right: 30, bottom: 230, left: 30 };
    map.fitBounds(bounds, { padding, maxZoom: districtFeature ? 12 : provinceFeature ? 9 : 7, duration: 900 });
  };

  const restoreCustomLayers = async (map) => {
    if (restorePromiseRef.current) return restorePromiseRef.current;
    const performRestore = async () => {
      await waitForStyleReady(map);
      softenBaseStyle(map);
      provincesDataRef.current ||= enrichProvinces(await fetchGeoJSON(DATA_URLS.provincias));
      console.info("Provincias:", provincesDataRef.current.features.length);
      districtsDataRef.current ||= enrichDistricts(await fetchGeoJSON(DATA_URLS.distritos));
      console.info("Distritos:", districtsDataRef.current.features.length);
      projectsDataRef.current = featureCollectionFromProjects(projectsRef.current);
      console.info("Proyectos visibles:", projectsDataRef.current.features.length);
      addTerritorialLayers(map, provincesDataRef.current, districtsDataRef.current);
      addProjectLayers(map, projectsDataRef.current);
      const projectSource = map.getSource(SOURCE.projects);
      if (projectSource) projectSource.setData(projectsDataRef.current);
      applyTerritorialSelection(map);
      if (map.getLayer(LAYER.selected)) map.setFilter(LAYER.selected, ["all", ["!", ["has", "point_count"]], ["==", ["get", "__project_key"], String(selectedIdRef.current ?? "")]]);
      if (map.getLayer(LAYER.selectedLocation)) map.setFilter(LAYER.selectedLocation, ["all", ["!", ["has", "point_count"]], ["==", ["get", "__location_key"], String(selectedLocationKeyRef.current ?? "")]]);
      [LAYER.provincesFill, LAYER.provincesHalo, LAYER.provincesLine, LAYER.districtsFill, LAYER.districtsHalo, LAYER.districtsLine, LAYER.clusters, LAYER.clusterCount, LAYER.points, LAYER.selected, LAYER.selectedLocation].forEach((id) => { if (map.getLayer(id)) map.moveLayer(id); });
      const restored = {
        provincesSource: Boolean(map.getSource(SOURCE.provinces)), districtsSource: Boolean(map.getSource(SOURCE.districts)), projectsSource: Boolean(map.getSource(SOURCE.projects)),
        provincesFill: Boolean(map.getLayer(LAYER.provincesFill)), provincesLine: Boolean(map.getLayer(LAYER.provincesLine)),
        districtsFill: Boolean(map.getLayer(LAYER.districtsFill)), districtsLine: Boolean(map.getLayer(LAYER.districtsLine)),
        projectClusters: Boolean(map.getLayer(LAYER.clusters)), projectPoints: Boolean(map.getLayer(LAYER.points)),
        selectedProject: Boolean(map.getLayer(LAYER.selected)), selectedLocation: Boolean(map.getLayer(LAYER.selectedLocation)),
      };
      console.info("Estado de capas restauradas", restored);
      console.info("project-cluster-count (opcional):", Boolean(map.getLayer(LAYER.clusterCount)));
      if (Object.values(restored).some((value) => !value)) throw new Error("La restauración terminó con fuentes o capas personalizadas ausentes");
      requestAnimationFrame(() => { if (mapRef.current === map) focusSelectedTerritory(map); });
    };
    restorePromiseRef.current = performRestore();
    try {
      return await restorePromiseRef.current;
    } finally {
      restorePromiseRef.current = null;
    }
  };

  const handleClusterClick = async (event) => {
    const map = mapRef.current;
    try {
      const feature = event.features?.[0];
      const source = map?.getSource(SOURCE.projects);
      if (!map || !feature || !source) return;
      const zoom = await source.getClusterExpansionZoom(feature.properties.cluster_id);
      map.easeTo({ center: feature.geometry.coordinates, zoom });
    } catch (error) { console.error("No se pudo expandir el clúster:", error); }
  };
  const handleProjectClick = (event) => { const map = mapRef.current; if (map && event.features?.[0]) selectProject(map, event.features[0], onSelectRef.current); };
  const clickContainsProject = (event) => {
    const map = mapRef.current;
    if (!map || !event?.point) return false;
    const layers = [LAYER.clusters, LAYER.points].filter((layer) => map.getLayer(layer));
    return layers.length > 0 && map.queryRenderedFeatures(event.point, { layers }).length > 0;
  };
  const handleProvinceClick = (event) => { if (!clickContainsProject(event) && event.features?.[0]) callbacksRef.current.onSelectProvince?.(getProvinceName(event.features[0])); };
  const handleDistrictClick = (event) => { if (!clickContainsProject(event) && event.features?.[0]) callbacksRef.current.onSelectDistrict?.(getDistrictProvinceName(event.features[0]), getDistrictName(event.features[0])); };
  const handlePointerEnter = () => { if (mapRef.current) mapRef.current.getCanvas().style.cursor = "pointer"; };
  const handlePointerLeave = () => {
    const map = mapRef.current;
    if (map && hoveredProjectRef.current !== null) map.setFeatureState({ source:SOURCE.projects, id:hoveredProjectRef.current }, { hover:false });
    hoveredProjectRef.current = null;
    if (map) map.getCanvas().style.cursor = "";
  };
  const handleProjectMove = event => {
    const map = mapRef.current, featureId = event.features?.[0]?.id;
    if (!map || featureId === undefined || featureId === null || hoveredProjectRef.current === featureId) return;
    if (hoveredProjectRef.current !== null) map.setFeatureState({ source:SOURCE.projects, id:hoveredProjectRef.current }, { hover:false });
    hoveredProjectRef.current = featureId;
    map.setFeatureState({ source:SOURCE.projects, id:featureId }, { hover:true });
  };

  const bindLayerInteractions = (map) => {
    [["click", LAYER.clusters, handleClusterClick], ["click", LAYER.points, handleProjectClick], ["click", LAYER.provincesFill, handleProvinceClick], ["click", LAYER.districtsFill, handleDistrictClick]].forEach(([event, layer, handler]) => {
      map.off(event, layer, handler); map.on(event, layer, handler);
    });
    map.off("mousemove", LAYER.points, handleProjectMove); map.on("mousemove", LAYER.points, handleProjectMove);
    [LAYER.clusters, LAYER.points, LAYER.provincesFill, LAYER.districtsFill].forEach((layer) => {
      map.off("mouseenter", layer, handlePointerEnter); map.off("mouseleave", layer, handlePointerLeave);
      map.on("mouseenter", layer, handlePointerEnter); map.on("mouseleave", layer, handlePointerLeave);
    });
  };

  useEffect(() => {
    projectsRef.current = projects;
    projectsDataRef.current = featureCollectionFromProjects(projects);
    locationsByProjectRef.current = createProjectLocationIndex(projectsDataRef.current.features);
    locationsByKeyRef.current = new globalThis.Map(projectsDataRef.current.features.map(feature => [feature.properties?.__location_key, feature]));
  }, [projects]);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);
  useEffect(() => { selectedLocationKeyRef.current = selectedLocationKey; }, [selectedLocationKey]);
  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);
  useEffect(() => { callbacksRef.current = { onSelectProvince, onSelectDistrict }; }, [onSelectProvince, onSelectDistrict]);

  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return undefined;
    let disposed = false;
    let resizeObserver;
    const map = new maplibregl.Map({ container: mapContainer.current, style: BASE_MAPS.claro, center: [-74.2, -13.15], zoom: 6.5, minZoom: 5, attributionControl: true });
    mapRef.current = map;
    map.addControl(new maplibregl.FullscreenControl(), "bottom-right");
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: "metric" }), "bottom-left");
    const handleStyleLoad = async () => {
      const currentMap = mapRef.current;
      if (disposed || !currentMap) return;
      mapReadyRef.current = false;
      setIsMapLoading(true);
      try {
        await restoreCustomLayers(currentMap);
        if (disposed || currentMap !== mapRef.current) return;
        bindLayerInteractions(currentMap);
        mapReadyRef.current = true;
        requestAnimationFrame(() => {
          if (currentMap === mapRef.current) applyTerritorialSelection(currentMap);
        });
        setIsMapLoading(false);
        setMapError(null);
        console.info("style.load completado y capas restauradas");
      } catch (error) {
        console.error("Fallo restaurando capas tras style.load:", error);
        if (!disposed) {
          mapReadyRef.current = false;
          setIsMapLoading(false);
          setMapError(error?.message || "Falló una operación no identificada al restaurar las capas del visor.");
        }
      }
    };
    map.on("style.load", handleStyleLoad);
    map.on("error", (event) => { if (event?.error) console.error("Error de MapLibre:", event.error); });
    if (typeof ResizeObserver !== "undefined") { resizeObserver = new ResizeObserver(() => map.resize()); resizeObserver.observe(mapContainer.current); }
    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      map.off("style.load", handleStyleLoad);
      mapReadyRef.current = false;
      restorePromiseRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    selectedProvinceRef.current = selectedProvince;
    selectedDistrictRef.current = selectedDistrict;
    const map = mapRef.current;
    if (!map || !mapReadyRef.current || !canUseStyle(map)) return;
    applyTerritorialSelection(map);
    requestAnimationFrame(() => { if (mapRef.current === map && mapReadyRef.current) focusSelectedTerritory(map); });
  }, [selectedProvince, selectedDistrict]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current || !canUseStyle(map)) return;
    try { map.getSource(SOURCE.projects)?.setData(projectsDataRef.current); }
    catch (error) { console.error("No se pudieron actualizar los proyectos filtrados:", error); }
  }, [projects]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current || !canUseStyle(map) || !map.getLayer(LAYER.selected)) return;
    try { map.setFilter(LAYER.selected, ["all", ["!", ["has", "point_count"]], ["==", ["get", "__project_key"], String(selectedId ?? "")]]); }
    catch (error) { console.error("No se pudo restaurar el proyecto seleccionado:", error); }
  }, [selectedId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current || !canUseStyle(map) || !map.getLayer(LAYER.selectedLocation)) return;
    try { map.setFilter(LAYER.selectedLocation, ["all", ["!", ["has", "point_count"]], ["==", ["get", "__location_key"], String(selectedLocationKey ?? "")]]); }
    catch (error) { console.error("No se pudo restaurar la ubicación seleccionada:", error); }
  }, [selectedLocationKey]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || baseMapRef.current === baseMap) return;
    baseMapRef.current = baseMap;
    mapReadyRef.current = false;
    setIsMapLoading(true);
    setMapError(null);
    restorePromiseRef.current = null;
    try { map.setStyle(BASE_MAPS[baseMap] || BASE_MAPS.claro, { diff: false }); }
    catch (error) { console.error("No se pudo cambiar el mapa base:", error); }
  }, [baseMap]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapAction?.type) return;
    if (mapAction.type === "zoomIn") map.zoomIn({ duration: 300 });
    if (mapAction.type === "zoomOut") map.zoomOut({ duration: 300 });
    if (mapAction.type === "locate") focusSelectedTerritory(map);
    if (mapAction.type === "selected" && selectedId && projectsDataRef.current) {
      const location = selectedLocationKey ? locationsByKeyRef.current.get(selectedLocationKey) : null;
      if (location?.geometry?.type === "Point") map.easeTo({ center:location.geometry.coordinates, zoom:Math.max(map.getZoom(), 13), duration:700 });
      else focusLogicalProject(map, locationsByProjectRef.current, selectedId);
    }
  }, [mapAction, selectedId, selectedLocationKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => mapRef.current?.resize(), 240);
    return () => window.clearTimeout(timer);
  }, [filtersOpen]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const map = mapRef.current;
      map?.resize();
      if (!map || !projectPanelOpen || !selectedId || !projectsDataRef.current) return;
      const mobile = window.innerWidth < 768;
      const location = selectedLocationKey ? locationsByKeyRef.current.get(selectedLocationKey) : null;
      if (location?.geometry?.type === "Point") map.easeTo({ center:location.geometry.coordinates, zoom:Math.max(map.getZoom(), 13), duration:700, offset:mobile ? [0,-110] : [filtersOpen ? 20 : -150,0] });
      else focusLogicalProject(map, locationsByProjectRef.current, selectedId, { offset: mobile ? [0, -110] : [filtersOpen ? 20 : -150, 0] });
    }, 260);
    return () => window.clearTimeout(timer);
  }, [projectPanelOpen, selectedId, selectedLocationKey, filtersOpen]);

  return <div className="map-canvas" aria-label="Mapa interactivo de proyectos de Ayacucho">
    <div ref={mapContainer} style={{ position: "absolute", inset: 0 }} />
    {isMapLoading && !mapError && <div role="status" aria-live="polite" style={{ position: "absolute", left: "50%", bottom: 32, zIndex: 5, transform: "translateX(-50%)", padding: "8px 12px", borderRadius: 10, background: "rgba(255,255,255,.94)", color: "#20312a", boxShadow: "0 4px 16px #20312a20", fontSize: 11 }}>
      Cargando mapa y capas territoriales...
    </div>}
    {mapError && <div role="alert" style={{ position: "absolute", inset: 0, zIndex: 5, display: "grid", placeItems: "center", padding: 24, background: "#eef3f0dd", color: "#20312a", textAlign: "center" }}>
      <div style={{ maxWidth: 430, padding: 18, borderRadius: 14, background: "white", boxShadow: "0 5px 24px #20312a25" }}><strong>No fue posible cargar las capas territoriales</strong><p style={{ margin: "8px 0 0", fontSize: 12 }}>{mapError}</p></div>
    </div>}
  </div>;
}
