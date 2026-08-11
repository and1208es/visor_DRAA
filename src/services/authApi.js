const API_BASE_URL = (import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000').replace(/\/$/,'')
const TOKEN_KEY = 'draa_admin_access_token'

export function getAccessToken() {
  return sessionStorage.getItem(TOKEN_KEY)
}

export function logout() {
  sessionStorage.removeItem(TOKEN_KEY)
}

async function authRequest(path, options = {}) {
  let response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, options)
  } catch {
    throw new Error('No fue posible conectar con el servidor.')
  }
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    if (response.status === 401) throw new Error(path.endsWith('/login') ? 'Usuario o contraseña incorrectos.' : 'La sesión ha expirado. Inicia sesión nuevamente.')
    throw new Error(typeof body?.detail === 'string' ? body.detail : 'No fue posible completar la autenticación.')
  }
  return body
}

export async function login(username, password) {
  const result = await authRequest('/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username,password}) })
  sessionStorage.setItem(TOKEN_KEY,result.access_token)
  return result.user
}

export async function getCurrentAdmin() {
  const token = getAccessToken()
  if (!token) return null
  try {
    return await authRequest('/api/auth/me', { headers:{Authorization:`Bearer ${token}`} })
  } catch (error) {
    logout()
    throw error
  }
}
