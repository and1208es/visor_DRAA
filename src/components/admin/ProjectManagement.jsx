import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, ImagePlus, LoaderCircle, MapPin, Pencil, Plus, Search, Star, Trash2, X } from 'lucide-react'
import LOGO_URL from '../../../assets/img/logo_draa.jpg'
import { createProject, deleteProject, deleteProjectPhoto, fetchProjectById, fetchProjectPhotos, fetchProjectsFromApi, resolveApiAssetUrl, updateProject, updateProjectPhoto, uploadProjectPhotos } from '../../services/projectsApi'
import ProjectLocationPicker from './ProjectLocationPicker'

// TODO SECURITY: El módulo administrativo debe protegerse con autenticación y autorización antes de desplegarse públicamente.

const EMPTY_FORM = { id_proyecto:'', nombre_proyecto:'', provincia:'', distrito:'', comunidad:'', estado:'', fecha_inicio:'', presupuesto:'', beneficiarios:'', descripcion:'', latitud:'', longitud:'' }
const TERRITORY_URLS = {
  provinces:`${import.meta.env.BASE_URL}data/provincias.geojson`,
  districts:`${import.meta.env.BASE_URL}data/distritos.geojson`,
}
const text = value => String(value ?? '').trim()
const territoryLabel = value => text(value).toLocaleLowerCase('es').replace(/(^|\s)\p{L}/gu, letter => letter.toLocaleUpperCase('es'))
const money = value => Number.isFinite(Number(value)) ? new Intl.NumberFormat('es-PE',{style:'currency',currency:'PEN',maximumFractionDigits:2}).format(Number(value)) : 'No disponible'

function validate(form) {
  const errors = {}
  if (!text(form.id_proyecto)) errors.id_proyecto = 'El ID del proyecto es obligatorio.'
  if (!text(form.nombre_proyecto)) errors.nombre_proyecto = 'El nombre es obligatorio.'
  if (!form.provincia) errors.provincia = 'Selecciona una provincia.'
  if (!form.distrito) errors.distrito = 'Selecciona un distrito.'
  const checks = [
    ['presupuesto',0,Infinity,'El presupuesto debe ser mayor o igual a 0.'],
    ['beneficiarios',0,Infinity,'Los beneficiarios deben ser mayores o iguales a 0.'],
    ['latitud',-90,90,'La latitud debe estar entre -90 y 90.'],
    ['longitud',-180,180,'La longitud debe estar entre -180 y 180.'],
  ]
  checks.forEach(([field,min,max,message]) => { if (form[field] !== '' && (!Number.isFinite(Number(form[field])) || Number(form[field]) < min || Number(form[field]) > max)) errors[field] = message })
  return errors
}

function payloadFromForm(form) {
  const nullableText = value => text(value) || null
  const nullableNumber = value => value === '' ? null : Number(value)
  return {
    id_proyecto:text(form.id_proyecto), nombre_proyecto:text(form.nombre_proyecto), provincia:form.provincia, distrito:form.distrito,
    comunidad:nullableText(form.comunidad), estado:nullableText(form.estado), fecha_inicio:nullableText(form.fecha_inicio),
    presupuesto:nullableNumber(form.presupuesto), beneficiarios:nullableNumber(form.beneficiarios), descripcion:nullableText(form.descripcion),
    latitud:nullableNumber(form.latitud), longitud:nullableNumber(form.longitud),
  }
}

