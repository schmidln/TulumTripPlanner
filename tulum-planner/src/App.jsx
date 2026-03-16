import { useState, useEffect, useRef, useCallback } from "react";
import { db } from "./firebase.js";
import { doc, setDoc, onSnapshot, deleteDoc, collection, addDoc, serverTimestamp } from "firebase/firestore";

/* ════════════════════ CONSTANTS ════════════════════ */
const TULUM = { lat: 20.2114, lng: -87.4654 };
const CUN = { lat: 21.0365, lng: -86.8771, name: "CUN — Cancún Intl" };
const COLORS = ["#c45d3e","#2a8f82","#c49a3e","#5b6abf","#b84a7d","#3a9e5c","#9b5fc7","#c47a2e","#3a8ab5","#8b8b3a"];
const TRANSPORT = [
  { v:"walk",icon:"🚶",l:"Walk",p:"foot"},
  { v:"bike",icon:"🚲",l:"Bike",p:"bike"},
  { v:"rental",icon:"🚗",l:"Rental Car",p:"car"},
  { v:"taxi",icon:"🚕",l:"Taxi",p:"car"},
  { v:"scooter",icon:"🛵",l:"Scooter",p:"car"},
  { v:"colectivo",icon:"🚐",l:"Colectivo",p:"car"},
];
const TYPES = [
  { v:"beach",icon:"🏖️",l:"Beach"},{ v:"cenote",icon:"💧",l:"Cenote"},{ v:"ruins",icon:"🏛️",l:"Ruins"},
  { v:"restaurant",icon:"🍽️",l:"Restaurant"},{ v:"bar",icon:"🍹",l:"Bar"},{ v:"activity",icon:"🤿",l:"Activity"},
  { v:"wellness",icon:"🧘",l:"Wellness"},{ v:"shopping",icon:"🛍️",l:"Shopping"},{ v:"other",icon:"📍",l:"Other"},
];
const tI=v=>TRANSPORT.find(t=>t.v===v)?.icon||"🚶";
const tL=v=>TRANSPORT.find(t=>t.v===v)?.l||v;
const tP=v=>TRANSPORT.find(t=>t.v===v)?.p||"car";
const sI=v=>TYPES.find(t=>t.v===v)?.icon||"📍";
let _i=0;const uid=()=>`${Date.now()}-${++_i}`;
const fmt=t=>{if(!t)return"";const[h,m]=t.split(":");const hr=+h;return`${hr%12||12}:${m} ${hr>=12?"PM":"AM"}`;};
const fmtD=d=>d?new Date(d+"T12:00:00").toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"}):"";

const BLANK_TRIP=name=>({name:name||"Tulum Trip",arrivalFlights:[],departureFlights:[],homebase:null,days:[],createdAt:Date.now()});

/* ════════════════════ GEOCODE ════════════════════ */
const geocode=async addr=>{
  try{const r=await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(addr)}&format=json&limit=1`);const d=await r.json();if(d.length)return{lat:+parseFloat(d[0].lat).toFixed(5),lng:+parseFloat(d[0].lon).toFixed(5)};}catch{}return null;
};

/* ════════════════════ OSRM TRAVEL TIME ════════════════════ */
const calcTravel=async(from,to,transport)=>{
  if(!from?.lat||!to?.lat)return null;
  const pr=tP(transport)==="car"?"driving":tP(transport)==="bike"?"cycling":"walking";
  try{
    const r=await fetch(`https://router.project-osrm.org/route/v1/${pr}/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`);
    const d=await r.json();
    if(d.routes?.length){
      let s=d.routes[0].duration,m=d.routes[0].distance;
      if(transport==="scooter")s*=1.3;if(transport==="colectivo")s*=1.5;
      const mins=Math.round(s/60);const km=(m/1000).toFixed(1);
      return mins<60?`${mins} min (${km} km)`:`${Math.floor(mins/60)}h ${mins%60}m (${km} km)`;
    }
  }catch{}return null;
};

/* ════════════════════ FLIGHT LOOKUP ════════════════════ */
const lookupFlight=async(airline,flightNo,date)=>{
  // Try serverless first
  try{const r=await fetch("/api/flight-lookup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({airline,flightNo,date})});if(r.ok){const d=await r.json();if(!d.error)return d;}}catch{}
  // Fallback direct
  const ds=date?new Date(date+"T12:00:00").toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"}):"";
  try{
    const r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:1000,tools:[{type:"web_search_20250305",name:"web_search"}],messages:[{role:"user",content:`Look up ${airline} flight ${flightNo}${ds?` on ${ds}`:""}.
Search for "${airline} flight ${flightNo} route schedule".
RULES: Only return VERIFIED data. Airline MUST be "${airline}". Flight number MUST be "${flightNo}". If not found return {"error":"not found"}.
Return ONLY JSON: {"airline":"${airline}","flightNumber":"${flightNo}","departureAirport":"IATA","departureCity":"...","departureTime":"HH:MM","arrivalAirport":"IATA","arrivalCity":"...","arrivalTime":"HH:MM","departureCoords":{"lat":0,"lng":0},"arrivalCoords":{"lat":0,"lng":0}}`}]})});
    const data=await r.json();const text=data.content?.map(c=>c.text||"").join("")||"";
    const match=text.replace(/```json|```/g,"").match(/\{[\s\S]*\}/);
    if(match){const p=JSON.parse(match[0]);if(!p.error)return p;}
  }catch(e){console.error("Flight lookup:",e);}return null;
};

/* ════════════════════ HASH ROUTER ════════════════════ */
function useHash(){
  const[hash,setHash]=useState(window.location.hash);
  useEffect(()=>{const h=()=>setHash(window.location.hash);window.addEventListener("hashchange",h);return()=>window.removeEventListener("hashchange",h);},[]);
  return hash;
}

