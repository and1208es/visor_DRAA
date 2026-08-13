import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search, SlidersHorizontal, X, ChevronLeft, ChevronRight, Map, Layers3, ZoomIn, ZoomOut, LocateFixed, FolderKanban, Activity, Users, Landmark, MapPin, CalendarDays, Building2, Sprout, Download, Share2, Image as ImageIcon, BarChart3, Info, Menu, CheckCircle2 } from 'lucide-react'
import { BarChart, Bar, XAxis, Tooltip, ResponsiveContainer } from 'recharts'
import MapCanvas from './components/MapCanvas'
import ProjectManagement from './components/admin/ProjectManagement'
import AdminLogin from './components/admin/AdminLogin'
import { Button } from './components/ui/button'
import { fetchProjectsFromApi, projectsToFeatureCollection } from './services/projectsApi'
import { getCurrentAdmin, logout as clearAdminSession } from './services/authApi'
import LOGO_URL from '../assets/img/logo_draa.jpg'
import { getLocationCommunity, getLocationCoordinates, getLocationDistrict, getLocationProvince, getUniqueProjects, prepareProjectFeatures } from './utils/uniqueProjects'

const PROJECTS_URL = `${import.meta.env.BASE_URL}data/proyectos.geojson`

const money = n => Number.isFinite(Number(n)) ? `S/ ${(Number(n) / 1000000).toFixed(1)} M` : 'No disponible'
const formatCurrencyPEN = (value, maximumFractionDigits = 0) => Number.isFinite(Number(value)) ? new Intl.NumberFormat('es-PE',{style:'currency',currency:'PEN',minimumFractionDigits:maximumFractionDigits,maximumFractionDigits}).format(Number(value)) : 'No disponible'
const normalizeText = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()
const safeValue = value => value === null || value === undefined || value === '' ? 'No disponible' : value
const propsOf = project => project?.properties || project || {}
const getProjectId = project => propsOf(project).id ?? propsOf(project).codigo_proyecto ?? null
const getProjectCode = project => propsOf(project).id_proyecto ?? propsOf(project).id_proy ?? propsOf(project).cui ?? propsOf(project).codigo ?? propsOf(project).codigo_proyecto ?? getProjectId(project)
const getProjectName = project => propsOf(project).name ?? propsOf(project).nombre ?? propsOf(project).nombre_proyecto ?? propsOf(project).proyecto ?? propsOf(project).titulo ?? ''
const getProjectProvince = project => propsOf(project).province ?? propsOf(project).provincia ?? ''
const getProjectDistrict = project => propsOf(project).district ?? propsOf(project).distrito ?? ''
const getProjectChain = project => propsOf(project).chain ?? propsOf(project).cadena ?? propsOf(project).cadena_productiva ?? ''
const getProjectStatus = project => propsOf(project).status ?? propsOf(project).estado ?? ''
const getProjectYear = project => propsOf(project).year ?? propsOf(project).anio ?? propsOf(project)['año'] ?? String(propsOf(project).fecha_inicio || '').slice(0,4)
const getProjectInvestment = project => propsOf(project).budget ?? propsOf(project).inversion ?? propsOf(project).presupuesto ?? null
const getProjectBeneficiaries = project => propsOf(project).beneficiaries ?? propsOf(project).beneficiarios ?? null
const getProjectProgress = project => propsOf(project).execution ?? propsOf(project).avance ?? propsOf(project).progreso ?? propsOf(project).porcentaje_avance ?? null
const getProjectDescription = project => propsOf(project).description ?? propsOf(project).descripcion ?? ''
const getProjectImages = project => { const p=propsOf(project); const values=Array.isArray(p.photos)?p.photos:[p.foto1,p.foto2,p.foto3]; return values.filter(value => typeof value === 'string' && value.trim()) }
const normalizeProgress = value => { if(value===null||value===undefined||value==='') return null; const raw=String(value).replace('%','').trim(); let number=Number(raw); if(!Number.isFinite(number)) return null; if(number>=0&&number<=1&&!String(value).includes('%')) number*=100; return Math.min(100,Math.max(0,Math.round(number))) }
const normalizeStatus = value => { const status=normalizeText(value); if(status==='en ejecucion') return 'En ejecución'; if(status==='planificado') return 'Planificado'; if(status==='finalizado') return 'Finalizado'; return value || 'No disponible' }
const sanitizePrintTitle = value => String(value ?? '').replace(/[\\/:*?"<>|]+/g,' ').replace(/\s+/g,' ').trim()
const projectName = getProjectName, projectCode = getProjectCode, projectProvince = getProjectProvince, projectDistrict = getProjectDistrict, projectChain = getProjectChain, projectStatus = getProjectStatus, projectYear = getProjectYear
const projectSearchText = project => [projectCode(project), projectName(project), projectChain(project), projectStatus(project), projectYear(project), ...(project.locations || [project]).flatMap(location => [projectProvince(location), projectDistrict(location)])].join(' ')

function SelectFilter({ label, value, onChange, options }) {
  return <label className="filter-field"><span>{label}</span><select value={value} onChange={e => onChange(e.target.value)}><option value="">Todos</option>{options.map(o => <option key={o}>{o}</option>)}</select></label>
}

function App() {
  const [currentView, setCurrentView] = useState('viewer')
  const [adminUser, setAdminUser] = useState(null)
  const [projects, setProjects] = useState([])
  const [projectsError, setProjectsError] = useState('')
  const [isRefreshingProjects, setIsRefreshingProjects] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [activeSearchIndex, setActiveSearchIndex] = useState(-1)
  const searchRef = useRef(null)
  const [filters, setFilters] = useState({ province: '', district: '', chain: '', status: '', year: '' })
  const [isFiltersOpen, setIsFiltersOpen] = useState(true)
  const [selectedProjectId, setSelectedProjectId] = useState(null)
  const [selectedLocation, setSelectedLocation] = useState(null)
  const [basemapOpen, setBasemapOpen] = useState(false)
  const [baseMap, setBaseMap] = useState('claro')
  const [mapAction, setMapAction] = useState(null)
  const [activePhoto, setActivePhoto] = useState('')
  const [printPhotoFailed, setPrintPhotoFailed] = useState(false)
  const selectedResultRef = useRef(null)
  const projectsRequestRef = useRef({ id: 0, controller: null })
  const runMapAction = type => setMapAction({ type, at: Date.now() })

  useEffect(() => {
    getCurrentAdmin().then(user => { if(user)setAdminUser(user) }).catch(() => setAdminUser(null))
    const expired=()=>{setAdminUser(null);setCurrentView('login')}
    window.addEventListener('draa:auth-expired',expired)
    return()=>window.removeEventListener('draa:auth-expired',expired)
  },[])

  const loadProjects = useCallback(async () => {
    projectsRequestRef.current.controller?.abort()
    const controller = new AbortController()
    const requestId = projectsRequestRef.current.id + 1
    projectsRequestRef.current = { id: requestId, controller }
    const mapFeatures = features => {
      const prepared = prepareProjectFeatures(features)
      return prepared.features.map(f => ({
        id:getProjectId(f), code:getProjectCode(f), name:getProjectName(f), province:getProjectProvince(f), district:getProjectDistrict(f), chain:getProjectChain(f),
        status:normalizeStatus(getProjectStatus(f)), budget:getProjectInvestment(f), beneficiaries:getProjectBeneficiaries(f), execution:normalizeProgress(getProjectProgress(f)),
        year:getProjectYear(f), community:f.properties?.comunidad, description:getProjectDescription(f), photos:getProjectImages(f),
        coordinates:f.geometry?.type === 'Point' && Array.isArray(f.geometry.coordinates) ? f.geometry.coordinates : null,
        projectKey:f.properties.__project_key, feature:f
      }))
    }
    const commit = (nextProjects, source) => {
      if (controller.signal.aborted || projectsRequestRef.current.id !== requestId) return
      setProjects(nextProjects); setProjectsError('')
      const groups = getUniqueProjects(nextProjects.map(project => project.feature))
      console.info('Features espaciales:', nextProjects.length)
      console.info('Proyectos únicos:', groups.length)
      console.info('Proyectos multiubicación:', groups.filter(group => group.locations.length > 1).length, 'Fuente:', source)
    }
    try {
      const apiProjects = await fetchProjectsFromApi({ signal:controller.signal })
      let features = projectsToFeatureCollection(apiProjects).features
      try {
        const response = await fetch(PROJECTS_URL, { signal:controller.signal })
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
        const geojson = await response.json()
        const apiProperties = new globalThis.Map(features.map(feature => [String(feature.properties.id_proyecto).trim(), feature.properties]))
        features = geojson.features.map(feature => {
          const key = String(feature.properties?.id_proyecto ?? feature.properties?.id_proy ?? '').trim()
          return { ...feature, properties:{ ...(apiProperties.get(key)||{}), ...feature.properties, id_proyecto:key } }
        })
      } catch (spatialError) { console.warn('No se pudo enriquecer la API con datos territoriales por ubicación.', spatialError) }
      commit(mapFeatures(features), 'api+geojson')
      return 'api'
    } catch (apiError) {
      if (controller.signal.aborted) return null
      console.warn('API no disponible. Usando GeoJSON como respaldo.', apiError)
      try {
        const response = await fetch(PROJECTS_URL, { signal:controller.signal })
        if (!response.ok) throw new Error(`GeoJSON de proyectos: ${response.status} ${response.statusText}`)
        const geojson = await response.json()
        if (geojson?.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) throw new Error('El GeoJSON de proyectos no es un FeatureCollection válido')
        commit(mapFeatures(geojson.features), 'geojson')
        return 'geojson'
      } catch (fallbackError) {
        if (controller.signal.aborted) return null
        console.error('No fue posible cargar proyectos desde API ni GeoJSON.', fallbackError)
        if (projectsRequestRef.current.id === requestId) { setProjects([]); setProjectsError('No fue posible cargar la información de proyectos.') }
        return null
      }
    }
  }, [])

  useEffect(() => {
    loadProjects()
    return () => projectsRequestRef.current.controller?.abort()
  }, [loadProjects])

  useEffect(() => {
    setFilters(current => {
      const province = current.province && projects.some(project => project.province === current.province) ? current.province : ''
      const district = current.district && projects.some(project => (!province || project.province === province) && project.district === current.district) ? current.district : ''
      const chain = current.chain && projects.some(project => project.chain === current.chain) ? current.chain : ''
      const status = current.status && projects.some(project => project.status === current.status) ? current.status : ''
      const year = current.year && projects.some(project => String(project.year) === String(current.year)) ? current.year : ''
      if (province === current.province && district === current.district && chain === current.chain && status === current.status && year === current.year) return current
      return { province, district, chain, status, year }
    })
  }, [projects])

  const values = key => [...new Set(projects.map(p => String(p[key] ?? '')).filter(Boolean))].sort()
  const districtOptions = [...new Set(projects.filter(p => !filters.province || p.province === filters.province).map(p => String(p.district)))].sort()
  const resolveValue = (key, value) => projects.find(project => normalizeText(project[key]) === normalizeText(value))?.[key] || value
  const changeProvince = value => setFilters(current => { const province = value ? resolveValue('province', value) : ''; return { ...current, province, district: current.district && projects.some(p => p.province === province && p.district === current.district) ? current.district : '' } })
  const changeDistrict = (value, provinceValue = '') => setFilters(current => { const requestedProvince = provinceValue ? resolveValue('province', provinceValue) : current.province; const project = projects.find(p => normalizeText(p.district) === normalizeText(value) && (!requestedProvince || normalizeText(p.province) === normalizeText(requestedProvince))); return { ...current, province: project?.province || requestedProvince, district: project?.district || value } })
  const filteredLocations = useMemo(() => projects.filter(p => Object.entries(filters).every(([k,v]) => !v || String(p[k]) === v)), [projects, filters])
  const toLogicalProjects = (groups, locations) => {
    const byFeature = new globalThis.Map(locations.map(project => [project.feature, project]))
    return groups.map(group => {
    const matches = group.locations.map(feature => byFeature.get(feature)).filter(Boolean)
    const photos = [...new Set(matches.flatMap(project => project.photos || []))]
    return { ...matches[0], id:group.projectKey, projectKey:group.projectKey, locations:matches, locationCount:matches.length, photos }
  })}
  const uniqueProjects = useMemo(() => toLogicalProjects(getUniqueProjects(projects.map(project => project.feature)), projects), [projects])
  const filtered = useMemo(() => toLogicalProjects(getUniqueProjects(filteredLocations.map(project => project.feature)), filteredLocations), [filteredLocations])
  const rankSearchResults = useMemo(() => {
    const term = normalizeText(searchTerm)
    if (!term) return []
    return filtered.map(project => {
      const name = normalizeText(projectName(project)); const code = normalizeText(projectCode(project))
      const index = normalizeText(projectSearchText(project))
      const score = code === term ? 0 : name.startsWith(term) ? 1 : name.includes(term) ? 2 : index.includes(term) ? 3 : 99
      return { project, score }
    }).filter(item => item.score < 99).sort((a,b) => a.score - b.score || projectName(a.project).localeCompare(projectName(b.project))).slice(0,8).map(item => item.project)
  }, [filtered, searchTerm])
  const allProjectMatches = useMemo(() => { const term = normalizeText(searchTerm); return term ? uniqueProjects.filter(project => normalizeText(projectSearchText(project)).includes(term)).slice(0,8) : [] }, [uniqueProjects, searchTerm])
  const uniqueProjectsById = useMemo(() => new globalThis.Map(uniqueProjects.map(project => [project.projectKey, project])), [uniqueProjects])
  const selected = uniqueProjectsById.get(selectedProjectId) || null
  const summarizedLocationValue = (getter, prompt = 'Varias ubicaciones') => {
    if (selectedLocation) return getter(selectedLocation)
    const values = [...new Set((selected?.locations || []).map(location => getter(location.feature)).filter(value => value !== null && value !== undefined && String(value).trim()))]
    return values.length === 1 ? values[0] : selected?.locationCount > 1 ? prompt : values[0]
  }
  const selectedProvince = summarizedLocationValue(getLocationProvince)
  const selectedDistrict = summarizedLocationValue(getLocationDistrict)
  const selectedCommunity = summarizedLocationValue(getLocationCommunity, 'Seleccione un punto del mapa')
  const selectedCoordinates = getLocationCoordinates(selectedLocation)
  const printPhoto = selected ? getProjectImages(selected)[0] || '' : ''
  const isProjectPanelOpen = Boolean(selected)
  useEffect(() => {
    if (selectedProjectId === null) return
    if (!filtered.some(project => project.projectKey === selectedProjectId)) { setSelectedProjectId(null); setSelectedLocation(null); return }
    if (selectedLocation && !filteredLocations.some(project => project.feature.properties.__location_key === selectedLocation.properties?.__location_key)) setSelectedLocation(null)
  }, [filtered, filteredLocations, selectedLocation, selectedProjectId])
  useEffect(() => { setActivePhoto(selected?.photos?.[0] || ''); setPrintPhotoFailed(false) }, [selectedProjectId, selected])
  useEffect(() => {
    selectedResultRef.current?.scrollIntoView({ behavior:'smooth', block:'nearest' })
  }, [selectedProjectId])
  useEffect(() => {
    console.info('Proyecto seleccionado:', selectedProjectId)
    console.info('Ubicación seleccionada:', { provincia:selectedProvince, distrito:selectedDistrict, comunidad:selectedCommunity, coordinates:selectedCoordinates })
  }, [selectedProjectId, selectedLocation])
  useEffect(() => {
    const close = event => { if (!searchRef.current?.contains(event.target)) { setIsSearchOpen(false); setActiveSearchIndex(-1) } }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])
  const totalBudget = filtered.reduce((a,p) => a + (Number(p.budget) || 0), 0)
  const totalBenefits = filtered.reduce((a,p) => a + (Number(p.beneficiaries) || 0), 0)
  const chartData = values('chain').map(chain => ({ name: chain.slice(0, 5), proyectos: filtered.filter(p => p.chain === chain).length }))
  const clearFilters = () => { setFilters({ province: '', district: '', chain: '', status: '', year: '' }); setSelectedProjectId(null); setSelectedLocation(null) }
  const selectProject = (projectId, location = null) => {
    if (projectId === null || projectId === undefined || projectId === '') { if(import.meta.env.DEV) console.warn('No se puede seleccionar un proyecto sin ID'); return }
    setSelectedProjectId(String(projectId))
    setSelectedLocation(location)
  }
  const closeProject = () => { setSelectedProjectId(null); setSelectedLocation(null) }
  const selectProjectFromSearch = project => {
    if (getProjectId(project) === null || getProjectId(project) === undefined || getProjectId(project) === '') { console.warn('El resultado de búsqueda no tiene identificador:', project); return }
    setFilters(current => ({
      province: !current.province || current.province === project.province ? current.province : '', district: !current.district || current.district === project.district ? current.district : '',
      chain: !current.chain || current.chain === project.chain ? current.chain : '', status: !current.status || current.status === project.status ? current.status : '', year: !current.year || String(current.year) === String(project.year) ? current.year : '',
    }))
    selectProject(project.projectKey); setSearchTerm(projectName(project)); setIsSearchOpen(false); setActiveSearchIndex(-1)
  }
  const downloadProjectSheet = () => {
    if (!selected) return
    const previousTitle=document.title
    const code=sanitizePrintTitle(safeValue(getProjectCode(selected)))
    const name=sanitizePrintTitle(safeValue(getProjectName(selected)))
    document.title=`Ficha - ${code} - ${name}`
    const restore=()=>{document.title=previousTitle;window.removeEventListener('afterprint',restore)}
    // Chrome añade sus propios encabezados y pies; deben desactivarse en el diálogo de impresión para obtener una ficha limpia.
    window.addEventListener('afterprint',restore,{once:true}); window.print(); window.setTimeout(restore,1500)
  }
  const handleSearchKeyDown = event => {
    if (event.key === 'Escape') { setIsSearchOpen(false); setActiveSearchIndex(-1); return }
    if (!rankSearchResults.length) return
    if (event.key === 'ArrowDown') { event.preventDefault(); setIsSearchOpen(true); setActiveSearchIndex(index => Math.min(index + 1, rankSearchResults.length - 1)) }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActiveSearchIndex(index => Math.max(index - 1, 0)) }
    if (event.key === 'Enter' && activeSearchIndex >= 0) { event.preventDefault(); selectProjectFromSearch(rankSearchResults[activeSearchIndex]) }
  }

  if (currentView === 'login') return <AdminLogin onCancel={()=>setCurrentView('viewer')} onSuccess={user=>{setAdminUser(user);setCurrentView('admin')}}/>
  if (currentView === 'admin' && adminUser) return <ProjectManagement adminUser={adminUser} isReturning={isRefreshingProjects} onLogout={()=>{clearAdminSession();setAdminUser(null);setCurrentView('viewer')}} onBack={async changed => {
    if (isRefreshingProjects) return
    if (changed) {
      console.info('Refrescando proyectos desde administración')
      setIsRefreshingProjects(true)
      try { await loadProjects() } finally { setIsRefreshingProjects(false) }
    }
    setCurrentView('viewer')
  }}/>

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><img src={LOGO_URL} /><div><strong>DRA Ayacucho</strong><span>Visor de Proyectos</span></div></div>
      <div className="header-search search-container" ref={searchRef} role="combobox" aria-expanded={isSearchOpen} aria-controls="project-search-results" aria-autocomplete="list"><Search size={18}/><input value={searchTerm} onFocus={() => searchTerm && setIsSearchOpen(true)} onKeyDown={handleSearchKeyDown} onChange={e => { setSearchTerm(e.target.value); setIsSearchOpen(Boolean(e.target.value)); setActiveSearchIndex(-1) }} placeholder="Buscar por nombre, CUI o ubicación..."/>{searchTerm && <button className="search-clear" aria-label="Limpiar búsqueda" onClick={() => { setSearchTerm(''); setIsSearchOpen(false); setActiveSearchIndex(-1) }}><X size={15}/></button>}{isSearchOpen && <div id="project-search-results" className="search-results" role="listbox"><small>Resultados dentro de los filtros actuales</small>{rankSearchResults.map((project,index) => <button className={`search-result-item ${index === activeSearchIndex ? 'active' : ''}`} key={project.id} role="option" aria-selected={index === activeSearchIndex} onMouseDown={event => event.preventDefault()} onClick={() => selectProjectFromSearch(project)}><b>{safeValue(projectName(project))}</b><span>PROY-{String(projectCode(project)).padStart(4,'0')} · {safeValue(projectDistrict(project))}, {safeValue(projectProvince(project))}</span><em>{safeValue(projectChain(project))} · {safeValue(projectStatus(project))}</em></button>)}{!rankSearchResults.length && <div className="search-empty">Sin resultados en los filtros actuales{allProjectMatches.length > 0 && <button onClick={() => selectProjectFromSearch(allProjectMatches[0])}>Buscar en todos los proyectos</button>}</div>}</div>}</div>
      <div className="header-actions"><span className="update"><i/>Datos actualizados <b>Jul 2026</b></span><button className="icon-btn"><Info size={19}/></button><button className="menu-btn" aria-label="Alternar filtros" aria-controls="filters-panel" aria-expanded={isFiltersOpen} onClick={() => setIsFiltersOpen(current => !current)}><Menu/></button><button className="user" onClick={() => setCurrentView(adminUser?'admin':'login')} aria-label="Abrir Gestión de Proyectos"><span>GP</span><div><b>Gestión de Proyectos</b><small>{adminUser?.full_name||'Administrador'}</small></div></button></div>
    </header>

    <main className={`workspace ${isProjectPanelOpen ? 'sheet-open' : ''} ${basemapOpen ? 'basemap-open' : ''}`}>
      <MapCanvas projects={filteredLocations} selectedId={selectedProjectId} selectedLocationKey={selectedLocation?.properties?.__location_key || null} selectedProvince={filters.province} selectedDistrict={filters.district} filtersOpen={isFiltersOpen} projectPanelOpen={isProjectPanelOpen} baseMap={baseMap} mapAction={mapAction} onSelect={selectProject} onSelectProvince={changeProvince} onSelectDistrict={(province, district) => changeDistrict(district, province)} />
      {projectsError && <div role="alert" style={{position:'absolute',left:'50%',top:16,zIndex:1100,transform:'translateX(-50%)',padding:'10px 14px',borderRadius:12,background:'rgba(255,255,255,.96)',color:'#8b2e2e',boxShadow:'0 8px 24px rgba(32,49,42,.16)',fontSize:11}}>{projectsError}</div>}

      {isFiltersOpen && <div className="filters-backdrop" onClick={() => setIsFiltersOpen(false)} aria-hidden="true"/>}
      <aside id="filters-panel" className={`left-panel panel filters-panel ${isFiltersOpen ? 'is-open' : 'is-closed'}`}>
        <div className="panel-heading"><div><span className="eyebrow">Explorar territorio</span><h2><SlidersHorizontal size={19}/> Filtros de proyectos</h2></div><button aria-label={isFiltersOpen ? 'Cerrar filtros' : 'Abrir filtros'} aria-controls="filters-panel" aria-expanded={isFiltersOpen} onClick={() => setIsFiltersOpen(current => !current)}><ChevronLeft/></button></div>
        <div className="filter-body">
          <SelectFilter label="Provincia" value={filters.province} onChange={changeProvince} options={values('province')}/>
          <SelectFilter label="Distrito" value={filters.district} onChange={changeDistrict} options={districtOptions}/>
          <SelectFilter label="Cadena productiva" value={filters.chain} onChange={v => setFilters({...filters, chain:v})} options={values('chain')}/>
          <div className="filter-row"><SelectFilter label="Estado" value={filters.status} onChange={v => setFilters({...filters, status:v})} options={values('status')}/><SelectFilter label="Año" value={filters.year} onChange={v => setFilters({...filters, year:v})} options={values('year')}/></div>
          <div className="filter-result"><span><b>{filtered.length}</b> proyectos encontrados</span><button onClick={clearFilters}>Limpiar filtros</button></div>
          <div className="mini-list">
            {filtered.map(p => { const isSelected=String(selectedProjectId)===String(p.id); return <button ref={isSelected?selectedResultRef:null} key={p.id} onClick={() => {selectProject(p.id); if (window.innerWidth < 768) setIsFiltersOpen(false)}} className={isSelected?'selected':''}><span className={`status-dot ${p.status === 'Finalizado' ? 'done':''}`}/><div><b>{p.name}</b><small><MapPin size={12}/>{p.district} · {p.province}</small></div><ChevronRight size={16}/></button> })}
          </div>
        </div>
      </aside>
      {!isFiltersOpen && <button className="panel-reopen left filters-reopen-tab" aria-label="Abrir filtros" aria-controls="filters-panel" aria-expanded={isFiltersOpen} onClick={() => setIsFiltersOpen(true)}><SlidersHorizontal size={18}/><span>Filtros</span></button>}

      <section className="kpis kpi-row wide">
        {[
          [FolderKanban,'Total proyectos',filtered.length,'+12% este año','emerald'],
          [Activity,'Proyectos activos',filtered.filter(p=>p.status==='En ejecución').length,'En ejecución','green'],
          [Users,'Beneficiarios',totalBenefits.toLocaleString('es-PE'),'+8.4% vs. 2025','blue'],
          [Landmark,'Inversión',money(totalBudget),'Presupuesto total','amber']
        ].map(([Icon,label,value,meta,color]) => <article className="kpi" key={label}><span className={`kpi-icon ${color}`}><Icon/></span><div><small>{label}</small><strong>{value}</strong><em>{meta}</em></div></article>)}
      </section>

      <div className="map-tools"><button aria-label="Acercar" onClick={() => runMapAction('zoomIn')}><ZoomIn/></button><button aria-label="Alejar" onClick={() => runMapAction('zoomOut')}><ZoomOut/></button><button aria-label="Centrar en Ayacucho" onClick={() => runMapAction('locate')}><LocateFixed/></button></div>
      <div className="layer-tools"><button onClick={() => setBasemapOpen(!basemapOpen)}><Layers3/><span>Mapas base</span></button>{basemapOpen && <div className="basemap-pop"><b>Mapa base</b><label><input type="radio" checked={baseMap === 'claro'} onChange={() => setBaseMap('claro')} name="base"/> CARTO claro</label><label><input type="radio" checked={baseMap === 'satelite'} onChange={() => setBaseMap('satelite')} name="base"/> Satélite</label><label><input type="radio" checked={baseMap === 'osm'} onChange={() => setBaseMap('osm')} name="base"/> OpenStreetMap</label></div>}</div>
      <div className="legend"><div><b>Leyenda</b><button><ChevronLeft size={14}/></button></div><span><i className="dot active"/>En ejecución</span><span><i className="dot planned"/>Planificado</span><span><i className="dot finished"/>Finalizado</span><small><i className="cluster"/> Agrupación de proyectos</small></div>

      {selected && <><div className="project-panel-backdrop" onClick={closeProject} aria-hidden="true"/><aside id="project-sheet" role="dialog" aria-modal={window.innerWidth < 1024} aria-labelledby="project-panel-title" className="right-panel panel project-panel is-open">
        <div className="detail-top project-panel__header"><span className="project-code">{selected.code === selected.id ? `PROY-${String(selected.id).padStart(4,'0')}` : safeValue(selected.code)}</span><div><button type="button" aria-label="Compartir proyecto"><Share2 size={17}/></button><button type="button" aria-label="Cerrar ficha" aria-controls="project-sheet" aria-expanded={isProjectPanelOpen} onClick={closeProject}><X/></button></div></div>
        <div className="detail-scroll">
          <span className={`state-pill ${selected.status === 'Finalizado' ? 'finished' : selected.status === 'Planificado' ? 'planned' : selected.status === 'En ejecución' ? '' : 'neutral'}`}><i/>{safeValue(selected.status)}</span>
          <h1 id="project-panel-title">{safeValue(selected.name)}</h1>
          <p className="location"><MapPin size={16}/>{safeValue(selectedDistrict)}, {safeValue(selectedProvince)}</p>
          {selected.locationCount > 1 && <p className="location"><MapPin size={16}/>Ubicaciones registradas: {selected.locationCount}</p>}
          <div className={`hero-photo ${activePhoto ? '' : 'no-photo'}`}>{activePhoto ? <img src={activePhoto} alt={`Fotografía de ${selected.name}`} onError={() => setActivePhoto('')}/> : <strong><ImageIcon/>Sin fotografías disponibles</strong>}<span><ImageIcon size={15}/>{selected.photos?.length || 0} fotos</span></div>
          <div className="thumbs">{selected.photos?.map((photo,i)=><button className={photo === activePhoto ? 'active' : ''} aria-label={`Ver fotografía ${i + 1}`} onClick={() => setActivePhoto(photo)} key={photo}><img src={photo} onError={event => { event.currentTarget.style.visibility = 'hidden' }} /></button>)}</div>
          <section className="detail-section"><h3>Avance del proyecto <b>{selected.execution === null ? 'No disponible' : `${selected.execution}%`}</b></h3><div className="progress"><i style={{width:`${selected.execution ?? 0}%`}}/></div>{selected.execution !== null && <div className="milestones"><span><CheckCircle2/>Inicio</span><span><CheckCircle2/>Ejecución</span><span className={selected.execution<100?'muted':''}><CheckCircle2/>Cierre</span></div>}</section>
          <section className="detail-section"><h3>Información de la ubicación seleccionada</h3><div className="info-grid"><span><Building2/>Provincia<b>{safeValue(selectedProvince)}</b></span><span><MapPin/>Distrito<b>{safeValue(selectedDistrict)}</b></span><span><MapPin/>Comunidad<b>{safeValue(selectedCommunity)}</b></span><span><MapPin/>Coordenadas<b>{selectedCoordinates ? `${Number(selectedCoordinates[1]).toFixed(6)}, ${Number(selectedCoordinates[0]).toFixed(6)}` : 'Seleccione un punto del mapa'}</b></span></div></section>
          <section className="detail-section"><h3>Información general</h3><div className="info-grid"><span><Sprout/>Cadena productiva<b>{safeValue(selected.chain)}</b></span><span><CalendarDays/>Año de inicio<b>{safeValue(selected.year)}</b></span></div></section>
          <section className="numbers"><div><small>Inversión</small><b>{formatCurrencyPEN(selected.budget)}</b></div><div><small>Beneficiarios</small><b>{Number.isFinite(Number(selected.beneficiaries)) ? Number(selected.beneficiaries).toLocaleString('es-PE') : 'No disponible'}</b></div></section>
          <section className="detail-section"><h3>Descripción</h3><p>{selected.description || 'No se registró una descripción para este proyecto.'}</p></section>
          {chartData.length > 0 && <section className="detail-section chart"><h3><BarChart3/> Proyectos por cadena</h3><ResponsiveContainer width="100%" height={120}><BarChart data={chartData}><XAxis dataKey="name" axisLine={false} tickLine={false} fontSize={10}/><Tooltip/><Bar dataKey="proyectos" fill="#1c7c54" radius={[5,5,0,0]}/></BarChart></ResponsiveContainer></section>}
        </div>
        <div className="detail-actions"><Button variant="outline" disabled={!selected} onClick={downloadProjectSheet}><Download/>Descargar ficha</Button><Button className="primary" onClick={() => { if(window.innerWidth<768)setIsFiltersOpen(false); runMapAction('selected') }}><Map/>Ver en mapa</Button></div>
      </aside>
      <section className="project-print-sheet" aria-label="Ficha técnica imprimible del proyecto">
        <header className="print-sheet-header">
          <img src={LOGO_URL} alt="Logo de la Dirección Regional Agraria Ayacucho"/>
          <div className="print-institution"><strong>DIRECCIÓN REGIONAL DE AGRICULTURA AYACUCHO</strong><span>Visor de Proyectos</span></div>
          <div className="print-document-title"><h1>FICHA TÉCNICA DE PROYECTO</h1><p><b>Código:</b> {selected.code === selected.id ? `PROY-${String(selected.id).padStart(4,'0')}` : safeValue(selected.code)}</p><p><b>Generada:</b> {new Intl.DateTimeFormat('es-PE',{dateStyle:'long',timeStyle:'short'}).format(new Date())}</p></div>
        </header>
        <div className="print-green-line"/>
        <section className="print-project-heading">
          <span className={`print-status ${normalizeText(selected.status).replace(/\s+/g,'-')}`}>{safeValue(selected.status)}</span>
          <h2>{safeValue(selected.name)}</h2>
          <p>{safeValue(selected.district)} — {safeValue(selected.province)}</p>
        </section>
        <div className="print-photo-frame">
          {printPhoto && !printPhotoFailed ? <img className="project-print-photo" src={printPhoto} alt={`Fotografía principal de ${getProjectName(selected)}`} onError={() => setPrintPhotoFailed(true)}/> : <div className="print-photo-placeholder"><ImageIcon/><span>Sin fotografía disponible</span></div>}
        </div>
        <section className="print-section"><h3>INFORMACIÓN GENERAL</h3><dl className="print-info-grid">
          <div><dt>Provincia</dt><dd>{safeValue(selected.province)}</dd></div><div><dt>Distrito</dt><dd>{safeValue(selected.district)}</dd></div>
          <div><dt>Comunidad</dt><dd>{safeValue(selected.community)}</dd></div><div><dt>Año de inicio</dt><dd>{safeValue(selected.year)}</dd></div>
          <div><dt>Estado</dt><dd>{safeValue(selected.status)}</dd></div><div><dt>Cadena productiva</dt><dd>{safeValue(selected.chain)}</dd></div>
        </dl></section>
        <section className="print-indicators">
          <div><span>INVERSIÓN</span><strong>{formatCurrencyPEN(getProjectInvestment(selected),2)}</strong></div>
          <div><span>BENEFICIARIOS</span><strong>{Number.isFinite(Number(selected.beneficiaries)) ? Number(selected.beneficiaries).toLocaleString('es-PE') : 'No disponible'}</strong></div>
          <div><span>AVANCE</span><strong>{selected.execution === null ? 'No disponible' : `${selected.execution}%`}</strong></div>
        </section>
        <section className="print-section print-description"><h3>DESCRIPCIÓN DEL PROYECTO</h3><p>{selected.description || 'No se registró una descripción para este proyecto.'}</p></section>
        <section className="print-section print-location"><h3>UBICACIÓN DEL PROYECTO</h3><p><b>Provincia:</b> {safeValue(selected.province)} &nbsp;·&nbsp; <b>Distrito:</b> {safeValue(selected.district)} &nbsp;·&nbsp; <b>Comunidad:</b> {safeValue(selected.community)}</p>{selected.coordinates?.length >= 2 && Number.isFinite(Number(selected.coordinates[0])) && Number.isFinite(Number(selected.coordinates[1])) && <p><b>Longitud:</b> {Number(selected.coordinates[0]).toFixed(6)} &nbsp;·&nbsp; <b>Latitud:</b> {Number(selected.coordinates[1]).toFixed(6)}</p>}</section>
        <footer className="print-sheet-footer"><span><b>Fuente:</b> Dirección Regional de Agricultura Ayacucho · Visor de Proyectos</span><span>Generada: {new Intl.DateTimeFormat('es-PE',{dateStyle:'short',timeStyle:'short'}).format(new Date())}<br/>Documento generado automáticamente por el Visor de Proyectos DRAA.</span><span>Página 1</span></footer>
      </section></>}
      <div className="map-footer"><span>© OpenStreetMap</span><b>Escala 1:250,000</b><span>-74.212, -13.163</span></div>
    </main>
  </div>
}

export default App