function PhotoManager({ projectId, onChanged }) {
  const [photos,setPhotos]=useState([]),[pending,setPending]=useState([]),[loading,setLoading]=useState(true),[uploading,setUploading]=useState(''),[error,setError]=useState(''),[deleteCandidate,setDeleteCandidate]=useState(null)
  const pendingRef=useRef([])
  const load=async()=>{setLoading(true);setError('');try{setPhotos(await fetchProjectPhotos(projectId))}catch(err){setError(err.message)}finally{setLoading(false)}}
  useEffect(()=>{load()},[projectId])
  useEffect(()=>{pendingRef.current=pending},[pending])
  useEffect(()=>()=>pendingRef.current.forEach(item=>URL.revokeObjectURL(item.preview)),[])
  const choose=event=>{const selected=Array.from(event.target.files||[]);event.target.value='';setError('');const valid=[];for(const file of selected){if(!['image/jpeg','image/png','image/webp'].includes(file.type)){setError('Formato no admitido. Usa JPG, PNG o WebP.');continue}if(file.size>8*1024*1024){setError(`${file.name} supera el tamaño máximo de 8 MB.`);continue}valid.push({file,preview:URL.createObjectURL(file)})}if(photos.length+pending.length+valid.length>8){valid.forEach(item=>URL.revokeObjectURL(item.preview));setError('El proyecto admite como máximo 8 fotografías.');return}setPending(current=>[...current,...valid])}
  const removePending=index=>setPending(current=>{URL.revokeObjectURL(current[index].preview);return current.filter((_,position)=>position!==index)})
  const upload=async()=>{setError('');try{for(let index=0;index<pending.length;index+=1){setUploading(`Subiendo ${index+1} de ${pending.length}...`);await uploadProjectPhotos(projectId,[pending[index].file])}pending.forEach(item=>URL.revokeObjectURL(item.preview));setPending([]);await load();onChanged()}catch(err){setError(err.message)}finally{setUploading('')}}
  const makePrimary=async photo=>{try{await updateProjectPhoto(projectId,photo.id,{is_primary:true});await load();onChanged()}catch(err){setError(err.message)}}
  const move=async(index,direction)=>{const target=index+direction;if(target<0||target>=photos.length)return;try{await updateProjectPhoto(projectId,photos[index].id,{sort_order:photos[target].sort_order});await updateProjectPhoto(projectId,photos[target].id,{sort_order:photos[index].sort_order});await load();onChanged()}catch(err){setError(err.message)}}
  const remove=async()=>{try{await deleteProjectPhoto(projectId,deleteCandidate.id);setDeleteCandidate(null);await load();onChanged()}catch(err){setError(err.message)}}
  return <section className="admin-photos"><div className="admin-photos-heading"><div><h3>Fotografías</h3><p>Hasta 8 imágenes JPG, PNG o WebP. Máximo 8 MB por archivo.</p></div><label className="admin-photo-add"><ImagePlus/>Agregar fotografías<input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={choose}/></label></div>
    {error&&<div className="admin-inline-error" role="alert">{error}</div>}
    {pending.length>0&&<div className="admin-photo-pending"><strong>Listas para subir</strong><div>{pending.map((item,index)=><article key={`${item.file.name}-${index}`}><img src={item.preview}/><span>{item.file.name}<small>{(item.file.size/1024/1024).toFixed(2)} MB</small></span><button type="button" onClick={()=>removePending(index)} aria-label={`Quitar ${item.file.name}`}><X/></button></article>)}</div><button type="button" className="admin-primary" disabled={Boolean(uploading)} onClick={upload}>{uploading||`Subir ${pending.length} fotografía${pending.length===1?'':'s'}`}</button></div>}
    {loading?<div className="admin-photo-state"><LoaderCircle className="spin"/>Cargando fotografías...</div>:!photos.length?<div className="admin-photo-state">No hay fotografías registradas.</div>:<div className="admin-photo-grid">{photos.map((photo,index)=><article key={photo.id} className={photo.is_primary?'primary':''}><div className="admin-photo-preview"><img src={resolveApiAssetUrl(photo.url)} alt={photo.original_name}/>{photo.is_primary&&<span><Star/>Principal</span>}</div><p title={photo.original_name}>{photo.original_name}</p><div className="admin-photo-controls"><button type="button" disabled={index===0} onClick={()=>move(index,-1)} aria-label="Mover fotografía arriba"><ArrowUp/></button><button type="button" disabled={index===photos.length-1} onClick={()=>move(index,1)} aria-label="Mover fotografía abajo"><ArrowDown/></button><button type="button" disabled={photo.is_primary} onClick={()=>makePrimary(photo)}><Star/>Principal</button><button type="button" className="danger" onClick={()=>setDeleteCandidate(photo)}><Trash2/>Eliminar</button></div></article>)}</div>}
    {deleteCandidate&&<div className="admin-photo-confirm"><p>¿Eliminar esta fotografía?</p><div><button type="button" className="admin-secondary" onClick={()=>setDeleteCandidate(null)}>Cancelar</button><button type="button" className="admin-danger" onClick={remove}>Eliminar</button></div></div>}
  </section>
}