/* ════════════════════ LEAFLET MAP ════════════════════ */
function LeafletMap({trip,activeDay,onClickLatLng}){
  const divRef=useRef(null);const mapRef=useRef(null);const lgRef=useRef(null);const[L,setL]=useState(null);
  useEffect(()=>{
    if(window.L){setL(window.L);return;}
    const css=document.createElement("link");css.rel="stylesheet";css.href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";document.head.appendChild(css);
    const js=document.createElement("script");js.src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";js.onload=()=>setL(window.L);document.head.appendChild(js);
  },[]);
  useEffect(()=>{
    if(!L||!divRef.current||mapRef.current)return;
    const map=L.map(divRef.current,{zoomControl:false}).setView([TULUM.lat,TULUM.lng],12);
    L.control.zoom({position:"bottomright"}).addTo(map);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",{maxZoom:19}).addTo(map);
    map.on("click",e=>onClickLatLng?.({lat:+e.latlng.lat.toFixed(5),lng:+e.latlng.lng.toFixed(5)}));
    mapRef.current=map;lgRef.current=L.layerGroup().addTo(map);
    return()=>{map.remove();mapRef.current=null;};
  },[L]);
  useEffect(()=>{if(!mapRef.current)return;mapRef.current.off("click");mapRef.current.on("click",e=>onClickLatLng?.({lat:+e.latlng.lat.toFixed(5),lng:+e.latlng.lng.toFixed(5)}));},[onClickLatLng]);
  useEffect(()=>{
    if(!L||!lgRef.current)return;const lg=lgRef.current;lg.clearLayers();const bounds=[];
    const pin=(lat,lng,html,popup,sz=28)=>{const m=L.marker([lat,lng],{icon:L.divIcon({className:"",html,iconSize:[sz,sz],iconAnchor:[sz/2,sz/2]})}).bindPopup(popup);lg.addLayer(m);bounds.push([lat,lng]);};
    pin(TULUM.lat,TULUM.lng,`<div style="background:#2a8f82;color:#fff;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.2)">Tulum</div>`,"<b>Tulum Centro</b>",50);
    pin(CUN.lat,CUN.lng,`<div style="font-size:22px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.3))">✈️</div>`,`<b>${CUN.name}</b>`);
    [...(trip.arrivalFlights||[]),...(trip.departureFlights||[])].forEach(f=>{
      if(f.depCoords?.lat)pin(f.depCoords.lat,f.depCoords.lng,`<div style="font-size:18px">🛫</div>`,`<b>${f.depAirport||""} ${f.depCity||""}</b>`,24);
      if(f.arrCoords?.lat)pin(f.arrCoords.lat,f.arrCoords.lng,`<div style="font-size:18px">🛬</div>`,`<b>${f.arrAirport||""} ${f.arrCity||""}</b>`,24);
    });
    if(trip.homebase?.lat)pin(trip.homebase.lat,trip.homebase.lng,`<div style="font-size:22px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.3))">🏠</div>`,`<b>${trip.homebase?.name||"Homebase"}</b><br/>${trip.homebase?.address||""}`);
    const dis=activeDay!==null?[activeDay]:(trip.days||[]).map((_,i)=>i);
    dis.forEach(di=>{
      const day=(trip.days||[])[di];if(!day)return;const color=COLORS[di%COLORS.length];const coords=[];
      (day.stops||[]).forEach((s,si)=>{
        if(!s.lat)return;coords.push([s.lat,s.lng]);
        pin(s.lat,s.lng,`<div style="width:26px;height:26px;border-radius:50%;background:${color};color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;border:2.5px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.25)">${si+1}</div>`,`<div style="font-family:system-ui;font-size:13px"><b>${si+1}. ${s.name||""}</b><br/>${sI(s.type)} ${TYPES.find(t=>t.v===s.type)?.l||""}${s.transport?`<br/>${tI(s.transport)} ${tL(s.transport)}`:""}${s.travelTime?`<br/>⏱ ${s.travelTime}`:""}</div>`,26);
      });
      if(coords.length>1){lg.addLayer(L.polyline(coords,{color,weight:3,opacity:.5,dashArray:"8 6"}));}
    });
    if(bounds.length>1&&mapRef.current)mapRef.current.fitBounds(bounds,{padding:[50,50],maxZoom:14});
  },[L,trip,activeDay]);
  return <div ref={divRef} style={{width:"100%",height:"100%",minHeight:400}}/>;
}

/* ════════════════════ SMALL COMPONENTS ════════════════════ */
function AddrInput({value,onChange,onGeocode,placeholder}){
  const[busy,setBusy]=useState(false);
  const go=async()=>{if(!value)return;setBusy(true);const r=await geocode(value);setBusy(false);if(r)onGeocode(r);};
  return(<div style={{display:"flex",gap:6}}><input style={{...S.inp,flex:1}} placeholder={placeholder||"Address"} value={value} onChange={e=>onChange(e.target.value)} onBlur={go} onKeyDown={e=>e.key==="Enter"&&go()}/><button style={{...S.btnFlat,padding:"6px 10px",opacity:busy?.5:1}} onClick={go} disabled={busy}>{busy?"…":"📍"}</button></div>);
}

function FlightForm({initial,onSave,onCancel}){
  const[f,setF]=useState(initial||{airline:"",flight:"",date:"",time:"",airport:"",depCity:"",depAirport:"",arrCity:"",arrAirport:"",depCoords:null,arrCoords:null});
  const[busy,setBusy]=useState(false);const[err,setErr]=useState("");const s=(k,v)=>setF(p=>({...p,[k]:v}));
  const doLookup=async()=>{
    if(!f.flight){setErr("Enter flight number");return;}if(!f.airline){setErr("Enter airline name");return;}
    setBusy(true);setErr("");const r=await lookupFlight(f.airline,f.flight,f.date);setBusy(false);
    if(r)setF(p=>({...p,airline:r.airline||p.airline,time:r.departureTime||p.time,depCity:r.departureCity||"",depAirport:r.departureAirport||"",arrCity:r.arrivalCity||"",arrAirport:r.arrivalAirport||"",airport:`${r.departureAirport||""} → ${r.arrivalAirport||""}`,depCoords:r.departureCoords||null,arrCoords:r.arrivalCoords||null}));
    else setErr("Couldn't find flight — fill in manually");
  };
  return(<div style={S.formCard}>
    <div style={S.formRow}><input style={S.inp} placeholder="Airline (e.g. JetBlue)" value={f.airline} onChange={e=>s("airline",e.target.value)}/><input style={{...S.inp,maxWidth:120}} placeholder="Flight #" value={f.flight} onChange={e=>s("flight",e.target.value)}/></div>
    <div style={S.formRow}><input style={S.inp} type="date" value={f.date} onChange={e=>s("date",e.target.value)}/><button style={{...S.btnFill,opacity:busy?.5:1,whiteSpace:"nowrap"}} onClick={doLookup} disabled={busy}>{busy?"Looking up…":"🔍 Lookup"}</button></div>
    {err&&<div style={S.errBox}>{err}</div>}
    {f.depCity&&<div style={S.okBox}><b>{f.airline} {f.flight}</b> · {f.depAirport} ({f.depCity}) → {f.arrAirport} ({f.arrCity}){f.time&&` · ${fmt(f.time)}`}</div>}
    <div style={S.divLabel}>Manual override</div>
    <div style={S.formRow}><input style={{...S.inp,maxWidth:130}} type="time" value={f.time} onChange={e=>s("time",e.target.value)}/><input style={S.inp} placeholder="Route (e.g. BOS → CUN)" value={f.airport} onChange={e=>s("airport",e.target.value)}/></div>
    <div style={S.formActions}><button style={S.btnFill} onClick={()=>onSave({...f,id:f.id||uid()})}>Save Flight</button><button style={S.btnFlat} onClick={onCancel}>Cancel</button></div>
  </div>);
}

