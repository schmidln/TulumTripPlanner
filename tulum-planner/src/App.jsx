import { useState, useEffect, useRef, useCallback } from "react";
import { db } from "./firebase.js";
import { doc, setDoc, onSnapshot, deleteDoc, collection, addDoc, serverTimestamp, query, orderBy } from "firebase/firestore";
import { jsPDF } from "jspdf";

const GMAPS_KEY = "AIzaSyDs3SBHq2KvtCg2e3afj0C3bWKqzJXWTYI";

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

/* ════════════════════ GEOCODE (Google) ════════════════════ */
const geocode=async addr=>{
  if(!addr||addr.trim().length<3)return null;
  console.log("[Geocode] Looking up:", addr);
  try{
    const r=await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(addr)}&key=${GMAPS_KEY}`);
    const d=await r.json();
    console.log("[Geocode] Status:", d.status, "Results:", d.results?.length);
    if(d.status==="OK"&&d.results?.length){
      const loc=d.results[0].geometry.location;
      const result={lat:+loc.lat.toFixed(5),lng:+loc.lng.toFixed(5)};
      console.log("[Geocode] Found:", result, "→", d.results[0].formatted_address);
      return result;
    }
    console.log("[Geocode] No results for:", addr);
  }catch(e){console.error("[Geocode] Error:",e);}
  return null;
};

/* ════════════════════ TRAVEL TIME (Google Directions via serverless) ════════════════════ */
const googleTravelMode=(transport)=>{
  if(transport==="walk")return"walking";
  if(transport==="bike")return"bicycling";
  return"driving";
};

const calcTravel=async(from,to,transport)=>{
  if(!from?.lat||!to?.lat)return null;
  const mode=googleTravelMode(transport);
  
  // Use serverless endpoint (avoids CORS, uses server-side Google API)
  try{
    const r=await fetch("/api/directions",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({fromLat:from.lat,fromLng:from.lng,toLat:to.lat,toLng:to.lng,mode}),
    });
    if(r.ok){
      const d=await r.json();
      let secs=d.duration;
      const meters=d.distance;
      // Adjust for scooter/colectivo
      if(transport==="scooter")secs=Math.round(secs*1.3);
      if(transport==="colectivo")secs=Math.round(secs*1.5);
      const mins=Math.round(secs/60);
      const km=(meters/1000).toFixed(1);
      const timeStr=mins<60?`${mins} min`:`${Math.floor(mins/60)}h ${mins%60}m`;
      console.log("[Travel] Google:",mode,timeStr,km+"km");
      return`${timeStr} (${km} km)`;
    }
    console.log("[Travel] Serverless failed, status:", r.status);
  }catch(e){
    console.log("[Travel] Serverless error:", e.message);
  }

  // Fallback: OSRM (for local dev without serverless)
  console.log("[Travel] Falling back to OSRM");
  const pr=transport==="walk"?"foot":transport==="bike"?"bike":"car";
  const osrmMode=pr==="car"?"driving":pr==="bike"?"cycling":"walking";
  try{
    const r=await fetch(`https://router.project-osrm.org/route/v1/${osrmMode}/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`);
    const d=await r.json();
    if(d.routes?.length){
      let secs=d.routes[0].duration;let meters=d.routes[0].distance;
      if(transport==="scooter")secs*=1.3;if(transport==="colectivo")secs*=1.5;
      const mins=Math.round(secs/60);const km=(meters/1000).toFixed(1);
      const timeStr=mins<60?`${mins} min`:`${Math.floor(mins/60)}h ${mins%60}m`;
      console.log("[Travel] OSRM:",osrmMode,timeStr,km+"km");
      return`${timeStr} (${km} km)`;
    }
  }catch{}
  return null;
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