function ProjectForm({ project, provinces, districts, onClose, onSaved, onPhotosChanged }) {
  const [form,setForm] = useState(project ? Object.fromEntries(Object.keys(EMPTY_FORM).map(key => [key,project[key] ?? ''])) : EMPTY_FORM)
  const [errors,setErrors] = useState({})
  const [saving,setSaving] = useState(false)
  const [serverError,setServerError] = useState('')
  const [locationPickerOpen,setLocationPickerOpen] = useState(false)
  const [pendingPhotos,setPendingPhotos] = useState([])
  const pendingPhotosRef = useRef([])
  useEffect(()=>{pendingPhotosRef.current=pendingPhotos},[pendingPhotos])
  useEffect(()=>()=>pendingPhotosRef.current.forEach(item=>URL.revokeObjectURL(item.preview)),[])
  const districtOptions = districts.filter(item => item.province === form.provincia).map(item => item.name)
  const change = (field,value) => { setForm(current => ({...current,[field]:value,...(field === 'provincia'?{distrito:''}:{})})); setErrors(current => ({...current,[field]:''})) }
  const submit = async event => {
    event.preventDefault(); const nextErrors=validate(form); setErrors(nextErrors); if(Object.keys(nextErrors).length) return
    setSaving(true); setServerError('')
    try {
      if (project) { const saved=await updateProject(project.id,payloadFromForm(form)); await onSaved(saved,true); return }
      const createdProject = await createProject(payloadFromForm(form))
      if (!createdProject?.id) throw new Error('El servidor creó el proyecto pero no devolvió un identificador.')
      console.info('Fotos pendientes:', pendingPhotos.map(item=>({name:item.file?.name,size:item.file?.size,type:item.file?.type})))
      let uploaded = 0
      let uploadError = null
      for (let index=0;index<pendingPhotos.length;index+=1) {
        try {
          const response = await uploadProjectPhotos(createdProject.id,[pendingPhotos[index].file])
          uploaded += 1
          console.info(`Foto subida ${index+1}/${pendingPhotos.length}`,response)
        } catch (error) {
          uploadError ||= error
          if (error.message === 'La sesión ha expirado. Inicia sesión nuevamente.') throw error
        }
      }
      const refreshedProject = await fetchProjectById(createdProject.id)
      const notice = pendingPhotos.length
        ? `Proyecto creado correctamente. Se subieron ${uploaded} de ${pendingPhotos.length} fotografías.${uploadError ? ` ${uploadError.message}` : ''}`
        : 'Proyecto creado correctamente.'
      pendingPhotos.forEach(item=>URL.revokeObjectURL(item.preview))
      setPendingPhotos([])
      await onSaved(refreshedProject,false,notice)
    }
    catch(error){ setServerError(error.message || 'No fue posible guardar el proyecto.') }
    finally{ setSaving(false) }
  }
  const choosePendingPhotos=event=>{const selected=Array.from(event.target.files||[]);event.target.value='';setServerError('');const valid=[];for(const file of selected){if(!(file instanceof File)){setServerError('No fue posible leer uno de los archivos seleccionados.');continue}if(!['image/jpeg','image/png','image/webp'].includes(file.type)){setServerError('Formato no admitido. Usa JPG, PNG o WebP.');continue}if(file.size>8*1024*1024){setServerError(`${file.name} supera el tamaño máximo de 8 MB.`);continue}valid.push({file,preview:URL.createObjectURL(file)})}if(pendingPhotos.length+valid.length>8){valid.forEach(item=>URL.revokeObjectURL(item.preview));setServerError('El proyecto admite como máximo 8 fotografías.');return}setPendingPhotos(current=>[...current,...valid])}
  const removePendingPhoto=index=>setPendingPhotos(current=>{URL.revokeObjectURL(current[index].preview);return current.filter((_,position)=>position!==index)})
  const field = (name,label,type='text',required=false) => <label className="admin-field"><span>{label}{required&&' *'}</span><input type={type} value={form[name]} onChange={event=>change(name,event.target.value)} aria-invalid={Boolean(errors[name])}/>{errors[name]&&<small>{errors[name]}</small>}</label>
  return <div className="admin-modal-backdrop" role="presentation"><section className="admin-form-panel" role="dialog" aria-modal="true" aria-labelledby="project-form-title">
    <header><div><span className="admin-eyebrow">Gestión de proyectos</span><h2 id="project-form-title">{project?'Editar proyecto':'Nuevo proyecto'}</h2></div><button type="button" onClick={onClose} aria-label="Cerrar formulario"><X/></button></header>
    <form onSubmit={submit} noValidate>
      {serverError&&<div className="admin-inline-error" role="alert">{serverError}</div>}
      {field('id_proyecto','ID del proyecto','text',true)}
      {field('nombre_proyecto','Nombre del proyecto','text',true)}
      <div className="admin-form-grid"><label className="admin-field"><span>Provincia *</span><select value={form.provincia} onChange={event=>change('provincia',event.target.value)} aria-invalid={Boolean(errors.provincia)}><option value="">Seleccionar</option>{provinces.map(value=><option key={value}>{value}</option>)}</select>{errors.provincia&&<small>{errors.provincia}</small>}</label><label className="admin-field"><span>Distrito *</span><select value={form.distrito} disabled={!form.provincia} onChange={event=>change('distrito',event.target.value)} aria-invalid={Boolean(errors.distrito)}><option value="">Seleccionar</option>{districtOptions.map(value=><option key={value}>{value}</option>)}</select>{errors.distrito&&<small>{errors.distrito}</small>}</label></div>
      <div className="admin-form-grid">{field('comunidad','Comunidad')}<label className="admin-field"><span>Estado</span><select value={form.estado} onChange={event=>change('estado',event.target.value)}><option value="">Seleccionar</option><option>Planificado</option><option>En ejecución</option><option>Finalizado</option></select></label></div>
      <div className="admin-form-grid">{field('fecha_inicio','Fecha de inicio','date')}{field('presupuesto','Presupuesto','number')}</div>
      <div className="admin-form-grid">{field('beneficiarios','Beneficiarios','number')}{field('latitud','Latitud','number')}</div>
      <div className="admin-form-grid">{field('longitud','Longitud','number')}<div className="admin-map-placeholder"><button type="button" onClick={()=>setLocationPickerOpen(true)}><MapPin/>Seleccionar ubicación en mapa</button><small>También puedes escribir las coordenadas manualmente.</small></div></div>
      {project&&<p>Ubicaciones: {project.locations?.length || 0}</p>}
      {project&&<p>TODO: Gestión múltiple de ubicaciones.</p>}
      <label className="admin-field"><span>Descripción</span><textarea rows="5" value={form.descripcion} onChange={event=>change('descripcion',event.target.value)}/></label>
      {!project&&<section className="admin-photos"><div className="admin-photos-heading"><div><h3>Fotografías</h3><p>Se subirán después de crear el proyecto. Hasta 8 imágenes JPG, PNG o WebP.</p></div><label className="admin-photo-add"><ImagePlus/>Agregar fotografías<input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={choosePendingPhotos}/></label></div>{pendingPhotos.length>0&&<div className="admin-photo-pending"><strong>Listas para subir</strong><div>{pendingPhotos.map((item,index)=><article key={`${item.file.name}-${index}`}><img src={item.preview}/><span>{item.file.name}<small>{(item.file.size/1024/1024).toFixed(2)} MB</small></span><button type="button" disabled={saving} onClick={()=>removePendingPhoto(index)} aria-label={`Quitar ${item.file.name}`}><X/></button></article>)}</div></div>}</section>}
      {project&&<PhotoManager projectId={project.id} onChanged={onPhotosChanged}/>} 
      <footer><button type="button" className="admin-secondary" onClick={onClose}>Cancelar</button><button type="submit" className="admin-primary" disabled={saving}>{saving?<><LoaderCircle className="spin"/>Guardando...</>:project?'Guardar cambios':'Crear proyecto'}</button></footer>
    </form>
  </section>{locationPickerOpen&&<ProjectLocationPicker latitude={form.latitud} longitude={form.longitud} province={form.provincia} district={form.distrito} onCancel={()=>setLocationPickerOpen(false)} onConfirm={({latitude,longitude})=>{change('latitud',latitude);change('longitud',longitude);setLocationPickerOpen(false)}}/>}</div>
}