function HomebaseForm({initial,onSave,onCancel,coordHint}){
  const[h,setH]=useState(initial||{name:"",address:"",checkInDate:"",checkInTime:"",checkOutDate:"",checkOutTime:"",notes:"",lat:null,lng:null});
  const s=(k,v)=>setH(p=>({...p,[k]:v}));
  useEffect(()=>{if(coordHint?.lat)setH(p=>({...p,lat:coordHint.lat,lng:coordHint.lng}));},[coordHint]);
  return(<div style={S.formCard}>
    <input style={S.inp} placeholder="Name (Airbnb, Hotel…)" value={h.name} onChange={e=>s("name",e.target.value)}/>
    <AddrInput value={h.address} onChange={v=>s("address",v)} onGeocode={c=>setH(p=>({...p,lat:c.lat,lng:c.lng}))} placeholder="Full address (auto-geocodes)"/>
    {h.lat&&<div style={S.coordBadge}>📍 {h.lat}, {h.lng}</div>}
    <div style={S.divLabel}>Check-in</div>
    <div style={S.formRow}><input style={S.inp} type="date" value={h.checkInDate} onChange={e=>s("checkInDate",e.target.value)}/><input style={{...S.inp,maxWidth:130}} type="time" value={h.checkInTime} onChange={e=>s("checkInTime",e.target.value)}/></div>
    <div style={S.divLabel}>Check-out</div>
    <div style={S.formRow}><input style={S.inp} type="date" value={h.checkOutDate} onChange={e=>s("checkOutDate",e.target.value)}/><input style={{...S.inp,maxWidth:130}} type="time" value={h.checkOutTime} onChange={e=>s("checkOutTime",e.target.value)}/></div>
    <textarea style={{...S.inp,minHeight:42}} placeholder="Notes (wifi, host…)" value={h.notes} onChange={e=>s("notes",e.target.value)}/>
    <div style={S.formActions}><button style={S.btnFill} onClick={()=>onSave(h)}>Save</button><button style={S.btnFlat} onClick={onCancel}>Cancel</button></div>
  </div>);
}

function StopForm({initial,onSave,onCancel,coordHint,prevStop,homebase}){
  const[s,setS]=useState(initial||{name:"",address:"",type:"other",transport:"taxi",travelTime:"",arriveTime:"",departTime:"",notes:"",lat:null,lng:null});
  const[calcing,setCalcing]=useState(false);const u=(k,v)=>setS(p=>({...p,[k]:v}));
  useEffect(()=>{if(coordHint?.lat)setS(p=>({...p,lat:coordHint.lat,lng:coordHint.lng}));},[coordHint]);
  const autoCalc=useCallback(async stop=>{
    const from=prevStop?.lat?prevStop:homebase?.lat?homebase:null;if(!from||!stop.lat)return;
    setCalcing(true);const r=await calcTravel(from,stop,stop.transport);setCalcing(false);if(r)setS(p=>({...p,travelTime:r}));
  },[prevStop,homebase]);
  useEffect(()=>{if(s.lat&&s.transport)autoCalc(s);},[s.lat,s.lng,s.transport]);
  return(<div style={S.formCard}>
    <input style={S.inp} placeholder="Stop name" value={s.name} onChange={e=>u("name",e.target.value)}/>
    <AddrInput value={s.address||""} onChange={v=>u("address",v)} onGeocode={c=>setS(p=>({...p,lat:c.lat,lng:c.lng}))} placeholder="Address (auto-geocodes + calc travel)"/>
    {s.lat&&<div style={S.coordBadge}>📍 {s.lat}, {s.lng}</div>}
    <div style={S.formRow}>
      <select style={S.inp} value={s.type} onChange={e=>u("type",e.target.value)}>{TYPES.map(t=><option key={t.v} value={t.v}>{t.icon} {t.l}</option>)}</select>
      <select style={S.inp} value={s.transport} onChange={e=>u("transport",e.target.value)}>{TRANSPORT.map(t=><option key={t.v} value={t.v}>{t.icon} {t.l}</option>)}</select>
    </div>
    <div style={{position:"relative"}}><input style={S.inp} placeholder="Travel time" value={s.travelTime} onChange={e=>u("travelTime",e.target.value)}/>{calcing&&<div style={S.calcBadge}>calculating…</div>}</div>
    <div style={S.formRow}><div style={{flex:1}}><div style={S.fieldLabel}>Arrive</div><input style={S.inp} type="time" value={s.arriveTime} onChange={e=>u("arriveTime",e.target.value)}/></div><div style={{flex:1}}><div style={S.fieldLabel}>Depart</div><input style={S.inp} type="time" value={s.departTime} onChange={e=>u("departTime",e.target.value)}/></div></div>
    <textarea style={{...S.inp,minHeight:38}} placeholder="Notes" value={s.notes} onChange={e=>u("notes",e.target.value)}/>
    <div style={S.formActions}><button style={S.btnFill} onClick={()=>onSave({...s,id:s.id||uid()})}>Save</button><button style={S.btnFlat} onClick={onCancel}>Cancel</button></div>
  </div>);
}