/* ════════════════════ GOOGLE MAP ════════════════════ */
function GMap({trip,activeDay,onClickLatLng,visible,showLines,pinMode}){
  const divRef=useRef(null);
  const mapRef=useRef(null);
  const overlaysRef=useRef([]);
  const[loaded,setLoaded]=useState(!!window.google?.maps);

  // Load Google Maps API
  useEffect(()=>{
    if(window.google?.maps){setLoaded(true);return;}
    if(document.getElementById("gmaps-script"))return;
    const s=document.createElement("script");
    s.id="gmaps-script";
    s.src=`https://maps.googleapis.com/maps/api/js?key=${GMAPS_KEY}&libraries=marker`;
    s.async=true;s.defer=true;
    s.onload=()=>setLoaded(true);
    document.head.appendChild(s);
  },[]);

  // Init map
  useEffect(()=>{
    if(!loaded||!divRef.current||mapRef.current)return;
    const map=new google.maps.Map(divRef.current,{
      center:{lat:TULUM.lat,lng:TULUM.lng},zoom:13,
      mapTypeControl:true,
      mapTypeControlOptions:{
        style:google.maps.MapTypeControlStyle.HORIZONTAL_BAR,
        position:google.maps.ControlPosition.TOP_RIGHT,
        mapTypeIds:["roadmap","satellite","hybrid"],
      },
      streetViewControl:true,
      fullscreenControl:true,
      zoomControl:true,
    });
    map.addListener("click",e=>{
      if(e.latLng)onClickLatLng?.({lat:+e.latLng.lat().toFixed(5),lng:+e.latLng.lng().toFixed(5)});
    });
    mapRef.current=map;
    return()=>{mapRef.current=null;};
  },[loaded]);

  // Update click handler
  useEffect(()=>{
    if(!mapRef.current)return;
    google.maps.event.clearListeners(mapRef.current,"click");
    mapRef.current.addListener("click",e=>{
      if(e.latLng)onClickLatLng?.({lat:+e.latLng.lat().toFixed(5),lng:+e.latLng.lng().toFixed(5)});
    });
  },[onClickLatLng]);

  // Cursor for pin mode
  useEffect(()=>{
    if(!mapRef.current)return;
    mapRef.current.setOptions({draggableCursor:pinMode?"crosshair":null});
  },[pinMode]);

  // Resolve fromId to coords
  const resolveFrom=(fromId)=>{
    if(!fromId)return null;
    if(fromId==="homebase"&&trip.homebase?.lat)return{lat:trip.homebase.lat,lng:trip.homebase.lng};
    if(fromId==="airport")return{lat:CUN.lat,lng:CUN.lng};
    for(const day of(trip.days||[]))for(const s of(day.stops||[]))if(s.id===fromId&&s.lat)return{lat:s.lat,lng:s.lng};
    return null;
  };

  // Create an HTML marker
  const htmlMarker=(map,lat,lng,html,title)=>{
    const div=document.createElement("div");
    div.innerHTML=html;div.style.cursor="pointer";
    const ov=new google.maps.OverlayView();
    ov.onAdd=function(){this.getPanes().floatPane.appendChild(div);};
    ov.draw=function(){const p=this.getProjection().fromLatLngToDivPixel(new google.maps.LatLng(lat,lng));if(p){div.style.position="absolute";div.style.left=(p.x-14)+"px";div.style.top=(p.y-14)+"px";}};
    ov.onRemove=function(){div.remove();};
    ov.setMap(map);
    if(title){div.addEventListener("click",()=>{const iw=new google.maps.InfoWindow({content:title,position:{lat,lng}});iw.open(map);});}
    return ov;
  };

  // Render all markers and lines
  useEffect(()=>{
    if(!loaded||!mapRef.current)return;
    const map=mapRef.current;
    // Clear previous
    overlaysRef.current.forEach(o=>{if(o.setMap)o.setMap(null);});
    overlaysRef.current=[];

    const bounds=new google.maps.LatLngBounds();
    const dayBounds=new google.maps.LatLngBounds(); // only day-relevant pins
    let hasDayPins=false;

    const addMarker=(lat,lng,html,title,addToBounds=true)=>{
      const ov=htmlMarker(map,lat,lng,html,title);
      overlaysRef.current.push(ov);
      if(addToBounds){bounds.extend({lat,lng});}
    };

    const addDayMarker=(lat,lng,html,title)=>{
      addMarker(lat,lng,html,title,true);
      dayBounds.extend({lat,lng});hasDayPins=true;
    };

    // Tulum label — always show but don't force bounds
    addMarker(TULUM.lat,TULUM.lng,
      `<div style="background:#2a8f82;color:#fff;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.25)">Tulum</div>`,
      "<b>Tulum Centro</b>",false);

    // CUN — only add to bounds if viewing "All" (no specific day)
    addMarker(CUN.lat,CUN.lng,
      `<div style="font-size:22px;filter:drop-shadow(0 2px 4px rgba(0,0,0,.3))">✈️</div>`,
      `<b>${CUN.name}</b>`,activeDay===null);

    // Flights — only add to bounds on "All"
    [...(trip.arrivalFlights||[]),...(trip.departureFlights||[])].forEach(f=>{
      if(f.depCoords?.lat)addMarker(f.depCoords.lat,f.depCoords.lng,`<div style="font-size:18px">🛫</div>`,`<b>${f.depAirport||""} ${f.depCity||""}</b>`,activeDay===null);
      if(f.arrCoords?.lat)addMarker(f.arrCoords.lat,f.arrCoords.lng,`<div style="font-size:18px">🛬</div>`,`<b>${f.arrAirport||""} ${f.arrCity||""}</b>`,activeDay===null);
    });

    // Homebase — always show, add to day bounds if day is selected
    if(trip.homebase?.lat){
      addMarker(trip.homebase.lat,trip.homebase.lng,
        `<div style="font-size:22px;filter:drop-shadow(0 2px 4px rgba(0,0,0,.3))">🏠</div>`,
        `<b>${trip.homebase?.name||"Homebase"}</b>`);
      if(activeDay!==null){dayBounds.extend({lat:trip.homebase.lat,lng:trip.homebase.lng});hasDayPins=true;}
    }

    // Day stops
    const dis=activeDay!==null?[activeDay]:(trip.days||[]).map((_,i)=>i);
    dis.forEach(di=>{
      const day=(trip.days||[])[di];if(!day)return;
      const color=COLORS[di%COLORS.length];
      const stopsWithCoords=[];

      (day.stops||[]).forEach((s,si)=>{
        if(!s.lat)return;
        stopsWithCoords.push({...s,si});
        addDayMarker(s.lat,s.lng,
          `<div style="width:28px;height:28px;border-radius:50%;background:${color};color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.3)">${si+1}</div>`,
          `<div style="font-family:system-ui;font-size:13px;max-width:200px"><b>${si+1}. ${s.name||""}</b><br/>${sI(s.type)} ${TYPES.find(t=>t.v===s.type)?.l||""}${s.transport?`<br/>${tI(s.transport)} ${tL(s.transport)}`:""}${s.travelTime?`<br/>⏱ ${s.travelTime}`:""}</div>`);
      });

      // Draw lines in strict sequential order: homebase → stop1 → stop2 → stop3
      if(showLines&&stopsWithCoords.length>0){
        // First line: homebase → first stop
        if(trip.homebase?.lat){
          const first=stopsWithCoords[0];
          const line=new google.maps.Polyline({
            path:[{lat:trip.homebase.lat,lng:trip.homebase.lng},{lat:first.lat,lng:first.lng}],
            strokeColor:color,strokeWeight:2.5,strokeOpacity:0.5,
            icons:[{icon:{path:google.maps.SymbolPath.FORWARD_CLOSED_ARROW,scale:3,fillColor:color,fillOpacity:.8,strokeWeight:1,strokeColor:"#fff"},offset:"100%"}],
            map,
          });
          overlaysRef.current.push(line);
        }
        // Subsequent lines: stop N → stop N+1
        for(let i=0;i<stopsWithCoords.length-1;i++){
          const from=stopsWithCoords[i],to=stopsWithCoords[i+1];
          const line=new google.maps.Polyline({
            path:[{lat:from.lat,lng:from.lng},{lat:to.lat,lng:to.lng}],
            strokeColor:color,strokeWeight:2.5,strokeOpacity:0.6,
            icons:[{icon:{path:google.maps.SymbolPath.FORWARD_CLOSED_ARROW,scale:3,fillColor:color,fillOpacity:.8,strokeWeight:1,strokeColor:"#fff"},offset:"100%"}],
            map,
          });
          overlaysRef.current.push(line);
        }
      }
    });

    // Fit bounds — prefer day-specific bounds when a day is selected
    if(activeDay!==null&&hasDayPins){
      map.fitBounds(dayBounds,{top:50,bottom:50,left:50,right:50});
    }else if(!bounds.isEmpty()){
      // For "All" view, if we have day pins, prefer those; else use all
      if(hasDayPins)map.fitBounds(dayBounds,{top:50,bottom:50,left:50,right:50});
      else map.setCenter({lat:TULUM.lat,lng:TULUM.lng});
    }
  },[loaded,trip,activeDay,showLines]);

  if(!GMAPS_KEY)return(
    <div style={{width:"100%",height:"100%",display:"flex",alignItems:"center",justifyContent:"center",background:"#f5f3ee",flexDirection:"column",gap:8,padding:20}}>
      <div style={{fontSize:28}}>🗺</div>
      <div style={{fontWeight:600,fontSize:14}}>Google Maps API key needed</div>
      <div style={{fontSize:12,color:"#888",textAlign:"center",maxWidth:300}}>
        Add <code>VITE_GOOGLE_MAPS_KEY=your_key</code> to a <code>.env.local</code> file and restart the dev server. For Vercel, add it as an environment variable.
      </div>
    </div>
  );

  return <div ref={divRef} style={{width:"100%",height:"100%",minHeight:400}}/>;
}