export default function ProjectManagement({ onBack, onLogout, adminUser, isReturning = false }) {
  const [projects,setProjects] = useState([]), [loading,setLoading] = useState(true), [error,setError] = useState(''), [query,setQuery] = useState('')
  const [formProject,setFormProject] = useState(undefined), [confirmProject,setConfirmProject] = useState(null), [notice,setNotice] = useState(''), [dirty,setDirty] = useState(false)
  const [territories,setTerritories] = useState({provinces:[],districts:[]})
  const load = async signal => { setLoading(true);setError('');try{setProjects(await fetchProjectsFromApi({signal}))}catch(err){if(err.name!=='AbortError')setError('No se pudo conectar con el servidor de gestión.')}finally{if(!signal?.aborted)setLoading(false)} }
  useEffect(()=>{const controller=new AbortController();load(controller.signal);Promise.all(Object.values(TERRITORY_URLS).map(url=>fetch(url,{signal:controller.signal}).then(response=>{if(!response.ok)throw new Error(String(response.status));return response.json()}))).then(([provinces,districts])=>setTerritories({provinces:[...new Set(provinces.features.map(item=>territoryLabel(item.properties?.provincia)).filter(Boolean))].sort(),districts:districts.features.map(item=>({province:territoryLabel(item.properties?.provincia),name:territoryLabel(item.properties?.distrito)})).filter(item=>item.province&&item.name)})).catch(err=>{if(err.name!=='AbortError')console.error('No se cargaron los selectores territoriales:',err)});return()=>controller.abort()},[])
  const filtered=useMemo(()=>{const term=query.toLocaleLowerCase('es');return projects.filter(project=>[project.id,project.id_proyecto,project.nombre_proyecto,project.provincia,project.distrito,project.estado].some(value=>String(value??'').toLocaleLowerCase('es').includes(term)))},[projects,query])
  const saved = async (_,editing,customNotice) => { setFormProject(undefined);setDirty(true);setNotice(customNotice||(editing?'Proyecto actualizado correctamente.':'Proyecto creado correctamente.'));await load() }
  const deactivate = async () => { try{await deleteProject(confirmProject.id);setConfirmProject(null);setDirty(true);setNotice('Proyecto desactivado correctamente.');await load()}catch(err){setError(err.message||'No fue posible desactivar el proyecto.')} }
  return <div className="admin-shell">
    <header className="admin-topbar"><div className="admin-brand"><img src={LOGO_URL}/><div><strong>DRA Ayacucho</strong><span>Administración del visor</span></div></div><div className="admin-session"><span>Administrador: <b>{adminUser.full_name}</b></span><button disabled={isReturning} onClick={onLogout}>Cerrar sesión</button><button disabled={isReturning} onClick={()=>onBack(dirty)}>{isReturning?<LoaderCircle className="spin"/>:<ArrowLeft/>}{isReturning?'Actualizando proyectos...':'Volver al visor'}</button></div></header>
    <main className="admin-main"><section className="admin-heading"><div><span className="admin-eyebrow">Módulo administrativo</span><h1>Gestión de Proyectos</h1><p>Administra la información publicada en el visor.</p></div><button className="admin-primary" onClick={()=>setFormProject(null)}><Plus/>Nuevo proyecto</button></section>
      {notice&&<div className="admin-notice" role="status">{notice}<button onClick={()=>setNotice('')} aria-label="Cerrar mensaje"><X/></button></div>}
      <section className="admin-content"><div className="admin-toolbar"><label><Search/><input value={query} onChange={event=>setQuery(event.target.value)} placeholder="Buscar proyecto..."/></label><span>{filtered.length} proyectos</span></div>
        {loading?<div className="admin-state"><LoaderCircle className="spin"/>Cargando proyectos...</div>:error?<div className="admin-state error"><AlertTriangle/><strong>{error}</strong><button onClick={()=>load()}>Reintentar</button></div>:!filtered.length?<div className="admin-state">{query?'No hay coincidencias para la búsqueda.':'No hay proyectos registrados.'}</div>:<>
          <div className="admin-table-wrap"><table><thead><tr><th>Código</th><th>Proyecto</th><th>Provincia</th><th>Distrito</th><th>Estado</th><th>Presupuesto</th><th>Beneficiarios</th><th>Acciones</th></tr></thead><tbody>{filtered.map(project=><tr key={project.id}><td>PROY-{String(project.id).padStart(4,'0')}</td><td><strong>{project.nombre_proyecto}</strong></td><td>{project.provincia||'No disponible'}</td><td>{project.distrito||'No disponible'}</td><td><span className="admin-status">{project.estado||'No disponible'}</span></td><td>{money(project.presupuesto)}</td><td>{project.beneficiarios?.toLocaleString('es-PE')??'No disponible'}</td><td><div className="admin-actions"><button onClick={()=>setFormProject(project)}><Pencil/>Editar</button><button className="danger" onClick={()=>setConfirmProject(project)}><Trash2/>Desactivar</button></div></td></tr>)}</tbody></table></div>
          <div className="admin-cards">{filtered.map(project=><article key={project.id}><header><span>PROY-{String(project.id).padStart(4,'0')}</span><span className="admin-status">{project.estado||'No disponible'}</span></header><h2>{project.nombre_proyecto}</h2><p>{project.distrito||'No disponible'} · {project.provincia||'No disponible'}</p><dl><div><dt>Presupuesto</dt><dd>{money(project.presupuesto)}</dd></div><div><dt>Beneficiarios</dt><dd>{project.beneficiarios?.toLocaleString('es-PE')??'No disponible'}</dd></div></dl><div className="admin-actions"><button onClick={()=>setFormProject(project)}><Pencil/>Editar</button><button className="danger" onClick={()=>setConfirmProject(project)}><Trash2/>Desactivar</button></div></article>)}</div>
        </>}
      </section>
    </main>
    {formProject!==undefined&&<ProjectForm project={formProject} provinces={territories.provinces} districts={territories.districts} onClose={()=>setFormProject(undefined)} onSaved={saved} onPhotosChanged={()=>setDirty(true)}/>} 
    {confirmProject&&<div className="admin-modal-backdrop"><section className="admin-confirm" role="alertdialog" aria-modal="true"><AlertTriangle/><h2>¿Deseas desactivar este proyecto?</h2><p>Dejará de mostrarse en el visor público.</p><strong>{confirmProject.nombre_proyecto}</strong><div><button className="admin-secondary" onClick={()=>setConfirmProject(null)}>Cancelar</button><button className="admin-danger" onClick={deactivate}>Desactivar proyecto</button></div></section></div>}
  </div>
}