function DragStops({stops,color,onReorder,onEdit,onDelete}){
  const[dI,setDI]=useState(null);const[oI,setOI]=useState(null);
  const drop=(e,i)=>{e.preventDefault();if(dI!==null&&dI!==i){const a=[...stops];const[it]=a.splice(dI,1);a.splice(i,0,it);onReorder(a);}setDI(null);setOI(null);};
  return(<div style={S.stopsList}>
    {stops.length===0&&<div style={{padding:"14px 0",color:"#ccc",fontSize:12}}>No stops yet</div>}
    {stops.map((s,si)=>(
      <div key={s.id||si} draggable onDragStart={()=>setDI(si)} onDragOver={e=>{e.preventDefault();setOI(si);}} onDrop={e=>drop(e,si)} onDragEnd={()=>{setDI(null);setOI(null);}} style={{...S.stopRow,opacity:dI===si?.35:1,borderTop:oI===si&&dI!==si?`2px solid ${color}`:"none"}}>
        <div style={S.stopTimeline}><div style={{...S.stopDot,borderColor:color}}><span style={{fontSize:8,fontWeight:700,color}}>{si+1}</span></div>{si<stops.length-1&&<div style={{...S.stopLine,background:color}}/>}</div>
        <div style={S.grip}>⠿</div>
        <div style={{flex:1,minWidth:0}}>
          <div style={S.stopTop}><span style={S.stopName}>{sI(s.type)} {s.name||"Unnamed"}</span><div style={{display:"flex",gap:2,flexShrink:0}}><button style={S.xBtn} onClick={()=>onEdit(si)}>✎</button><button style={{...S.xBtn,color:"#b44"}} onClick={()=>onDelete(si)}>×</button></div></div>
          <div style={S.tags}>
            {s.transport&&<span style={S.tag}>{tI(s.transport)} {tL(s.transport)}</span>}
            {s.travelTime&&<span style={{...S.tag,background:"#edf8f6",color:"#2a8f82"}}>⏱ {s.travelTime}</span>}
            {s.arriveTime&&<span style={S.tag}>{fmt(s.arriveTime)}</span>}
            {s.arriveTime&&s.departTime&&<span style={{color:"#ccc",fontSize:11}}>→</span>}
            {s.departTime&&<span style={S.tag}>{fmt(s.departTime)}</span>}
          </div>
          {s.address&&<div style={S.stopAddr}>{s.address}</div>}
          {s.notes&&<div style={S.stopNotes}>{s.notes}</div>}
        </div>
      </div>
    ))}
  </div>);
}

/* ════════════════════ HOME PAGE ════════════════════ */
function HomePage(){
  const[myTrips,setMyTrips]=useState([]);
  const[creating,setCreating]=useState(false);
  const[newName,setNewName]=useState("Tulum Trip");

  useEffect(()=>{
    try{const ids=JSON.parse(localStorage.getItem("my-tulum-trips")||"[]");setMyTrips(ids);}catch{setMyTrips([]);}
  },[]);

  const createTrip=async()=>{
    setCreating(true);
    try{
      const ref=await addDoc(collection(db,"trips"),{...BLANK_TRIP(newName),createdAt:Date.now()});
      const ids=[...myTrips,{id:ref.id,name:newName}];
      localStorage.setItem("my-tulum-trips",JSON.stringify(ids));
      window.location.hash=`#/trip/${ref.id}`;
    }catch(e){console.error(e);alert("Failed to create trip");}
    setCreating(false);
  };

  const removeFromList=id=>{
    const ids=myTrips.filter(t=>t.id!==id);
    setMyTrips(ids);
    localStorage.setItem("my-tulum-trips",JSON.stringify(ids));
  };

  return(
    <div style={S.homePage}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');*{box-sizing:border-box;margin:0}`}</style>
      <div style={S.homeHero}>
        <span style={{fontSize:48}}>🌴</span>
        <h1 style={S.homeTitle}>Tulum Planner</h1>
        <p style={S.homeTag}>Plan your trip, share with friends — everyone sees changes in real time</p>
      </div>
      <div style={S.homeContent}>
        <div style={S.homeCreate}>
          <input style={{...S.inp,fontSize:15,padding:"12px 16px"}} placeholder="Trip name" value={newName} onChange={e=>setNewName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&createTrip()}/>
          <button style={{...S.btnFill,fontSize:15,padding:"12px 24px"}} onClick={createTrip} disabled={creating}>{creating?"Creating…":"Create Trip"}</button>
        </div>
        {myTrips.length>0&&<div style={S.homeLabel}>Your Trips</div>}
        {myTrips.map(t=>(
          <a key={t.id} href={`#/trip/${t.id}`} style={S.homeTripCard}>
            <span style={{fontSize:20}}>🌴</span>
            <div style={{flex:1}}>
              <div style={{fontWeight:600,fontSize:14}}>{t.name}</div>
              <div style={{fontSize:11,color:"#aaa",marginTop:2}}>Click to open · Share this link with friends</div>
            </div>
            <button style={{...S.xBtn,fontSize:16}} onClick={e=>{e.preventDefault();e.stopPropagation();removeFromList(t.id);}}>×</button>
          </a>
        ))}
        <div style={S.homeHint}>
          <b>How sharing works:</b> Create a trip, copy the URL from your browser bar, and send it to anyone.
          They'll see the same trip and can edit it too — changes sync in real time.
        </div>
      </div>
    </div>
  );
}

