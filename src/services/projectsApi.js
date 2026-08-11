import { getAccessToken, logout } from './authApi'

const API_BASE_URL = (import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000').replace(/\/$/,'')

async function apiRequest(path, options = {}) {
  const { auth = false, ...fetchOptions } = options
  const headers = new Headers(fetchOptions.headers || {})
  if (auth) {
    const token = getAccessToken()
    if (token) headers.set('Authorization',`Bearer ${token}`)
  }
  let response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { ...fetchOptions, headers })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw new Error('No se pudo conectar con el servidor de gestión.')
  }
  if (response.status === 204) return null
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    if (response.status === 401 && auth) {
      logout()
      window.dispatchEvent(new CustomEvent('draa:auth-expired'))
      throw new Error('La sesión ha expirado. Inicia sesión nuevamente.')
    }
    if (response.status === 422 && Array.isArray(body?.detail)) {
      const detail = body.detail.map(item => `${item.loc?.at(-1) || 'campo'}: ${item.msg}`).join('. ')
      throw new Error(`Revisa los datos ingresados. ${detail}`)
    }
    if (response.status === 404) throw new Error(body?.detail || 'Proyecto no encontrado.')
    if (response.status === 413) throw new Error(body?.detail || 'La fotografía supera el tamaño permitido por el servidor.')
    if (response.status >= 500) throw new Error(body?.detail || 'El servidor no pudo completar la operación.')
    throw new Error(typeof body?.detail === 'string' ? body.detail : `Error del servidor (${response.status}).`)
  }
  return body
}

export async function fetchProjectsFromApi({ signal } = {}) {
  const projects = await apiRequest('/api/proyectos', { signal })
  if (!Array.isArray(projects)) throw new Error('La API de proyectos no devolvió una lista')
  return projects
}

export function fetchProjectById(id, { signal } = {}) {
  return apiRequest(`/api/proyectos/${encodeURIComponent(id)}`, { signal })
}

export function createProject(data) {
  return apiRequest('/api/proyectos', { auth:true, method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) })
}

export function updateProject(id, data) {
  return apiRequest(`/api/proyectos/${encodeURIComponent(id)}`, { auth:true, method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) })
}

export function deleteProject(id) {
  return apiRequest(`/api/proyectos/${encodeURIComponent(id)}`, { auth:true, method:'DELETE' })
}

export function resolveApiAssetUrl(path) {
  if (!path) return ''
  if (/^https?:\/\//i.test(path)) return path
  return `${API_BASE_URL}${path.startsWith('/') ? '' : '/'}${path}`
}

export function fetchProjectPhotos(projectId) {
  return apiRequest(`/api/proyectos/${encodeURIComponent(projectId)}/fotos`)
}

export function uploadProjectPhotos(projectId, files) {
  const body = new FormData()
  Array.from(files).forEach(file => body.append('files',file))
  return apiRequest(`/api/proyectos/${encodeURIComponent(projectId)}/fotos`, { auth:true, method:'POST', body })
}

export function updateProjectPhoto(projectId, photoId, data) {
  return apiRequest(`/api/proyectos/${encodeURIComponent(projectId)}/fotos/${encodeURIComponent(photoId)}`, { auth:true, method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) })
}

export function deleteProjectPhoto(projectId, photoId) {
  return apiRequest(`/api/proyectos/${encodeURIComponent(projectId)}/fotos/${encodeURIComponent(photoId)}`, { auth:true, method:'DELETE' })
}

export function projectsToFeatureCollection(projects) {
  if (!Array.isArray(projects)) throw new TypeError('projects debe ser una lista')
  const features = projects.map(project => {
    const latitude = Number(project.latitud)
    const longitude = Number(project.longitud)
    if (project.latitud === null || project.longitud === null || !Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      console.warn('Proyecto sin coordenadas cartográficas:', project.id)
    }
    return {
      type: 'Feature',
      properties: {
        id: project.id,
        nombre_proyecto: project.nombre_proyecto,
        provincia: project.provincia,
        distrito: project.distrito,
        comunidad: project.comunidad,
        estado: project.estado,
        fecha_inicio: project.fecha_inicio,
        presupuesto: project.presupuesto,
        beneficiarios: project.beneficiarios,
        descripcion: project.descripcion,
        photos: Array.isArray(project.photos) ? [...project.photos].sort((a,b) => Number(b.is_primary)-Number(a.is_primary) || a.sort_order-b.sort_order).map(photo => resolveApiAssetUrl(photo.url)) : [],
      },
      geometry: project.latitud === null || project.longitud === null || !Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180
        ? null
        : { type: 'Point', coordinates: [longitude, latitude] },
    }
  })
  return { type: 'FeatureCollection', features }
}