/* ════════════════════ SMALL COMPONENTS ════════════════════ */
function AddrInput({value,onChange,onGeocode,placeholder}){
  const[busy,setBusy]=useState(false);
  const[status,setStatus]=useState(""); // "ok" | "fail" | ""
  const go=async()=>{
    if(!value||value.trim().length<3)return;
    setBusy(true);setStatus("");
    const r=await geocode(value);
    setBusy(false);
    if(r){onGeocode(r);setStatus("ok");}
    else setStatus("fail");
  };
  return(<div style={{display:"flex",flexDirection:"column",gap:4}}>
    <div style={{display:"flex",gap:6}}>
      <input style={{...S.inp,flex:1}} placeholder={placeholder||"Address"} value={value} onChange={e=>{onChange(e.target.value);setStatus("");}} onBlur={go} onKeyDown={e=>e.key==="Enter"&&go()}/>
      <button style={{...S.btnFlat,padding:"6px 10px",opacity:busy?.5:1}} onClick={go} disabled={busy}>{busy?"…":"📍"}</button>
    </div>
    {status==="fail"&&<div style={{fontSize:11,color:"#c45d3e"}}>⚠ Couldn't find this address — try adding "Tulum, Mexico" at the end</div>}
  </div>);
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

function HomebaseForm({initial,onSave,onCancel,coordHint,onRequestPin}){
  const[h,setH]=useState(initial||{name:"",address:"",checkInDate:"",checkInTime:"",checkOutDate:"",checkOutTime:"",notes:"",lat:null,lng:null});
  const[saving,setSaving]=useState(false);
  const s=(k,v)=>setH(p=>({...p,[k]:v}));
  useEffect(()=>{if(coordHint?.lat)setH(p=>({...p,lat:coordHint.lat,lng:coordHint.lng}));},[coordHint]);

  const handleSave=async()=>{
    let final={...h};
    if(final.address&&!final.lat){
      setSaving(true);
      console.log("[HomebaseForm] Geocoding before save:", final.address);
      const geo=await geocode(final.address);
      if(geo){final.lat=geo.lat;final.lng=geo.lng;}
      setSaving(false);
    }
    console.log("[HomebaseForm] Saving:", final.name, "lat:", final.lat, "lng:", final.lng);
    onSave(final);
  };

  return(<div style={S.formCard}>
    <input style={S.inp} placeholder="Name (Airbnb, Hotel…)" value={h.name} onChange={e=>s("name",e.target.value)}/>
    <AddrInput value={h.address} onChange={v=>s("address",v)} onGeocode={c=>{console.log("[HomebaseForm] Geocoded:",c);setH(p=>({...p,lat:c.lat,lng:c.lng}));}} placeholder="Full address (auto-geocodes)"/>
    <div style={{display:"flex",gap:6,alignItems:"center"}}>
      {h.lat&&<div style={S.coordBadge}>📍 {h.lat}, {h.lng}</div>}
      <button style={{...S.btnFlat,padding:"5px 10px",fontSize:11}} onClick={()=>onRequestPin?.()}>📌 {h.lat?"Re-pin":"Pin on map"}</button>
      {h.lat&&<button style={{...S.btnFlat,padding:"5px 10px",fontSize:11,color:"#b44"}} onClick={()=>setH(p=>({...p,lat:null,lng:null}))}>✕ Clear</button>}
    </div>
    {!h.lat&&h.address&&<div style={{fontSize:11,color:"#c49a3e"}}>⚠ No coordinates — use 📌 Pin on map or click 📍</div>}
    <div style={S.divLabel}>Check-in</div>
    <div style={S.formRow}><input style={S.inp} type="date" value={h.checkInDate} onChange={e=>s("checkInDate",e.target.value)}/><input style={{...S.inp,maxWidth:130}} type="time" value={h.checkInTime} onChange={e=>s("checkInTime",e.target.value)}/></div>
    <div style={S.divLabel}>Check-out</div>
    <div style={S.formRow}><input style={S.inp} type="date" value={h.checkOutDate} onChange={e=>s("checkOutDate",e.target.value)}/><input style={{...S.inp,maxWidth:130}} type="time" value={h.checkOutTime} onChange={e=>s("checkOutTime",e.target.value)}/></div>
    <textarea style={{...S.inp,minHeight:42}} placeholder="Notes (wifi, host…)" value={h.notes} onChange={e=>s("notes",e.target.value)}/>
    <div style={S.formActions}><button style={{...S.btnFill,opacity:saving?.5:1}} onClick={handleSave} disabled={saving}>{saving?"Geocoding…":"Save"}</button><button style={S.btnFlat} onClick={onCancel}>Cancel</button></div>
  </div>);
}

function StopForm({initial,onSave,onCancel,coordHint,prevStop,homebase,trip,onRequestPin}){
  const[s,setS]=useState(initial||{name:"",address:"",type:"other",transport:"taxi",travelTime:"",arriveTime:"",departTime:"",notes:"",lat:null,lng:null,fromId:""});
  const[calcing,setCalcing]=useState(false);
  const[saving,setSaving]=useState(false);
  const u=(k,v)=>setS(p=>({...p,[k]:v}));
  useEffect(()=>{if(coordHint?.lat)setS(p=>({...p,lat:coordHint.lat,lng:coordHint.lng}));},[coordHint]);

  // Build known locations for "traveling from" dropdown
  const knownLocs=[];
  if(homebase?.lat)knownLocs.push({id:"homebase",label:`🏠 ${homebase.name||"Homebase"}`,lat:homebase.lat,lng:homebase.lng});
  knownLocs.push({id:"airport",label:`✈️ CUN Airport`,lat:CUN.lat,lng:CUN.lng});
  (trip?.days||[]).forEach((d,di)=>{
    (d.stops||[]).forEach(st=>{
      if(st.lat&&st.id!==s.id)knownLocs.push({id:st.id,label:`${sI(st.type)} ${st.name} (Day ${di+1})`,lat:st.lat,lng:st.lng});
    });
  });

  // Resolve the "from" location
  const getFromCoords=(stop)=>{
    if(stop.fromId){
      const loc=knownLocs.find(k=>k.id===stop.fromId);
      if(loc)return{lat:loc.lat,lng:loc.lng};
    }
    if(prevStop?.lat)return{lat:prevStop.lat,lng:prevStop.lng};
    if(homebase?.lat)return{lat:homebase.lat,lng:homebase.lng};
    return null;
  };

  // Calculate travel time
  const doCalc=async(stop)=>{
    const from=getFromCoords(stop);
    if(!from||!stop.lat){console.log("[Travel] Missing from or to coords");return;}
    console.log("[Travel] Calculating:",stop.transport,"from",from,"to",{lat:stop.lat,lng:stop.lng});
    setCalcing(true);
    const r=await calcTravel(from,stop,stop.transport);
    setCalcing(false);
    if(r)setS(p=>({...p,travelTime:r}));
  };

  // Auto-calc when lat, transport, or fromId changes
  useEffect(()=>{
    if(s.lat&&s.transport)doCalc(s);
  },[s.lat,s.lng,s.transport,s.fromId]);

  const handleSave=async()=>{
    let final={...s,id:s.id||uid()};
    if(final.address&&!final.lat){
      setSaving(true);
      const geo=await geocode(final.address);
      if(geo){final.lat=geo.lat;final.lng=geo.lng;}
      setSaving(false);
    }
    onSave(final);
  };

  return(<div style={S.formCard}>
    <input style={S.inp} placeholder="Stop name" value={s.name} onChange={e=>u("name",e.target.value)}/>
    <AddrInput value={s.address||""} onChange={v=>u("address",v)} onGeocode={c=>setS(p=>({...p,lat:c.lat,lng:c.lng}))} placeholder="Address (auto-geocodes)"/>
    <div style={{display:"flex",gap:6,alignItems:"center"}}>
      {s.lat&&<div style={S.coordBadge}>📍 {s.lat}, {s.lng}</div>}
      <button style={{...S.btnFlat,padding:"5px 10px",fontSize:11}} onClick={()=>onRequestPin?.()}>📌 {s.lat?"Re-pin":"Pin on map"}</button>
      {s.lat&&<button style={{...S.btnFlat,padding:"5px 10px",fontSize:11,color:"#b44"}} onClick={()=>setS(p=>({...p,lat:null,lng:null}))}>✕ Clear</button>}
    </div>
    {!s.lat&&s.address&&<div style={{fontSize:11,color:"#c49a3e"}}>⚠ No coordinates — use 📌 Pin on map or click 📍</div>}
    <div style={S.divLabel}>Traveling from</div>
    <select style={S.inp} value={s.fromId||""} onChange={e=>u("fromId",e.target.value)}>
      <option value="">Auto (previous stop or homebase)</option>
      {knownLocs.map(k=><option key={k.id} value={k.id}>{k.label}</option>)}
    </select>
    <div style={S.formRow}>
      <select style={S.inp} value={s.type} onChange={e=>u("type",e.target.value)}>{TYPES.map(t=><option key={t.v} value={t.v}>{t.icon} {t.l}</option>)}</select>
      <select style={S.inp} value={s.transport} onChange={e=>u("transport",e.target.value)}>{TRANSPORT.map(t=><option key={t.v} value={t.v}>{t.icon} {t.l}</option>)}</select>
    </div>
    <div style={{display:"flex",gap:6,alignItems:"center"}}>
      <div style={{flex:1,position:"relative"}}><input style={S.inp} placeholder="Travel time" value={s.travelTime} onChange={e=>u("travelTime",e.target.value)}/>{calcing&&<div style={S.calcBadge}>calculating…</div>}</div>
      {s.lat&&<button style={{...S.btnFlat,padding:"6px 10px",fontSize:11}} onClick={()=>doCalc(s)} disabled={calcing}>🔄</button>}
    </div>
    <div style={S.formRow}><div style={{flex:1}}><div style={S.fieldLabel}>Arrive</div><input style={S.inp} type="time" value={s.arriveTime} onChange={e=>u("arriveTime",e.target.value)}/></div><div style={{flex:1}}><div style={S.fieldLabel}>Depart</div><input style={S.inp} type="time" value={s.departTime} onChange={e=>u("departTime",e.target.value)}/></div></div>
    <textarea style={{...S.inp,minHeight:38}} placeholder="Notes" value={s.notes} onChange={e=>u("notes",e.target.value)}/>
    <div style={S.formActions}><button style={{...S.btnFill,opacity:saving?.5:1}} onClick={handleSave} disabled={saving}>{saving?"Geocoding…":"Save"}</button><button style={S.btnFlat} onClick={onCancel}>Cancel</button></div>
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
            {s.fromId&&<span style={{...S.tag,background:"#f0edfa",color:"#5b6abf"}}>from: {s.fromId==="homebase"?"🏠":s.fromId==="airport"?"✈️":""}{s.fromId==="homebase"?"Homebase":s.fromId==="airport"?"Airport":s.fromId.slice(0,8)}</span>}
            {s.arriveTime&&<span style={S.tag}>{fmt(s.arriveTime)}</span>}
            {s.arriveTime&&s.departTime&&<span style={{color:"#ccc",fontSize:11}}>→</span>}
            {s.departTime&&<span style={S.tag}>{fmt(s.departTime)}</span>}
          </div>
          {s.address&&<div style={S.stopAddr}>{s.address}</div>}
          {s.lat&&<div style={{fontSize:10,color:"#2a8f82",marginTop:2}}>📍 {s.lat}, {s.lng}</div>}
          {s.address&&!s.lat&&<div style={{fontSize:10,color:"#c45d3e",marginTop:2}}>⚠ No map pin — edit and re-geocode</div>}
          {s.notes&&<div style={S.stopNotes}>{s.notes}</div>}
        </div>
      </div>
    ))}
  </div>);
}