/* ════════════════════ TRIP PAGE ════════════════════ */
function TripPage({tripId}){
  const[trip,setTrip]=useState(null);
  const[loading,setLoading]=useState(true);
  const[view,setView]=useState("plan");
  const[activeDay,setActiveDay]=useState(null);
  const[addFlight,setAddFlight]=useState(null);
  const[editFlightI,setEditFlightI]=useState(null);
  const[showHome,setShowHome]=useState(false);
  const[addStopDay,setAddStopDay]=useState(null);
  const[editStop,setEditStop]=useState(null);
  const[editDayI,setEditDayI]=useState(null);
  const[editDayF,setEditDayF]=useState({title:"",date:""});
  const[coordHint,setCoordHint]=useState(null);
  const[copied,setCopied]=useState(false);
  const dayRefs=useRef({});
  const skipSync=useRef(false);

  // Real-time listener
  useEffect(()=>{
    const unsub=onSnapshot(doc(db,"trips",tripId),snap=>{
      if(snap.exists()){
        if(skipSync.current){skipSync.current=false;return;}
        setTrip(snap.data());
        // save to local list
        try{
          const ids=JSON.parse(localStorage.getItem("my-tulum-trips")||"[]");
          if(!ids.find(t=>t.id===tripId)){
            ids.push({id:tripId,name:snap.data().name||"Trip"});
            localStorage.setItem("my-tulum-trips",JSON.stringify(ids));
          }
        }catch{}
      } else {
        setTrip(null);
      }
      setLoading(false);
    });
    return unsub;
  },[tripId]);

  // Write to Firestore
  const save=useCallback(async(newTrip)=>{
    setTrip(newTrip);
    skipSync.current=true;
    try{await setDoc(doc(db,"trips",tripId),newTrip);}catch(e){console.error("Save error:",e);}
  },[tripId]);

  const up=fn=>{
    const c=JSON.parse(JSON.stringify(trip));fn(c);save(c);
    // update local list name
    try{const ids=JSON.parse(localStorage.getItem("my-tulum-trips")||"[]");const found=ids.find(t=>t.id===tripId);if(found&&c.name!==found.name){found.name=c.name;localStorage.setItem("my-tulum-trips",JSON.stringify(ids));}}catch{}
  };

  const onMapClick=useCallback(ll=>setCoordHint(ll),[]);

  if(loading)return<div style={S.loadingPage}><style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap');*{box-sizing:border-box;margin:0}`}</style><div style={{fontSize:36}}>🌴</div><div style={{marginTop:12,fontWeight:600}}>Loading trip…</div></div>;
  if(!trip)return<div style={S.loadingPage}><style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap');*{box-sizing:border-box;margin:0}`}</style><div style={{fontSize:36}}>😕</div><div style={{marginTop:12,fontWeight:600}}>Trip not found</div><a href="#/" style={{marginTop:8,color:"#2a8f82"}}>← Back home</a></div>;

  // Flights
  const saveFlight=(dir,f)=>{up(t=>{const a=dir==="arrival"?t.arrivalFlights:t.departureFlights;if(editFlightI!==null)a[editFlightI]=f;else a.push(f);});setAddFlight(null);setEditFlightI(null);};
  const delFlight=(dir,i)=>up(t=>(dir==="arrival"?t.arrivalFlights:t.departureFlights).splice(i,1));
  // Days
  const addDay=()=>{const last=(trip.days||[])[trip.days.length-1]?.date;let next="";if(last){const d=new Date(last+"T12:00:00");d.setDate(d.getDate()+1);next=d.toISOString().slice(0,10);}up(t=>{if(!t.days)t.days=[];t.days.push({id:uid(),title:`Day ${t.days.length+1}`,date:next,stops:[]});});};
  const delDay=i=>{up(t=>t.days.splice(i,1));if(activeDay===i)setActiveDay(null);};
  // Stops
  const saveStopFn=(di,s)=>{up(t=>{if(editStop)t.days[di].stops[editStop.si]=s;else t.days[di].stops.push(s);});setAddStopDay(null);setEditStop(null);setCoordHint(null);};
  const delStop=(di,si)=>up(t=>t.days[di].stops.splice(si,1));
  const reorder=(di,arr)=>up(t=>{t.days[di].stops=arr;});
  const scrollTo=i=>{setActiveDay(i);setView("plan");setTimeout(()=>dayRefs.current[i]?.scrollIntoView({behavior:"smooth",block:"start"}),60);};

  const totalStops=(trip.days||[]).reduce((a,d)=>a+(d.stops||[]).length,0);
  const shareUrl=window.location.href;
  const copyLink=()=>{navigator.clipboard.writeText(shareUrl);setCopied(true);setTimeout(()=>setCopied(false),2000);};

  return(
    <div style={S.root}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap');
        *{box-sizing:border-box;margin:0}::-webkit-scrollbar{width:5px}::-webkit-scrollbar-thumb{background:#d4d0ca;border-radius:3px}
        input,select,textarea,button{font-family:inherit}input:focus,select:focus,textarea:focus{outline:none;border-color:#1a1a1a!important}
        .leaflet-container{font-family:inherit!important}
      `}</style>
      <header style={S.topBar}>
        <div style={S.topLeft}>
          <a href="#/" style={{textDecoration:"none",fontSize:20}}>🌴</a>
          <span style={S.topTitle}>{trip.name}</span>
          <span style={S.topSub}>{(trip.days||[]).length}d · {totalStops} stops</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <button style={{...S.btnFlat,fontSize:11,padding:"5px 12px"}} onClick={copyLink}>{copied?"✓ Copied!":"📋 Copy link"}</button>
          <div style={S.liveBadge}>● Live</div>
          <div style={S.tabRow}>
            {["plan","map"].map(v=>(<button key={v} onClick={()=>setView(v)} style={{...S.tab,...(view===v?S.tabActive:{})}}>{v==="plan"?"Itinerary":"Map"}</button>))}
          </div>
        </div>
      </header>
      <div style={S.body}>
        {/* SIDEBAR */}
        <aside style={S.side}>
          <div style={S.ss}><div style={S.sl}>Flights</div>
            {(trip.arrivalFlights||[]).map((f,i)=>(<div key={f.id||i} style={S.sf}><span>🛬</span><span style={S.sft}>{f.airline} {f.flight}</span><button style={S.xBtn} onClick={()=>delFlight("arrival",i)}>×</button></div>))}
            {(trip.departureFlights||[]).map((f,i)=>(<div key={f.id||i} style={S.sf}><span>🛫</span><span style={S.sft}>{f.airline} {f.flight}</span><button style={S.xBtn} onClick={()=>delFlight("departure",i)}>×</button></div>))}
            <div style={{display:"flex",gap:4}}><button style={S.sideAdd} onClick={()=>{setAddFlight("arrival");setView("plan");}}>+ Arrival</button><button style={S.sideAdd} onClick={()=>{setAddFlight("departure");setView("plan");}}>+ Depart</button></div>
          </div>
          <div style={S.ss}><div style={S.sl}>Homebase</div>
            {trip.homebase?(<div style={S.sh}><span>🏠</span><span style={S.sht}>{trip.homebase.name||"Set"}</span><button style={S.xBtn} onClick={()=>{setShowHome(true);setView("plan");}}>✎</button><button style={{...S.xBtn,color:"#b44"}} onClick={()=>up(t=>t.homebase=null)}>×</button></div>):(<button style={S.sideAdd} onClick={()=>{setShowHome(true);setView("plan");}}>+ Set homebase</button>)}
          </div>
          <div style={S.ss}><div style={S.sl}>Days</div>
            {(trip.days||[]).map((d,i)=>(<button key={d.id||i} onClick={()=>scrollTo(i)} style={{...S.sd,...(activeDay===i?S.sdA:{})}}><div style={{...S.sdDot,background:COLORS[i%COLORS.length]}}>{i+1}</div><div style={{flex:1,minWidth:0}}><div style={S.sdT}>{d.title}</div><div style={S.sdM}>{d.date?new Date(d.date+"T12:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric"}):"—"} · {(d.stops||[]).length} stop{(d.stops||[]).length!==1&&"s"}</div></div></button>))}
            <button style={S.sideAdd} onClick={addDay}>+ Add day</button>
          </div>
        </aside>
        <main style={S.main}>
          {view==="map"&&(<div style={{flex:1,position:"relative"}}><LeafletMap trip={trip} activeDay={activeDay} onClickLatLng={onMapClick}/><div style={S.mapFilter}><button onClick={()=>setActiveDay(null)} style={{...S.fBtn,...(activeDay===null?S.fBtnA:{})}}>All</button>{(trip.days||[]).map((d,i)=>(<button key={d.id||i} onClick={()=>setActiveDay(activeDay===i?null:i)} style={{...S.fBtn,...(activeDay===i?{...S.fBtnA,background:COLORS[i%COLORS.length]}:{})}}>{d.title}</button>))}</div></div>)}
          {view==="plan"&&(
            <div style={S.planScroll}>
              <section style={S.ps}><div style={S.pl}>✈ Arrival</div>
                {(trip.arrivalFlights||[]).map((f,i)=>(<div key={f.id||i} style={S.fr}><span style={{fontSize:18}}>🛬</span><div style={{flex:1}}><div style={S.fn}>{f.airline} {f.flight}</div><div style={S.fm}>{fmtD(f.date)}{f.time&&` · ${fmt(f.time)}`}{f.airport&&` · ${f.airport}`}</div>{f.depCity&&<div style={S.frt}>{f.depAirport} ({f.depCity}) → {f.arrAirport} ({f.arrCity})</div>}</div><button style={S.xBtn} onClick={()=>{setEditFlightI(i);setAddFlight("arrival");}}>✎</button><button style={{...S.xBtn,color:"#b44"}} onClick={()=>delFlight("arrival",i)}>×</button></div>))}
                {addFlight==="arrival"&&<FlightForm initial={editFlightI!==null?(trip.arrivalFlights||[])[editFlightI]:null} onSave={f=>saveFlight("arrival",f)} onCancel={()=>{setAddFlight(null);setEditFlightI(null);}}/>}
                {!addFlight&&<button style={S.addBtn} onClick={()=>setAddFlight("arrival")}>+ Add arrival flight</button>}
              </section>
              {(trip.homebase||showHome)&&(<section style={S.ps}><div style={S.pl}>🏠 Homebase</div>
                {trip.homebase&&!showHome&&(<div style={S.hc}><div style={{flex:1}}><div style={S.hn}>{trip.homebase.name}</div>{trip.homebase.address&&<div style={S.hsub}>{trip.homebase.address}</div>}<div style={S.hm}>{trip.homebase.checkInDate&&<>In: {fmtD(trip.homebase.checkInDate)}{trip.homebase.checkInTime&&` ${fmt(trip.homebase.checkInTime)}`}</>}{trip.homebase.checkOutDate&&<> · Out: {fmtD(trip.homebase.checkOutDate)}{trip.homebase.checkOutTime&&` ${fmt(trip.homebase.checkOutTime)}`}</>}</div>{trip.homebase.lat&&<div style={S.coordBadge}>📍 {trip.homebase.lat}, {trip.homebase.lng}</div>}{trip.homebase.notes&&<div style={S.hnt}>{trip.homebase.notes}</div>}</div><button style={S.xBtn} onClick={()=>setShowHome(true)}>✎</button></div>)}
                {showHome&&<HomebaseForm initial={trip.homebase} coordHint={coordHint} onSave={h=>{up(t=>t.homebase=h);setShowHome(false);setCoordHint(null);}} onCancel={()=>{setShowHome(false);setCoordHint(null);}}/>}
              </section>)}
              {!trip.homebase&&!showHome&&<section style={S.ps}><button style={S.addBtn} onClick={()=>setShowHome(true)}>+ Set homebase / Airbnb</button></section>}
              {(trip.days||[]).length===0&&<div style={S.empty}><div style={{fontSize:36,marginBottom:8}}>🗓</div><div style={{fontWeight:600}}>No days yet</div><div style={{color:"#aaa",fontSize:12,marginTop:4}}>Add a day to start</div></div>}
              {(trip.days||[]).map((day,di)=>{
                const color=COLORS[di%COLORS.length];const stops=day.stops||[];
                const getPrev=si=>si>0?stops[si-1]:trip.homebase;
                return(<section key={day.id||di} ref={el=>dayRefs.current[di]=el} style={S.daySection}>
                  <div style={S.dayHead}><div style={{...S.dayDot,background:color}}>{di+1}</div>
                    {editDayI===di?(<div style={{display:"flex",gap:6,flex:1,alignItems:"center",flexWrap:"wrap"}}><input style={{...S.inp,flex:1,minWidth:90}} value={editDayF.title} onChange={e=>setEditDayF({...editDayF,title:e.target.value})}/><input style={{...S.inp,width:140}} type="date" value={editDayF.date} onChange={e=>setEditDayF({...editDayF,date:e.target.value})}/><button style={S.btnFill} onClick={()=>{up(t=>Object.assign(t.days[di],editDayF));setEditDayI(null);}}>Save</button><button style={S.btnFlat} onClick={()=>setEditDayI(null)}>×</button></div>):(
                    <><div style={{flex:1}}><div style={S.dayTitle}>{day.title}</div><div style={S.dayMeta}>{day.date?new Date(day.date+"T12:00:00").toLocaleDateString("en-US",{weekday:"long",month:"short",day:"numeric"}):"No date"} · {stops.length} stop{stops.length!==1&&"s"}</div></div><button style={S.btnFlat} onClick={()=>{setEditDayI(di);setEditDayF({title:day.title,date:day.date});}}>Edit</button><button style={{...S.btnFlat,color:"#b44"}} onClick={()=>delDay(di)}>Delete</button></>)}
                  </div>
                  <DragStops stops={stops} color={color} onReorder={a=>reorder(di,a)} onEdit={si=>{setEditStop({di,si});setAddStopDay(null);}} onDelete={si=>delStop(di,si)}/>
                  {editStop?.di===di&&<div style={{padding:"0 16px 16px"}}><StopForm initial={stops[editStop.si]} coordHint={coordHint} onSave={s=>saveStopFn(di,s)} onCancel={()=>{setEditStop(null);setCoordHint(null);}} prevStop={getPrev(editStop.si)} homebase={trip.homebase}/></div>}
                  {addStopDay===di&&editStop?.di!==di&&<div style={{padding:"0 16px 16px"}}><StopForm coordHint={coordHint} onSave={s=>saveStopFn(di,s)} onCancel={()=>{setAddStopDay(null);setCoordHint(null);}} prevStop={stops[stops.length-1]||null} homebase={trip.homebase}/></div>}
                  {addStopDay!==di&&editStop?.di!==di&&<button style={S.addStopBtn} onClick={()=>{setAddStopDay(di);setEditStop(null);}}>+ Add stop</button>}
                </section>);
              })}
              <button style={S.addDayBtn} onClick={addDay}>+ Add day</button>
              <section style={{...S.ps,marginTop:8}}><div style={S.pl}>✈ Departure</div>
                {(trip.departureFlights||[]).map((f,i)=>(<div key={f.id||i} style={S.fr}><span style={{fontSize:18}}>🛫</span><div style={{flex:1}}><div style={S.fn}>{f.airline} {f.flight}</div><div style={S.fm}>{fmtD(f.date)}{f.time&&` · ${fmt(f.time)}`}{f.airport&&` · ${f.airport}`}</div>{f.depCity&&<div style={S.frt}>{f.depAirport} ({f.depCity}) → {f.arrAirport} ({f.arrCity})</div>}</div><button style={S.xBtn} onClick={()=>{setEditFlightI(i);setAddFlight("departure");}}>✎</button><button style={{...S.xBtn,color:"#b44"}} onClick={()=>delFlight("departure",i)}>×</button></div>))}
                {addFlight==="departure"&&<FlightForm initial={editFlightI!==null?(trip.departureFlights||[])[editFlightI]:null} onSave={f=>saveFlight("departure",f)} onCancel={()=>{setAddFlight(null);setEditFlightI(null);}}/>}
                {!addFlight&&<button style={S.addBtn} onClick={()=>setAddFlight("departure")}>+ Add departure flight</button>}
              </section>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

/* ════════════════════ ROUTER ════════════════════ */
export default function App(){
  const hash=useHash();
  const match=hash.match(/#\/trip\/(.+)/);
  if(match)return<TripPage tripId={match[1]}/>;
  return<HomePage/>;
}

/* ════════════════════ STYLES ════════════════════ */
const S={
  root:{fontFamily:"'DM Sans',system-ui,sans-serif",color:"#1a1a1a",background:"#fafaf8",height:"100vh",display:"flex",flexDirection:"column",fontSize:13,lineHeight:1.45},
  // home
  homePage:{fontFamily:"'DM Sans',system-ui,sans-serif",color:"#1a1a1a",background:"#fafaf8",minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center"},
  homeHero:{textAlign:"center",padding:"60px 20px 30px"},
  homeTitle:{fontSize:36,fontWeight:800,letterSpacing:"-1px",margin:"12px 0 0"},
  homeTag:{fontSize:15,color:"#888",marginTop:8,maxWidth:400},
  homeContent:{width:"100%",maxWidth:480,padding:"0 20px 60px"},
  homeCreate:{display:"flex",gap:10,marginBottom:24},
  homeLabel:{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:".8px",color:"#bbb",marginBottom:10},
  homeTripCard:{display:"flex",alignItems:"center",gap:12,padding:"14px 16px",background:"#fff",borderRadius:10,border:"1px solid #eee",marginBottom:8,textDecoration:"none",color:"#1a1a1a",transition:"box-shadow .15s"},
  homeHint:{marginTop:24,padding:"16px",background:"#fff",borderRadius:10,border:"1px solid #eee",fontSize:12,color:"#888",lineHeight:1.6},
  // loading
  loadingPage:{fontFamily:"'DM Sans',system-ui,sans-serif",color:"#1a1a1a",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100vh"},
  // top bar
  topBar:{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"0 20px",height:50,borderBottom:"1px solid #e8e6e1",background:"#fff",flexShrink:0,zIndex:100},
  topLeft:{display:"flex",alignItems:"center",gap:10},
  topTitle:{fontSize:16,fontWeight:700,letterSpacing:"-.3px"},
  topSub:{fontSize:11,color:"#aaa",marginLeft:2},
  liveBadge:{fontSize:10,color:"#3a9e5c",fontWeight:600,background:"#edfbf0",padding:"3px 8px",borderRadius:10},
  tabRow:{display:"flex",gap:2,background:"#f2f1ed",borderRadius:8,padding:3},
  tab:{padding:"5px 16px",border:"none",borderRadius:6,background:"transparent",fontSize:12,fontWeight:600,cursor:"pointer",color:"#888",fontFamily:"inherit"},
  tabActive:{background:"#fff",color:"#1a1a1a",boxShadow:"0 1px 3px rgba(0,0,0,.06)"},
  body:{display:"flex",flex:1,overflow:"hidden"},
  side:{width:200,borderRight:"1px solid #e8e6e1",background:"#fff",overflowY:"auto",padding:"8px 0",flexShrink:0},
  ss:{padding:"8px 12px 10px",borderBottom:"1px solid #f0efeb"},
  sl:{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:".8px",color:"#bbb",marginBottom:6},
  sf:{display:"flex",alignItems:"center",gap:5,padding:"3px 0",fontSize:12},
  sft:{flex:1,fontWeight:500,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"},
  sh:{display:"flex",alignItems:"center",gap:6},
  sht:{flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontSize:12,fontWeight:500},
  sideAdd:{border:"1px dashed #d4d0ca",borderRadius:6,background:"transparent",padding:"5px 10px",fontSize:11,fontWeight:600,color:"#aaa",cursor:"pointer",marginTop:4,flex:1,fontFamily:"inherit",width:"100%"},
  sd:{display:"flex",alignItems:"center",gap:8,width:"100%",padding:"6px",border:"none",borderRadius:6,background:"transparent",cursor:"pointer",textAlign:"left",fontFamily:"inherit"},
  sdA:{background:"#f5f3ee"},
  sdDot:{width:22,height:22,borderRadius:"50%",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700,flexShrink:0},
  sdT:{fontSize:12,fontWeight:600,color:"#1a1a1a",lineHeight:1.2},
  sdM:{fontSize:10,color:"#bbb"},
  main:{flex:1,overflow:"hidden",display:"flex",flexDirection:"column"},
  mapFilter:{position:"absolute",bottom:14,left:14,display:"flex",gap:4,flexWrap:"wrap",zIndex:1000},
  fBtn:{padding:"4px 12px",border:"none",borderRadius:14,background:"#fff",fontSize:11,fontWeight:600,cursor:"pointer",boxShadow:"0 1px 4px rgba(0,0,0,.08)",color:"#666",fontFamily:"inherit"},
  fBtnA:{background:"#1a1a1a",color:"#fff"},
  planScroll:{flex:1,overflowY:"auto",padding:"16px 20px 40px"},
  ps:{marginBottom:16},
  pl:{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:".6px",color:"#bbb",marginBottom:8},
  fr:{display:"flex",gap:10,alignItems:"center",padding:"10px 14px",background:"#fff",borderRadius:10,border:"1px solid #eee",marginBottom:6},
  fn:{fontSize:13,fontWeight:600},fm:{fontSize:11,color:"#999",marginTop:1},
  frt:{fontSize:11,color:"#2a8f82",marginTop:2,fontWeight:500},
  hc:{display:"flex",gap:12,padding:"12px 14px",background:"#fff",borderRadius:10,border:"1px solid #e8dcc8"},
  hn:{fontSize:14,fontWeight:600},hsub:{fontSize:12,color:"#999",marginTop:1},hm:{fontSize:11,color:"#aaa",marginTop:3},hnt:{fontSize:11,color:"#999",marginTop:4,fontStyle:"italic"},
  coordBadge:{fontSize:10,color:"#2a8f82",background:"#edf8f6",padding:"2px 8px",borderRadius:8,display:"inline-block",marginTop:4},
  empty:{textAlign:"center",padding:"40px 20px",color:"#999"},
  daySection:{background:"#fff",borderRadius:10,border:"1px solid #eee",marginBottom:10,overflow:"hidden"},
  dayHead:{display:"flex",alignItems:"center",gap:10,padding:"12px 16px",borderBottom:"1px solid #f5f3ee"},
  dayDot:{width:30,height:30,borderRadius:"50%",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:700,flexShrink:0},
  dayTitle:{fontSize:14,fontWeight:700,letterSpacing:"-.2px"},dayMeta:{fontSize:11,color:"#aaa"},
  stopsList:{padding:"4px 16px"},
  stopRow:{display:"flex",gap:8,padding:"10px 0",borderBottom:"1px solid #f8f6f2",transition:"opacity .15s"},
  stopTimeline:{display:"flex",flexDirection:"column",alignItems:"center",width:14,paddingTop:4},
  stopDot:{width:14,height:14,borderRadius:"50%",border:"2.5px solid",background:"#fff",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center"},
  stopLine:{width:1.5,flex:1,marginTop:2,opacity:.25,minHeight:14},
  grip:{color:"#ccc",fontSize:14,cursor:"grab",userSelect:"none",paddingTop:2,lineHeight:1},
  stopTop:{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:6},
  stopName:{fontSize:13,fontWeight:600},
  tags:{display:"flex",gap:5,marginTop:3,flexWrap:"wrap",alignItems:"center"},
  tag:{fontSize:11,color:"#888",background:"#f5f3ee",padding:"1px 8px",borderRadius:10},
  stopAddr:{fontSize:11,color:"#aaa",marginTop:3},stopNotes:{fontSize:11,color:"#aaa",marginTop:3,fontStyle:"italic"},
  addStopBtn:{width:"100%",padding:"10px",border:"none",borderTop:"1px dashed #e8e6e1",background:"transparent",fontSize:12,fontWeight:600,color:"#bbb",cursor:"pointer",fontFamily:"inherit"},
  addDayBtn:{width:"100%",padding:"12px",border:"1.5px dashed #d4d0ca",borderRadius:10,background:"transparent",fontSize:12,fontWeight:600,color:"#aaa",cursor:"pointer",marginBottom:16,fontFamily:"inherit"},
  addBtn:{border:"1px dashed #d4d0ca",borderRadius:8,background:"transparent",padding:"8px 14px",fontSize:11,fontWeight:600,color:"#aaa",cursor:"pointer",fontFamily:"inherit",width:"100%",marginTop:4},
  formCard:{display:"flex",flexDirection:"column",gap:8,padding:"10px 0"},
  formRow:{display:"flex",gap:8},formActions:{display:"flex",gap:8,marginTop:2},
  fieldLabel:{fontSize:10,color:"#aaa",marginBottom:3,fontWeight:600},
  divLabel:{fontSize:10,fontWeight:600,color:"#aaa",marginTop:2},
  okBox:{fontSize:12,color:"#2a8f82",background:"#edf8f6",padding:"6px 10px",borderRadius:8},
  errBox:{fontSize:12,color:"#c45d3e",background:"#fef0ec",padding:"6px 10px",borderRadius:8},
  calcBadge:{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",fontSize:10,color:"#2a8f82",fontWeight:600},
  inp:{padding:"8px 10px",border:"1px solid #e0ddd7",borderRadius:6,fontSize:12,background:"#fafaf8",color:"#1a1a1a",width:"100%",fontFamily:"inherit"},
  btnFill:{padding:"7px 16px",border:"none",borderRadius:6,background:"#1a1a1a",color:"#fff",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"},
  btnFlat:{padding:"7px 14px",border:"1px solid #e0ddd7",borderRadius:6,background:"#fff",fontSize:12,fontWeight:500,cursor:"pointer",color:"#888",fontFamily:"inherit"},
  xBtn:{border:"none",background:"transparent",fontSize:13,cursor:"pointer",color:"#bbb",padding:"2px 4px",fontFamily:"inherit"},
};
