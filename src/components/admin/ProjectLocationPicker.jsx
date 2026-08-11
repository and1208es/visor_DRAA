import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Crosshair, LocateFixed, MapPin, X } from 'lucide-react'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { getDistrictName, getGeoJSONBounds, getProvinceName, normalizeTerritory } from '../MapCanvas'

const SATELLITE_STYLE = {
  version: 8,
  sources: {
    satellite: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      attribution: 'Tiles © Esri',
    },
  },
  layers: [{ id: 'satellite', type: 'raster', source: 'satellite' }],
}
const DATA_URLS = {
  provinces: `${import.meta.env.BASE_URL}data/provincias.geojson`,
  districts: `${import.meta.env.BASE_URL}data/distritos.geojson`,
}
const AYACUCHO_CENTER = [-74.2, -13.15]

function hasValidCoordinates(latitude, longitude) {
  if (latitude === '' || longitude === '' || latitude === null || longitude === null || latitude === undefined || longitude === undefined) return false
  const lat = Number(latitude), lng = Number(longitude)
  return Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
}

function pointInRing([x, y], ring = []) {
  let inside = false
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [xi, yi] = ring[index], [xj, yj] = ring[previous]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function pointInPolygon(point, polygon = []) {
  return Boolean(polygon[0] && pointInRing(point, polygon[0]) && !polygon.slice(1).some(ring => pointInRing(point, ring)))
}

function featureContainsPoint(feature, point) {
  const { type, coordinates } = feature?.geometry || {}
  if (type === 'Polygon') return pointInPolygon(point, coordinates)
  if (type === 'MultiPolygon') return coordinates.some(polygon => pointInPolygon(point, polygon))
  return false
}

function addTerritorialLayers(map, provinces, districts) {
  map.addSource('picker-provinces', { type: 'geojson', data: provinces })
  map.addLayer({ id: 'picker-provinces-halo', type: 'line', source: 'picker-provinces', paint: { 'line-color': '#12251f', 'line-width': 4, 'line-opacity': 0.75 } })
  map.addLayer({ id: 'picker-provinces-line', type: 'line', source: 'picker-provinces', paint: { 'line-color': '#b9ffe3', 'line-width': 2, 'line-opacity': 0.95 } })
  map.addSource('picker-districts', { type: 'geojson', data: districts })
  map.addLayer({ id: 'picker-districts-halo', type: 'line', source: 'picker-districts', paint: { 'line-color': '#17322d', 'line-width': 2.2, 'line-opacity': 0.65 } })
  map.addLayer({ id: 'picker-districts-line', type: 'line', source: 'picker-districts', paint: { 'line-color': '#d9ffff', 'line-width': 1, 'line-opacity': 0.8 } })
}

export default function ProjectLocationPicker({ latitude, longitude, province, district, onCancel, onConfirm }) {
  const containerRef = useRef(null), mapRef = useRef(null), markerRef = useRef(null), provincesRef = useRef(null)
  const hasInitialPoint = hasValidCoordinates(latitude, longitude)
  const [selection, setSelection] = useState(hasInitialPoint ? { latitude: Number(latitude), longitude: Number(longitude) } : null)
  const [outsideAyacucho, setOutsideAyacucho] = useState(false)
  const [message, setMessage] = useState('')
  const [satelliteError, setSatelliteError] = useState(false)
  const selectionRef = useRef(selection)

  const selectPoint = (lng, lat, map = mapRef.current) => {
    if (!hasValidCoordinates(lat, lng)) return
    const next = { latitude: lat, longitude: lng }
    selectionRef.current = next
    setSelection(next)
    setMessage('')
    setOutsideAyacucho(Boolean(provincesRef.current && !provincesRef.current.features.some(feature => featureContainsPoint(feature, [lng, lat]))))
    if (!markerRef.current) markerRef.current = new maplibregl.Marker({ color: '#d14f3f' })
    markerRef.current.setLngLat([lng, lat]).addTo(map)
  }

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: SATELLITE_STYLE,
      center: hasInitialPoint ? [Number(longitude), Number(latitude)] : AYACUCHO_CENTER,
      zoom: hasInitialPoint ? 15 : 7,
    })
    mapRef.current = map
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    const handleClick = event => selectPoint(event.lngLat.lng, event.lngLat.lat, map)
    const handleMapError = event => {
      console.error('Error mapa satelital selector:', event?.error || event)
      if (event?.sourceId === 'satellite' || String(event?.error?.message || '').toLowerCase().includes('tile')) setSatelliteError(true)
    }
    map.on('click', handleClick)
    map.on('error', handleMapError)
    map.on('load', async () => {
      console.info('Mapa satelital del selector cargado')
      map.resize()
      try {
        const [provincesResponse, districtsResponse] = await Promise.all(Object.values(DATA_URLS).map(url => fetch(url, { signal: controller.signal })))
        if (!provincesResponse.ok || !districtsResponse.ok) throw new Error('No fue posible cargar los límites territoriales.')
        const [provinces, districts] = await Promise.all([provincesResponse.json(), districtsResponse.json()])
        if (!active) return
        provincesRef.current = provinces
        addTerritorialLayers(map, provinces, districts)
        const normalizedProvince = normalizeTerritory(province), normalizedDistrict = normalizeTerritory(district)
        const districtFeature = normalizedDistrict && districts.features.find(feature => normalizeTerritory(getDistrictName(feature)) === normalizedDistrict && (!normalizedProvince || normalizeTerritory(getProvinceName(feature)) === normalizedProvince))
        const provinceFeature = normalizedProvince && provinces.features.find(feature => normalizeTerritory(getProvinceName(feature)) === normalizedProvince)
        console.info('LocationPicker:', { latitude, longitude, province, district, hasCoordinates: hasInitialPoint, provinceFound: Boolean(provinceFeature), districtFound: Boolean(districtFeature) })
        if (selectionRef.current) selectPoint(selectionRef.current.longitude, selectionRef.current.latitude, map)
        else {
          const bounds = getGeoJSONBounds(districtFeature || provinceFeature || provinces)
          if (bounds) map.fitBounds(bounds, { padding: districtFeature || provinceFeature ? 45 : 30, maxZoom: districtFeature ? 14 : provinceFeature ? 9 : 8, duration: 0 })
        }
        map.resize()
        requestAnimationFrame(() => map.resize())
      } catch (error) {
        if (error.name !== 'AbortError') setMessage(error.message || 'No fue posible cargar el mapa.')
      }
    })
    const resizeTimer = window.setTimeout(() => map.resize(), 150)
    return () => {
      active = false
      controller.abort()
      window.clearTimeout(resizeTimer)
      map.off('click', handleClick)
      map.off('error', handleMapError)
      markerRef.current?.remove()
      markerRef.current = null
      map.remove()
      mapRef.current = null
    }
  }, []) // El selector se monta de nuevo en cada apertura; conserva sus valores iniciales.

  const recenter = () => {
    const point = selectionRef.current
    if (point) mapRef.current?.flyTo({ center: [point.longitude, point.latitude], zoom: 15 })
    else mapRef.current?.flyTo({ center: AYACUCHO_CENTER, zoom: 7 })
  }
  const geolocate = () => {
    setMessage('')
    if (!navigator.geolocation) return setMessage('La geolocalización no está disponible en este navegador.')
    navigator.geolocation.getCurrentPosition(({ coords }) => {
      selectPoint(coords.longitude, coords.latitude)
      mapRef.current?.flyTo({ center: [coords.longitude, coords.latitude], zoom: 14 })
    }, () => setMessage('No se pudo obtener tu ubicación. Revisa el permiso de ubicación del navegador.'), { enableHighAccuracy: true, timeout: 10000 })
  }
  const confirm = () => {
    if (selection && hasValidCoordinates(selection.latitude, selection.longitude)) onConfirm({ latitude: selection.latitude.toFixed(6), longitude: selection.longitude.toFixed(6) })
  }

  return <div className="location-picker-backdrop" role="presentation">
    <section className="location-picker" role="dialog" aria-modal="true" aria-labelledby="location-picker-title">
      <header><div><span className="admin-eyebrow">Ubicación del proyecto</span><h2 id="location-picker-title">Seleccionar ubicación en mapa</h2></div><button type="button" onClick={onCancel} aria-label="Cerrar selector"><X /></button></header>
      <div className="location-picker-body">
        <div className="location-picker-toolbar"><button type="button" onClick={geolocate}><LocateFixed />Usar mi ubicación</button><button type="button" onClick={recenter}><Crosshair />Recentrar</button></div>
        <div style={{ position: 'relative' }}>
          <div ref={containerRef} className="location-picker-map" aria-label="Mapa satelital para seleccionar la ubicación" />
          {satelliteError && <div role="alert" style={{ position: 'absolute', inset: 0, zIndex: 2, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}><span style={{ padding: '10px 14px', borderRadius: 9, background: 'rgba(22,35,30,.88)', color: '#fff', fontSize: 11 }}>No fue posible cargar la imagen satelital.</span></div>}
        </div>
        <div className="location-picker-coordinates"><div><span>Latitud</span><strong>{selection ? selection.latitude.toFixed(6) : '—'}</strong></div><div><span>Longitud</span><strong>{selection ? selection.longitude.toFixed(6) : '—'}</strong></div><small><MapPin />Haz clic en el mapa para colocar o mover el marcador.</small></div>
        {outsideAyacucho && <div className="location-picker-warning" role="status"><AlertTriangle />La ubicación seleccionada parece encontrarse fuera del departamento de Ayacucho.</div>}
        {message && <div className="admin-inline-error" role="alert">{message}</div>}
      </div>
      <footer><button type="button" className="admin-secondary" onClick={onCancel}>Cancelar</button><button type="button" className="admin-primary" disabled={!selection || !hasValidCoordinates(selection.latitude, selection.longitude)} onClick={confirm}>Confirmar ubicación</button></footer>
    </section>
  </div>
}
