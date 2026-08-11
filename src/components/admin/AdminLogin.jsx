import { useState } from 'react'
import { ArrowLeft, LoaderCircle, LockKeyhole, User } from 'lucide-react'
import LOGO_URL from '../../../assets/img/logo_draa.jpg'
import { login } from '../../services/authApi'

export default function AdminLogin({ onSuccess, onCancel }) {
  const [username,setUsername]=useState(''),[password,setPassword]=useState(''),[loading,setLoading]=useState(false),[error,setError]=useState('')
  const submit=async event=>{event.preventDefault();setError('');if(!username.trim()||!password){setError('Ingresa usuario y contraseña.');return}setLoading(true);try{onSuccess(await login(username.trim(),password))}catch(err){setError(err.message)}finally{setLoading(false)}}
  return <div className="admin-login-shell"><header><button onClick={onCancel}><ArrowLeft/>Volver al visor</button></header><main><section className="admin-login-card"><img src={LOGO_URL} alt="Logo DRA Ayacucho"/><span className="admin-eyebrow">Dirección Regional de Agricultura Ayacucho</span><h1>Gestión de Proyectos</h1><p>Ingresa tus credenciales de administrador.</p><form onSubmit={submit}><label><span>Usuario</span><div><User/><input autoComplete="username" value={username} onChange={event=>setUsername(event.target.value)}/></div></label><label><span>Contraseña</span><div><LockKeyhole/><input type="password" autoComplete="current-password" value={password} onChange={event=>setPassword(event.target.value)}/></div></label>{error&&<div className="admin-inline-error" role="alert">{error}</div>}<button className="admin-primary" disabled={loading}>{loading?<><LoaderCircle className="spin"/>Iniciando sesión...</>:'Iniciar sesión'}</button></form></section></main></div>
}