/* ════════════════════ HOME PAGE ════════════════════ */
/* ════════════════════ EXPORT MODAL ════════════════════ */
const ES = {
  title: "Itinerario para Conductor",
  day: "Día",
  pickup: "Recoger",
  dropoff: "Destino",
  time: "Hora",
  from: "Desde",
  transport: "Transporte",
  travelTime: "Tiempo de viaje",
  address: "Dirección",
  notes: "Notas",
  noTime: "Hora por confirmar",
  homebase: "Alojamiento",
  walk:"Caminando",bike:"Bicicleta",rental:"Auto rentado",taxi:"Taxi",scooter:"Scooter",colectivo:"Colectivo",
};
const EN = {
  title: "Driver Itinerary",
  day: "Day",
  pickup: "Pickup",
  dropoff: "Destination",
  time: "Time",
  from: "From",
  transport: "Transport",
  travelTime: "Travel time",
  address: "Address",
  notes: "Notes",
  noTime: "Time TBD",
  homebase: "Homebase",
  walk:"Walk",bike:"Bike",rental:"Rental Car",taxi:"Taxi",scooter:"Scooter",colectivo:"Colectivo",
};

function ExportModal({trip,onClose}){
  const[lang,setLang]=useState("en");
  const[selected,setSelected]=useState(()=>{
    // Default: all days selected, all stops selected
    const sel={};
    (trip.days||[]).forEach((d,di)=>{
      sel[`day-${di}`]=true;
      (d.stops||[]).forEach((s,si)=>{sel[`stop-${di}-${si}`]=true;});
    });
    return sel;
  });

  const t=lang==="es"?ES:EN;
  const tTransport=v=>t[v]||v;

  const toggleDay=(di)=>{
    const key=`day-${di}`;
    const on=!selected[key];
    const next={...selected,[key]:on};
    // Toggle all stops in this day
    (trip.days[di]?.stops||[]).forEach((_,si)=>{next[`stop-${di}-${si}`]=on;});
    setSelected(next);
  };

  const toggleStop=(di,si)=>{
    const key=`stop-${di}-${si}`;
    setSelected(p=>({...p,[key]:!p[key]}));
  };

  const selectAll=()=>{
    const sel={};
    (trip.days||[]).forEach((d,di)=>{
      sel[`day-${di}`]=true;
      (d.stops||[]).forEach((_,si)=>{sel[`stop-${di}-${si}`]=true;});
    });
    setSelected(sel);
  };

  const selectNone=()=>setSelected({});

  const generatePDF=()=>{
    const pdf=new jsPDF({orientation:"portrait",unit:"mm",format:"a4"});
    const W=210,M=15,CW=W-2*M;
    let y=M;

    const addText=(text,x,size,style,color)=>{
      pdf.setFontSize(size);pdf.setFont("helvetica",style||"normal");
      pdf.setTextColor(...(color||[30,30,30]));
      pdf.text(text,x,y);
    };

    const checkPage=(need)=>{if(y+need>280){pdf.addPage();y=M;}};

    // Header
    addText(t.title,M,20,"bold");
    y+=8;
    addText(trip.name||"Trip",M,14,"normal",[100,100,100]);
    y+=6;

    // Homebase info
    if(trip.homebase){
      const hbLabel=t.homebase;
      addText(`${hbLabel}: ${trip.homebase.name||""}`,M,10,"normal",[80,80,80]);
      y+=4;
      if(trip.homebase.address){addText(trip.homebase.address,M,9,"normal",[120,120,120]);y+=4;}
      y+=2;
    }

    // Divider
    pdf.setDrawColor(200,200,200);pdf.line(M,y,W-M,y);y+=6;

    // Days
    (trip.days||[]).forEach((day,di)=>{
      if(!selected[`day-${di}`])return;

      checkPage(20);

      // Day header
      const dateStr=day.date?new Date(day.date+"T12:00:00").toLocaleDateString(lang==="es"?"es-MX":"en-US",{weekday:"long",month:"long",day:"numeric"}):"";
      const hex=COLORS[di%COLORS.length];const rgb=[parseInt(hex.slice(1,3),16),parseInt(hex.slice(3,5),16),parseInt(hex.slice(5,7),16)];
      addText(`${t.day} ${di+1}: ${day.title}`,M,14,"bold",rgb);
      y+=5;
      if(dateStr){addText(dateStr,M,10,"normal",[100,100,100]);y+=5;}
      y+=2;

      // Stops
      const stops=day.stops||[];
      let stopNum=0;
      stops.forEach((stop,si)=>{
        if(!selected[`stop-${di}-${si}`])return;
        stopNum++;

        checkPage(28);

        // Stop number + name
        pdf.setFillColor(240,238,233);
        pdf.roundedRect(M,y-3,CW,24,2,2,"F");

        addText(`${stopNum}. ${stop.name||"Unnamed"}`,M+3,12,"bold");
        y+=5;

        // Time
        const timeStr=stop.arriveTime?fmt(stop.arriveTime):t.noTime;
        addText(`${t.time}: ${timeStr}${stop.departTime?` - ${fmt(stop.departTime)}`:""}`,M+3,10,"normal");
        y+=4;

        // From + transport
        const fromLabel=stop.fromId==="homebase"?`${trip.homebase?.name||t.homebase}`:stop.fromId==="airport"?"CUN Airport":si>0?stops[si-1]?.name||"":trip.homebase?.name||t.homebase;
        addText(`${t.from}: ${fromLabel}  ·  ${t.transport}: ${tTransport(stop.transport||"taxi")}`,M+3,9,"normal",[80,80,80]);
        y+=4;

        // Travel time
        if(stop.travelTime){addText(`${t.travelTime}: ${stop.travelTime}`,M+3,9,"normal",[80,80,80]);y+=4;}

        // Address
        if(stop.address){addText(`${t.address}: ${stop.address}`,M+3,9,"normal",[100,100,100]);y+=4;}

        // Notes
        if(stop.notes){
          const noteLines=pdf.splitTextToSize(`${t.notes}: ${stop.notes}`,CW-6);
          checkPage(noteLines.length*4+4);
          pdf.setFontSize(9);pdf.setFont("helvetica","italic");pdf.setTextColor(120,120,120);
          pdf.text(noteLines,M+3,y);
          y+=noteLines.length*4;
        }

        y+=6;
      });

      // Day divider
      checkPage(6);
      pdf.setDrawColor(220,220,220);pdf.line(M,y,W-M,y);y+=6;
    });

    // Footer
    checkPage(10);
    pdf.setFontSize(8);pdf.setFont("helvetica","normal");pdf.setTextColor(180,180,180);
    pdf.text(lang==="es"?"Generado por Tulum Trip Planner":"Generated by Tulum Trip Planner",M,y);

    pdf.save(`${trip.name||"trip"}-driver-itinerary.pdf`);
  };

  return(
    <div style={S.overlay} onClick={onClose}>
      <div style={S.exportModal} onClick={e=>e.stopPropagation()}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <h2 style={{margin:0,fontSize:18,fontWeight:700}}>📄 Export Driver Itinerary</h2>
          <button style={S.xBtn} onClick={onClose}>✕</button>
        </div>

        {/* Language toggle */}
        <div style={{display:"flex",gap:4,marginBottom:16}}>
          <button onClick={()=>setLang("en")} style={{...S.fBtn,...(lang==="en"?S.fBtnA:{})}}>🇺🇸 English</button>
          <button onClick={()=>setLang("es")} style={{...S.fBtn,...(lang==="es"?S.fBtnA:{})}}>🇲🇽 Español</button>
        </div>

        {/* Select all / none */}
        <div style={{display:"flex",gap:8,marginBottom:12}}>
          <button style={{...S.btnFlat,fontSize:11,padding:"4px 10px"}} onClick={selectAll}>Select all</button>
          <button style={{...S.btnFlat,fontSize:11,padding:"4px 10px"}} onClick={selectNone}>Select none</button>
        </div>

        {/* Day/stop selection */}
        <div style={{maxHeight:400,overflowY:"auto",marginBottom:16}}>
          {(trip.days||[]).map((day,di)=>(
            <div key={day.id||di} style={{marginBottom:8}}>
              <label style={S.exportDayLabel}>
                <input type="checkbox" checked={!!selected[`day-${di}`]} onChange={()=>toggleDay(di)} style={{marginRight:8}}/>
                <span style={{...S.exportDayDot,background:COLORS[di%COLORS.length]}}>{di+1}</span>
                <b>{day.title}</b>
                {day.date&&<span style={{color:"#aaa",marginLeft:6,fontWeight:400,fontSize:12}}>{fmtD(day.date)}</span>}
              </label>
              {selected[`day-${di}`]&&(day.stops||[]).map((stop,si)=>(
                <label key={stop.id||si} style={S.exportStopLabel}>
                  <input type="checkbox" checked={!!selected[`stop-${di}-${si}`]} onChange={()=>toggleStop(di,si)} style={{marginRight:8}}/>
                  <span>{sI(stop.type)} {stop.name||"Unnamed"}</span>
                  <span style={{color:"#aaa",fontSize:11,marginLeft:"auto"}}>{tI(stop.transport)} {stop.arriveTime?fmt(stop.arriveTime):""}</span>
                </label>
              ))}
            </div>
          ))}
        </div>

        {/* Preview count */}
        <div style={{fontSize:12,color:"#888",marginBottom:12}}>
          {(trip.days||[]).filter((_,di)=>selected[`day-${di}`]).length} days,{" "}
          {(trip.days||[]).reduce((a,d,di)=>a+(selected[`day-${di}`]?(d.stops||[]).filter((_,si)=>selected[`stop-${di}-${si}`]).length:0),0)} stops selected
          {lang==="es"&&" · Will be exported in Spanish"}
        </div>

        <button style={{...S.btnFill,width:"100%",padding:"12px",fontSize:14}} onClick={generatePDF}>
          📄 {lang==="es"?"Generar PDF":"Generate PDF"}
        </button>
      </div>
    </div>
  );
}

