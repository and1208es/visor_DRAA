export const normalizeProjectKeyPart = value => String(value ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/\s+/g, ' ')

const propertiesOf = feature => feature?.properties || {}
const normalizedProperty = (feature, candidates) => {
  const properties = propertiesOf(feature)
  const names = new globalThis.Map(Object.keys(properties).map(name => [normalizeProjectKeyPart(name), name]))
  const name = candidates.map(normalizeProjectKeyPart).find(candidate => names.has(candidate))
  return name ? properties[names.get(name)] : null
}

export function getProjectKey(feature) {
  const properties = propertiesOf(feature)
  return String(properties.id_proyecto ?? properties.id_proy ?? '').trim()
}

export function getLocationKey(feature) {
  const properties = propertiesOf(feature)
  const projectKey = getProjectKey(feature)
  const explicit = properties.location_id ?? properties.id
  if (projectKey && explicit !== null && explicit !== undefined && String(explicit).trim()) return `${projectKey}|${String(explicit).trim()}`
  const coordinates = feature?.geometry?.type === 'Point' ? feature.geometry.coordinates : null
  const longitude = Number(coordinates?.[0]), latitude = Number(coordinates?.[1])
  if (!projectKey || !Number.isFinite(longitude) || !Number.isFinite(latitude)) return ''
  return `${projectKey}|${longitude.toFixed(7)}|${latitude.toFixed(7)}`
}

export function getLocationProvince(feature) { return normalizedProperty(feature, ['provincia', 'nom_prov', 'province']) }
export function getLocationDistrict(feature) { return normalizedProperty(feature, ['distrito', 'nom_dist', 'district']) }
export function getLocationCommunity(feature) { return normalizedProperty(feature, ['comunidad', 'nombre_comunidad', 'comunidad_campesina', 'localidad', 'centro_poblado', 'nom_com']) }
export function getLocationCoordinates(feature) {
  const coordinates = feature?.geometry?.type === 'Point' ? feature.geometry.coordinates : null
  return Array.isArray(coordinates) && Number.isFinite(Number(coordinates[0])) && Number.isFinite(Number(coordinates[1])) ? coordinates : null
}

export function prepareProjectFeatures(features = [], { warn = console.warn } = {}) {
  const valid = [], missingProjectIds = [], invalidGeometries = [], missingLocationIds = []
  features.forEach((feature, index) => {
    if (!feature || feature.type !== 'Feature') { invalidGeometries.push(index); return }
    feature.properties ||= {}
    const projectKey = getProjectKey(feature)
    const coordinates = getLocationCoordinates(feature)
    if (!projectKey) { missingProjectIds.push(index); return }
    if (!coordinates) { invalidGeometries.push(index); return }
    feature.properties.id_proyecto = projectKey
    feature.properties.__project_key = projectKey
    feature.properties.__location_key = getLocationKey(feature)
    if (!feature.properties.__location_key) { missingLocationIds.push(index); return }
    valid.push(feature)
  })
  if (missingProjectIds.length) warn(`${missingProjectIds.length} features sin id_proyecto/id_proy fueron excluidas.`)
  if (invalidGeometries.length) warn(`${invalidGeometries.length} features sin geometría Point válida fueron excluidas.`)
  if (missingLocationIds.length) warn(`${missingLocationIds.length} features sin clave de ubicación fueron excluidas.`)
  return { features:valid, missingProjectIds, invalidGeometries, missingLocationIds }
}

export function createProjectLocationIndex(features = []) {
  const index = new globalThis.Map()
  features.forEach(feature => {
    const projectKey = feature?.properties?.__project_key || getProjectKey(feature)
    if (!projectKey) return
    const locations = index.get(projectKey)
    if (locations) locations.push(feature)
    else index.set(projectKey, [feature])
  })
  return index
}

export function getUniqueProjects(features = []) {
  return [...createProjectLocationIndex(features)].map(([projectKey, locations]) => ({ projectKey, project:locations[0], locations }))
}