function HomePage(){
  const[myTrips,setMyTrips]=useState([]);
  const[loading,setLoading]=useState(true);
  const[creating,setCreating]=useState(false);
  const[newName,setNewName]=useState("Tulum Trip");
  const[createErr,setCreateErr]=useState("");

  // Load ALL trips from Firestore (real-time)
  useEffect(()=>{
    const q=query(collection(db,"trips"),orderBy("createdAt","desc"));
    const unsub=onSnapshot(q,snap=>{
      const trips=snap.docs.map(d=>({id:d.id,name:d.data().name||"Untitled",days:(d.data().days||[]).length,createdAt:d.data().createdAt}));
      console.log("[Firebase] Loaded",trips.length,"trips");
      setMyTrips(trips);
      setLoading(false);
    },err=>{
      console.error("[Firebase] Error loading trips:",err);
      setLoading(false);
    });
    return unsub;
  },[]);

  const createTrip=async()=>{
    setCreating(true);setCreateErr("");
    try{
      console.log("[Firebase] Creating trip...");
      const ref=await addDoc(collection(db,"trips"),{...BLANK_TRIP(newName),createdAt:Date.now()});
      console.log("[Firebase] Trip created:", ref.id);
      window.location.hash=`#/trip/${ref.id}`;
    }catch(e){
      console.error("[Firebase] Create error:",e);
      setCreateErr(`Failed: ${e.message}. Make sure Firestore rules allow writes.`);
    }
    setCreating(false);
  };

  const deleteTrip=async(e,id)=>{
    e.preventDefault();e.stopPropagation();
    if(!confirm("Delete this trip permanently?"))return;
    try{await deleteDoc(doc(db,"trips",id));console.log("[Firebase] Deleted trip:",id);}catch(err){console.error("Delete error:",err);}
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
        {createErr&&<div style={{...S.errBox,marginBottom:16}}>{createErr}</div>}
        {loading&&<div style={{textAlign:"center",padding:20,color:"#aaa"}}>Loading trips…</div>}
        {!loading&&myTrips.length>0&&<div style={S.homeLabel}>All Trips</div>}
        {myTrips.map(t=>(
          <a key={t.id} href={`#/trip/${t.id}`} style={S.homeTripCard}>
            <span style={{fontSize:20}}>🌴</span>
            <div style={{flex:1}}>
              <div style={{fontWeight:600,fontSize:14}}>{t.name}</div>
              <div style={{fontSize:11,color:"#aaa",marginTop:2}}>{t.days} day{t.days!==1&&"s"} · Click to open</div>
            </div>
            <button style={{...S.xBtn,fontSize:16}} onClick={e=>deleteTrip(e,t.id)}>×</button>
          </a>
        ))}
        {!loading&&myTrips.length===0&&<div style={{textAlign:"center",padding:20,color:"#aaa"}}>No trips yet — create one above</div>}
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
  const[syncErr,setSyncErr]=useState("");
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
  const[showLines,setShowLines]=useState(true);
  const[pinMode,setPinMode]=useState(false);
  const[showExport,setShowExport]=useState(false);
  const dayRefs=useRef({});
  const skipSync=useRef(false);
  const[sideW,setSideW]=useState(200);
  const dragging=useRef(false);

  // Sidebar resize
  useEffect(()=>{
    const onMove=e=>{if(!dragging.current)return;const w=Math.max(140,Math.min(400,e.clientX));setSideW(w);};
    const onUp=()=>{dragging.current=false;document.body.style.cursor="";document.body.style.userSelect="";};
    window.addEventListener("mousemove",onMove);
    window.addEventListener("mouseup",onUp);
    return()=>{window.removeEventListener("mousemove",onMove);window.removeEventListener("mouseup",onUp);};
  },[]);
  const startResize=()=>{dragging.current=true;document.body.style.cursor="col-resize";document.body.style.userSelect="none";};

  // Real-time listener
  useEffect(()=>{
    console.log("[Firebase] Subscribing to trip:", tripId);
    const unsub=onSnapshot(
      doc(db,"trips",tripId),
      snap=>{
        console.log("[Firebase] Snapshot received, exists:", snap.exists());
        if(snap.exists()){
          if(skipSync.current){skipSync.current=false;return;}
          setTrip(snap.data());
          setSyncErr("");
        } else {
          setTrip(null);
        }
        setLoading(false);
      },
      err=>{
        console.error("[Firebase] Listen error:", err);
        setSyncErr(`Firebase error: ${err.message}. Check Firestore rules — they must allow read/write.`);
        setLoading(false);
      }
    );
    return unsub;
  },[tripId]);

  // Write to Firestore
  const save=useCallback(async(newTrip)=>{
    setTrip(newTrip);
    skipSync.current=true;
    // Log what we're saving
    console.log("[Firebase] Saving trip. Homebase lat:", newTrip.homebase?.lat);
    (newTrip.days||[]).forEach((d,di)=>(d.stops||[]).forEach((s,si)=>console.log(`[Firebase] Day${di} Stop${si}: "${s.name}" lat=${s.lat} lng=${s.lng}`)));
    try{
      await setDoc(doc(db,"trips",tripId),newTrip);
      console.log("[Firebase] Saved successfully");
      setSyncErr("");
    }catch(e){
      console.error("[Firebase] Save error:",e);
      setSyncErr(`Save failed: ${e.message}. Check Firestore rules.`);
      skipSync.current=false;
    }
  },[tripId]);

  const up=fn=>{
    const c=JSON.parse(JSON.stringify(trip));fn(c);save(c);
  };

  const onMapClick=useCallback(ll=>{
    setCoordHint(ll);
    if(pinMode)setPinMode(false);
  },[pinMode]);
  const requestPin=()=>{setView("map");setPinMode(true);};

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
      `}</style>
      <header style={S.topBar}>
        <div style={S.topLeft}>
          <a href="#/" style={{textDecoration:"none",fontSize:20}}>🌴</a>
          <span style={S.topTitle}>{trip.name}</span>
          <span style={S.topSub}>{(trip.days||[]).length}d · {totalStops} stops</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <button style={{...S.btnFlat,fontSize:11,padding:"5px 12px"}} onClick={copyLink}>{copied?"✓ Copied!":"📋 Copy link"}</button>
          <button style={{...S.btnFlat,fontSize:11,padding:"5px 12px"}} onClick={()=>setShowExport(true)}>📄 Export</button>
          <div style={syncErr?S.errBadge:S.liveBadge}>{syncErr?"● Error":"● Live"}</div>
          <div style={S.tabRow}>
            {["plan","map"].map(v=>(<button key={v} onClick={()=>setView(v)} style={{...S.tab,...(view===v?S.tabActive:{})}}>{v==="plan"?"Itinerary":"Map"}</button>))}
          </div>
        </div>
      </header>
      {syncErr&&<div style={S.syncErrBar}>{syncErr}</div>}
      {showExport&&<ExportModal trip={trip} onClose={()=>setShowExport(false)}/>}
      <div style={S.body}>
        {/* RESIZABLE SIDEBAR */}
        <aside style={{...S.side,width:sideW}}>
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
        {/* DRAG HANDLE */}
        <div style={S.dragHandle} onMouseDown={startResize}><div style={S.dragLine}/></div>
        <main style={S.main}>
          {/* MAP — always mounted, toggled via display */}
          <div style={{flex:1,position:"relative",display:view==="map"?"flex":"none",flexDirection:"column"}}>
            <GMap trip={trip} activeDay={activeDay} onClickLatLng={onMapClick} visible={view==="map"} showLines={showLines} pinMode={pinMode}/>
            {pinMode&&<div style={S.pinBanner}>📌 Click anywhere on the map to place your pin</div>}
            <div style={S.mapFilter}>
              <button onClick={()=>setActiveDay(null)} style={{...S.fBtn,...(activeDay===null?S.fBtnA:{})}}>All</button>
              {(trip.days||[]).map((d,i)=>(<button key={d.id||i} onClick={()=>setActiveDay(activeDay===i?null:i)} style={{...S.fBtn,...(activeDay===i?{...S.fBtnA,background:COLORS[i%COLORS.length]}:{})}}>{d.title}</button>))}
              <button onClick={()=>setShowLines(!showLines)} style={{...S.fBtn,...(showLines?{background:"#1a1a1a",color:"#fff"}:{})}}>{showLines?"↗ Lines On":"↗ Lines Off"}</button>
            </div>
          </div>
          {/* PLAN */}
          {view==="plan"&&(
            <div style={S.planScroll}>
              <section style={S.ps}><div style={S.pl}>✈ Arrival</div>
                {(trip.arrivalFlights||[]).map((f,i)=>(<div key={f.id||i} style={S.fr}><span style={{fontSize:18}}>🛬</span><div style={{flex:1}}><div style={S.fn}>{f.airline} {f.flight}</div><div style={S.fm}>{fmtD(f.date)}{f.time&&` · ${fmt(f.time)}`}{f.airport&&` · ${f.airport}`}</div>{f.depCity&&<div style={S.frt}>{f.depAirport} ({f.depCity}) → {f.arrAirport} ({f.arrCity})</div>}</div><button style={S.xBtn} onClick={()=>{setEditFlightI(i);setAddFlight("arrival");}}>✎</button><button style={{...S.xBtn,color:"#b44"}} onClick={()=>delFlight("arrival",i)}>×</button></div>))}
                {addFlight==="arrival"&&<FlightForm initial={editFlightI!==null?(trip.arrivalFlights||[])[editFlightI]:null} onSave={f=>saveFlight("arrival",f)} onCancel={()=>{setAddFlight(null);setEditFlightI(null);}}/>}
                {!addFlight&&<button style={S.addBtn} onClick={()=>setAddFlight("arrival")}>+ Add arrival flight</button>}
              </section>
              {(trip.homebase||showHome)&&(<section style={S.ps}><div style={S.pl}>🏠 Homebase</div>
                {trip.homebase&&!showHome&&(<div style={S.hc}><div style={{flex:1}}><div style={S.hn}>{trip.homebase.name}</div>{trip.homebase.address&&<div style={S.hsub}>{trip.homebase.address}</div>}<div style={S.hm}>{trip.homebase.checkInDate&&<>In: {fmtD(trip.homebase.checkInDate)}{trip.homebase.checkInTime&&` ${fmt(trip.homebase.checkInTime)}`}</>}{trip.homebase.checkOutDate&&<> · Out: {fmtD(trip.homebase.checkOutDate)}{trip.homebase.checkOutTime&&` ${fmt(trip.homebase.checkOutTime)}`}</>}</div>{trip.homebase.lat&&<div style={S.coordBadge}>📍 {trip.homebase.lat}, {trip.homebase.lng}</div>}{trip.homebase.notes&&<div style={S.hnt}>{trip.homebase.notes}</div>}</div><button style={S.xBtn} onClick={()=>setShowHome(true)}>✎</button></div>)}
                {showHome&&<HomebaseForm initial={trip.homebase} coordHint={coordHint} onRequestPin={requestPin} onSave={h=>{up(t=>t.homebase=h);setShowHome(false);setCoordHint(null);}} onCancel={()=>{setShowHome(false);setCoordHint(null);}}/>}
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
                  {editStop?.di===di&&<div style={{padding:"0 16px 16px"}}><StopForm initial={stops[editStop.si]} coordHint={coordHint} onSave={s=>saveStopFn(di,s)} onCancel={()=>{setEditStop(null);setCoordHint(null);}} prevStop={getPrev(editStop.si)} homebase={trip.homebase} trip={trip} onRequestPin={requestPin}/></div>}
                  {addStopDay===di&&editStop?.di!==di&&<div style={{padding:"0 16px 16px"}}><StopForm coordHint={coordHint} onSave={s=>saveStopFn(di,s)} onCancel={()=>{setAddStopDay(null);setCoordHint(null);}} prevStop={stops[stops.length-1]||null} homebase={trip.homebase} trip={trip} onRequestPin={requestPin}/></div>}
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
  errBadge:{fontSize:10,color:"#c45d3e",fontWeight:600,background:"#fef0ec",padding:"3px 8px",borderRadius:10},
  syncErrBar:{background:"#fef0ec",color:"#c45d3e",padding:"8px 20px",fontSize:12,fontWeight:500,borderBottom:"1px solid #f5d5cc"},
  pinBanner:{position:"absolute",top:12,left:"50%",transform:"translateX(-50%)",background:"#1a1a1a",color:"#fff",padding:"8px 20px",borderRadius:20,fontSize:12,fontWeight:600,zIndex:1001,boxShadow:"0 2px 10px rgba(0,0,0,.2)",whiteSpace:"nowrap"},
  overlay:{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:2000},
  exportModal:{background:"#fff",borderRadius:14,padding:"24px",maxWidth:520,width:"90%",maxHeight:"85vh",overflow:"auto",boxShadow:"0 12px 40px rgba(0,0,0,.15)"},
  exportDayLabel:{display:"flex",alignItems:"center",gap:6,padding:"8px 0",fontSize:13,cursor:"pointer",borderBottom:"1px solid #f5f3ee"},
  exportDayDot:{width:20,height:20,borderRadius:"50%",color:"#fff",display:"inline-flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700,flexShrink:0},
  exportStopLabel:{display:"flex",alignItems:"center",gap:6,padding:"6px 0 6px 32px",fontSize:12,cursor:"pointer",color:"#444"},
  tabRow:{display:"flex",gap:2,background:"#f2f1ed",borderRadius:8,padding:3},
  tab:{padding:"5px 16px",border:"none",borderRadius:6,background:"transparent",fontSize:12,fontWeight:600,cursor:"pointer",color:"#888",fontFamily:"inherit"},
  tabActive:{background:"#fff",color:"#1a1a1a",boxShadow:"0 1px 3px rgba(0,0,0,.06)"},
  body:{display:"flex",flex:1,overflow:"hidden"},
  side:{borderRight:"none",background:"#fff",overflowY:"auto",padding:"8px 0",flexShrink:0},
  dragHandle:{width:6,cursor:"col-resize",background:"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,borderRight:"1px solid #e8e6e1",transition:"background .15s",position:"relative",zIndex:10},
  dragLine:{width:2,height:32,borderRadius:1,background:"#d4d0ca",transition:"background .15s"},
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
