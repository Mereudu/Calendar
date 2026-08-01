// ==UserScript==
// @name         EAM WO Calendar Planner - v1.0 Finale
// @namespace    https://w.amazon.com/
// @version      1.8.18
// @updateURL   https://raw.githubusercontent.com/Mereudu/Calendar/main/EAM_WO_Calendar_v1.0_Finale.user.js
// @downloadURL https://raw.githubusercontent.com/Mereudu/Calendar/main/EAM_WO_Calendar_v1.0_Finale.user.js
// @description  Versione finale veloce: calendario WO DVN3 con lettura diretta e parallela di Schedule Labor.
// @author       Aki (per mereudu / DVN3)
// @match        https://*.eam.hxgnsmartcloud.com/*
// @match        https://*.sso.eam.hxgnsmartcloud.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// ==/UserScript==

(() => {
'use strict';

const CFG = {
  baseUrl:         'https://eu1.eam.hxgnsmartcloud.com/web/base/',
  defaultOrg:      '',
  defaultAssigned: '',
  navTimeoutMs:    15000,
  gridTimeoutMs:   12000,
  scheduleCacheMs:  30*60*1000, // cache Schedule Labor
  directConcurrency: 3,          // limita il carico sul tenant EAM
  directTimeoutMs:   15000,
  categories: [
    { id:'PM',   types:['PM','PPM','PREV','PM1','PM2'], label:'Preventive Maintenance', color:'#0d2a4a', accent:'#3498db' },
    { id:'CM',   types:['CM','COR','CORR','REP','EM'],  label:'Corrective Maintenance', color:'#3a0e0e', accent:'#e74c3c' },
    { id:'PDM',  types:['PDM','PdM','PRED','CBM','CONDITION MONITORING'],      label:'Predictive Maintenance', color:'#2e2200', accent:'#f1c40f' },
    { id:'SC',   types:['SC','SYS','CHK','INS','SA'],   label:'System Check',           color:'#0d2e14', accent:'#27ae60' },
    { id:'OTHER',types:[],                               label:'Other Work Orders',      color:'#1e1a30', accent:'#9b59b6' },
  ],
  f: {
    num:'workordernum', desc:'description', start:'schedstartdate', end:'schedenddate',
    status:'workorderstatus',          // EAM usa workorderstatus (non status)
    statusDisp:'workorderstatus_display',
    equip:'equipment', equipDesc:'equipmentdesc', assigned:'assignedto',
    type:'workordertype_display',      // EAM usa workordertype_display (non workordertype)
    typeAlt:'workorderrtype',          // campo alternativo tipo WO
    org:'organization',
    priority:'criticality',            // EAM usa criticality (non priority)
    duration:'estduration', hours:'estimatedhours', schedHours:'scheduledhours', actualHours:'actualhours',
    location:'location', shift:'shift',  // turno assegnato al WO
  }
};

const pad     = n => String(n).padStart(2,'0');
const toEam   = d => `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()}`;
const iso     = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const delay   = ms => new Promise(r => setTimeout(r, ms));
const addDays = (d,n) => { const r=new Date(d); r.setDate(r.getDate()+n); return r; };
const esc     = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

// Operatori filtro EAM (stessi iconCls di APM Master)
const OP_GTE = 'fo_gte';   // >=
const OP_LTE = 'fo_lte';   // <=
const OP_EQ  = 'fo_eq';    // =
const OP_CON = 'fo_con';   // Contains

function fromEam(s) {
  if (!s) return null;
  if (s instanceof Date) return isNaN(s.getTime()) ? null : s;
  const str = String(s).trim();
  // XX/YY/YYYY — auto-detect MM/DD/YYYY vs DD/MM/YYYY
  // EAM Amazon tenant restituisce MM/DD/YYYY nel getData() della store
  let m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const a=+m[1], b=+m[2], y=+m[3];
    let month, day;
    if (b > 12)      { month=a; day=b; }   // b non puo' essere mese → MM/DD/YYYY
    else if (a > 12) { month=b; day=a; }   // a non puo' essere mese → DD/MM/YYYY
    else             { month=a; day=b; }   // ambiguo → assume MM/DD/YYYY (tenant Amazon)
    return new Date(y, month-1, day);
  }
  // YYYY-MM-DD
  m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(+m[1], +m[2]-1, +m[3]);
  // DD-MMM-YYYY (es. 27-JUL-2026)
  const MON={JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};
  m = str.match(/^(\d{1,2})-([A-Z]{3})-(\d{4})/i);
  if (m) { const mo=MON[(m[2]||'').toUpperCase()]; if(mo!==undefined) return new Date(+m[3],mo,+m[1]); }
  // Fallback nativo
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
function monday(d) {
  const r=new Date(d), wd=r.getDay();
  r.setDate(r.getDate()-wd); r.setHours(0,0,0,0); return r; // Amazon week: Dom-Sab
}

// ═══════════════════════════════════════════════════════════════════════════
//  EXTJS HELPERS  (adattato da APM Master)
// ═══════════════════════════════════════════════════════════════════════════

function getExtWindows() {
  const root = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  const wins = new Set();
  const gather = win => {
    try {
      if (!win) return;
      if (win.Ext) wins.add(win);
      for (let i=0; i<(win.frames||[]).length; i++) try{gather(win.frames[i]);}catch(_){}
    } catch(_) {}
  };
  try{ gather(root.top); }catch(_){}
  gather(root);
  return [...wins];
}

const _GENERIC = new Set(['BSSTRT','WSTABS','WSFLTR','GLOBAL','']);
function getWinUserFunc(win) {
  try{ const v=win.EAM?.AppData?.getAppData?.()?.initpath; if(v&&!_GENERIC.has(v)) return v; }catch(_){}
  try{ const v=win.EAM?.FocusManager?.activeView?.screen?.userFunction; if(v&&!_GENERIC.has(v)) return v; }catch(_){}
  try{ const v=new URLSearchParams(win.location.search).get('USER_FUNCTION_NAME'); if(v&&!_GENERIC.has(v)) return v; }catch(_){}
  return '';
}

function isFrameVisible(win) {
  try {
    if (win===window||win===window.top) return true;
    if (typeof unsafeWindow!=='undefined'&&win===unsafeWindow) return true;
    const pd=win.parent?.document; if(!pd) return true;
    for (const f of pd.querySelectorAll('iframe')) {
      try {
        if (f.contentWindow===win) {
          const s=pd.defaultView.getComputedStyle(f);
          if (s.display==='none'||s.visibility==='hidden') return false;
          const r=f.getBoundingClientRect(); return r.width>0&&r.height>0;
        }
      } catch(_){}
    }
    return true;
  } catch(_){ return true; }
}

function waitForAjax(win) {
  return new Promise(resolve => {
    const ext=win?.Ext;
    if (!ext?.Ajax) return resolve();
    if (!ext.Ajax.isLoading()) return resolve();
    const done = () => {
      if (!ext.Ajax.isLoading()) {
        ext.Ajax.un('requestcomplete',done); ext.Ajax.un('requestexception',done);
        setTimeout(resolve,150);
      }
    };
    ext.Ajax.on('requestcomplete',done); ext.Ajax.on('requestexception',done);
    setTimeout(()=>{ ext.Ajax.un('requestcomplete',done); ext.Ajax.un('requestexception',done); resolve(); },10000);
  });
}

// Come waitForAjax ma prima ATTENDE che una richiesta parta (isLoading()==true),
// fino a maxStartWait ms. Serve dopo il click Save: il commit AJAX puo' partire con
// un piccolo ritardo, e chiamare waitForAjax troppo presto uscirebbe subito lasciando
// il record non ancora salvato (problema visibile sull'ULTIMO WO, senza un WO
// successivo che forzi il flush). Se nessuna richiesta parte entro il timeout,
// prosegue (il save era sincrono o non necessario).
async function waitForAjaxSettled(win, maxStartWait) {
  const ext=win?.Ext;
  if(!ext?.Ajax) return;
  const step=40, cap=(typeof maxStartWait==='number')?maxStartWait:1200;
  let waited=0;
  while(waited<cap && !ext.Ajax.isLoading()){ await delay(step); waited+=step; }
  await waitForAjax(win);
}

// --- DIAGNOSTICA v1.7.8 (SOLO LOG, nessun cambio di comportamento) ---------
// Installa listener sugli eventi Ext.Ajax della finestra indicata per loggare
// OGNI richiesta HTTP reale che EAM fa (beforerequest/requestcomplete/requestexception),
// con timestamp assoluto (performance.now()) per poterla correlare con i log
// '[WOCal] move ...' e '[WOCal-DIAG] click ...' gia' presenti nel codice.
// Serve a rispondere alla domanda: il detail-save e il grid-save fanno DAVVERO
// due richieste AJAX distinte al server, o uno dei due e' solo un'attesa a vuoto?
// Idempotente: usa un flag sull'istanza Ext.Ajax per non attaccare piu' listener
// alla stessa finestra.
function installAjaxDiag(win) {
  try {
    const ajax = win?.Ext?.Ajax;
    if (!ajax || ajax.__wocalDiagInstalled) return;
    ajax.__wocalDiagInstalled = true;
    ajax.on('beforerequest', function(conn, opts) {
      try { console.log('[WOCal-AJAX] -> ' + (opts?.method || 'GET') + ' ' + (opts?.url || '') + ' @' + Math.round(performance.now())); } catch (_) {}
    });
    ajax.on('requestcomplete', function(conn, resp, opts) {
      try { console.log('[WOCal-AJAX] <- OK  ' + (opts?.method || 'GET') + ' ' + (opts?.url || '') + ' @' + Math.round(performance.now()) + ' status=' + (resp && resp.status)); } catch (_) {}
    });
    ajax.on('requestexception', function(conn, resp, opts) {
      try { console.log('[WOCal-AJAX] <- ERR ' + (opts?.method || 'GET') + ' ' + (opts?.url || '') + ' @' + Math.round(performance.now()) + ' status=' + (resp && resp.status)); } catch (_) {}
    });
  } catch (_) {}
}

// Logga l'identita' del pulsante Save trovato da findSaveControl: se detailSave e
// gridSave loggano id/itemId DIVERSI, sono due bottoni/finestre distinti (non lo
// stesso oggetto riusato) -> utile per capire se il grid-save agisce davvero in un
// contesto diverso da quello del detail-save.
function logButtonIdentity(sc, tag) {
  try {
    if (!sc) { console.log('[WOCal-DIAG] btn '+tag+': (nessun bottone trovato)'); return; }
    const b = sc.btn;
    console.log('[WOCal-DIAG] btn '+tag+': ' + JSON.stringify({
      id: b?.id || null, itemId: b?.itemId || null, action: b?.action || null,
      text: b?.text || null, ownerCtType: b?.ownerCt?.xtype || null,
      domBtnId: sc.domBtn?.id || null
    }));
  } catch (_) {}
}
// Logga i record "dirty" (non salvati) presenti negli store delle griglie Ext aperte.
// Risponde alla domanda: dopo il detail-save, il record del WO e' ancora sporco nello
// store della lista? Se si', spiega perche' serve un secondo salvataggio a prescindere
// dal fatto che generi o no una nuova richiesta AJAX.
function logDirtyStores(tag) {
  try {
    for (const win of getExtWindows()) {
      const grids = win.Ext?.ComponentQuery?.query('gridpanel:not([destroyed=true])') || [];
      for (const g of grids) {
        const st = g.getStore?.();
        if (!st) continue;
        const mod = (st.getModifiedRecords && st.getModifiedRecords()) || [];
        if (mod.length) {
          console.log('[WOCal-DIAG] dirty store ('+tag+') storeId=' + (st.storeId || g.itemId) +
            ' count=' + mod.length + ' records=' + JSON.stringify(mod.map(function(r) {
              return { internalId: r.internalId, dirty: r.dirty, modified: Object.keys(r.modified || {}) };
            })));
        }
      }
    }
  } catch (_) {}
}
// --- FINE DIAGNOSTICA v1.7.8/v1.7.9 ----------------------------------------


function setExtField(targetExt, names, value, operatorClass) {
  if (value===undefined||value===null) return;
  const list=Array.isArray(names)?names:[names];
  let cmp=null;
  for (const name of list) {
    const f=targetExt.ComponentQuery.query(`[name=${name}]:not([destroyed=true])`);
    if (f?.length){cmp=f[0];break;}
  }
  if (!cmp) return false;
  if (value==='') {
    cmp.setValue(''); cmp.fireEvent('change',cmp,''); cmp.fireEvent('blur',cmp); return true;
  }
  cmp.setValue(value); cmp.fireEvent('change',cmp,value); cmp.fireEvent('blur',cmp);
  // Imposta l'operatore (>=, <=, Contains, ecc.) come fa APM Master
  if (operatorClass) {
    try {
      const el = cmp.getEl();
      const parentWrap = el.up('.x-box-inner') || el.up('.x-column-header-inner') || el.up('.x-container');
      if (parentWrap) {
        let triggerBtnEl = parentWrap.down('.uft-id-btnfilteroperator') || parentWrap.down('.x-btn-icon-el-gridfilter-small');
        if (triggerBtnEl && triggerBtnEl.hasCls('x-btn-icon-el-gridfilter-small')) triggerBtnEl = triggerBtnEl.up('.x-btn');
        if (triggerBtnEl) {
          const opBtn = targetExt.getCmp(triggerBtnEl.id);
          if (opBtn && !opBtn.isDestroyed && opBtn.menu?.items?.items) {
            const item = opBtn.menu.items.items.find(i => i && !i.isDestroyed && i.iconCls===operatorClass);
            if (item) { if(item.handler) item.handler.call(item.scope||item,item); else item.fireEvent('click',item); }
          }
        }
      }
    } catch(_) {}
  }
  return true;
}

function clearExtField(targetExt, names) {
  const list=Array.isArray(names)?names:[names];
  for (const name of list) {
    const f=targetExt.ComponentQuery.query(`[name=${name}]:not([destroyed=true])`);
    if (f?.length){f[0].setValue('');f[0].fireEvent('change',f[0],'');f[0].fireEvent('blur',f[0]);break;}
  }
}

function findWsJobsTarget() {
  for (const win of getExtWindows()) {
    try {
      if (!win.Ext?.ComponentQuery) continue;
      const func=getWinUserFunc(win);
      if (func&&func!=='WSJOBS') continue;
      if (!isFrameVisible(win)) continue;
      const grids=win.Ext.ComponentQuery.query('gridpanel:not([destroyed=true])');
      const ok=grids.some(g => {
        if (!g.rendered||!g.getStore) return false;
        const store=g.getStore(); if(!store) return false;
        if (!func) { const sid=(store.storeId||'').toLowerCase(); return sid.includes('wsjobs'); }
        return true;
      });
      if (ok) return { ext:win.Ext, win };
    } catch(_) {}
  }
  return null;
}

async function waitForWsJobsGrid(maxMs) {
  const step=350;
  for (let e=0; e<maxMs; e+=step) {
    const t=findWsJobsTarget(); if(t) return t;
    await delay(step);
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  NAVIGAZIONE AUTOMATICA  (adattato da APM Master)
// ═══════════════════════════════════════════════════════════════════════════

function launchScreenDirect(win, target) {
  try {
    const nav=win.EAM?.Nav;
    if (!nav||typeof nav.launchScreen!=='function') return false;
    nav.launchScreen(`${target}?USER_FUNCTION_NAME=${target}&FUNCTION_CLASS=WEBL`, null, {fromNav:true});
    return true;
  } catch(_){ return false; }
}

async function navigateToWsJobs() {
  // 1. Tab "Work Orders" gia' aperto
  for (const win of getExtWindows()) {
    try {
      if (!win.Ext?.ComponentQuery) continue;
      const tabs=win.Ext.ComponentQuery.query('tab:not([hidden=true]):not([destroyed=true])');
      const tab=tabs.find(t=>(t.text||'').replace(/<[^>]*>/g,'').trim()==='Work Orders');
      if (tab) { if(tab.el?.dom) tab.el.dom.click(); else tab.fireEvent('click',tab); return; }
    } catch(_) {}
  }
  // 2. EAM.Nav.launchScreen (piu' veloce)
  for (const win of getExtWindows()) {
    try { if(launchScreenDirect(win,'WSJOBS')){ await delay(1500); return; } } catch(_) {}
  }
  // 3. Menu Work > Work Orders
  for (const win of getExtWindows()) {
    try {
      if (!win.Ext?.ComponentQuery) continue;
      const btns=win.Ext.ComponentQuery.query('button');
      const wb=btns.find(b=>!b.hidden&&b.showMenu&&(b.text||'').trim()==='Work');
      if (wb?.el?.dom) {
        wb.el.dom.click(); await delay(300);
        const items=win.Ext.ComponentQuery.query('menuitem');
        const woi=items.find(i=>!i.hidden&&(i.text||'').includes('Work Orders'));
        if (woi) { if(woi.handler) woi.handler.call(woi.scope||woi,woi); else woi.fireEvent('click',woi); return; }
      }
    } catch(_) {}
  }
}

async function returnToListView(allowLaunch=true) {
  let targetExt=null, targetWin=null;
  for (const win of getExtWindows()) {
    try {
      if (!win.Ext?.ComponentQuery) continue;
      const func=getWinUserFunc(win);
      if (func==='WSJOBS'){targetExt=win.Ext;targetWin=win;break;}
      if (!func) {
        const grids=win.Ext.ComponentQuery.query('gridpanel:not([destroyed=true])');
        if (grids.some(g=>(g.getStore?.()?.storeId||'').toLowerCase().includes('wsjobs'))){
          targetExt=win.Ext; targetWin=win; break;
        }
      }
    } catch(_) {}
  }
  if (!targetExt) targetExt=window.Ext;
  if (!targetExt?.ComponentQuery) return;

  // Strategia 1: listdetailview.setActiveItem
  try {
    const ldvs=targetExt.ComponentQuery.query('listdetailview:not([destroyed=true])');
    for (const ldv of ldvs) {
      if (!ldv||ldv.isDestroyed||!ldv.rendered) continue;
      const layout=ldv.getLayout();
      if (layout&&typeof layout.setActiveItem==='function') {
        const items=ldv.items?.items||[];
        const idx=items.findIndex(i=>i.down?.('gridpanel')||i.xtype==='gridpanel');
        if (idx>=0){layout.setActiveItem(idx);return;}
      }
      for (const m of ['showList','showGrid','expandList','collapseRight']) {
        if (typeof ldv[m]==='function'){ldv[m]();return;}
      }
    }
  } catch(_) {}

  // Strategia 2: bottoni/tab "List View"
  const queries=["button[cls~=uftid-collapseright]",'button[tooltip*="Expand Right"]','tab[text="List View"]','button[ariaLabel="List View"]'];
  for (const q of queries) {
    try {
      const els=targetExt.ComponentQuery.query(q);
      for (const el of els) {
        if (el.hidden||el.isHidden?.()) continue;
        if (el.handler){el.handler.call(el.scope||el,el);return;}
        else if (el.isTab){const tp=el.up('tabpanel');if(tp)tp.setActiveTab(el);else el.fireEvent('click',el);return;}
        else{el.fireEvent('click',el);return;}
      }
    } catch(_) {}
  }
  if (allowLaunch&&targetWin&&launchScreenDirect(targetWin,'WSJOBS')) await delay(1500);
}

// ═══════════════════════════════════════════════════════════════════════════
//  FETCH WO — navigazione auto + filtri + lettura store
// ═══════════════════════════════════════════════════════════════════════════
async function fetchWOs(startD, endD, org, assigned) {
  // STEP 1 — Naviga a Work Orders se non gia' visibile
  sendStatus('Navigando a Work Orders...', '');
  let target=findWsJobsTarget();
  if (!target) {
    await navigateToWsJobs();
    await delay(800);
    target=await waitForWsJobsGrid(CFG.navTimeoutMs);
  }
  if (!target) throw new Error('GRID_NOT_FOUND');

  // STEP 2 — Torna alla lista (esce da record singolo se aperto)
  sendStatus('Verificando vista lista...', '');
  await returnToListView();
  await delay(400);
  await waitForAjax(target.win);
  target=findWsJobsTarget()||target;
  const { ext:targetExt, win:targetWin }=target;

  // STEP 3 — Pulisci campi e imposta filtri data settimana
  sendStatus('Impostando filtri...', `Start >= ${toEam(startD)} (settimana ${toEam(startD)} - ${toEam(endD)})`);
  clearExtField(targetExt,['ff_schedstartdate','ff_startdate']);
  clearExtField(targetExt,['ff_schedenddate','ff_enddate']);
  clearExtField(targetExt,'ff_workordernum');
  clearExtField(targetExt,'ff_description');
  clearExtField(targetExt,'ff_organization');
  await delay(100);
  // Filtro settimana: start>=inizio E end<=fine settimana (esattamente 7 giorni, nessun buffer).
  // Il moveWo (v1.8.10) impone MAX_SPAN_DAYS=1, quindi un WO spostato con questo tool non avra' mai
  // end oltre la fine settimana salvo il caso Start=Domenica->End=Lunedi succ. (accettato dall'utente).
  setExtField(targetExt,['ff_schedstartdate','ff_startdate'],toEam(startD), OP_GTE);
  setExtField(targetExt,['ff_schedenddate','ff_enddate'],  toEam(endD),   OP_LTE);
  if (org) {
    const orgApplied=setExtField(targetExt,'ff_organization',org,String(org).toUpperCase()==='DVN3'?OP_EQ:OP_CON);
    // Fail closed: non eseguire mai una ricerca non filtrata se il campo Organization manca.
    if (!orgApplied) throw new Error('ORG_FILTER_NOT_FOUND');
  }

  // STEP 4 — Clicca Run (come APM: handler poi fireEvent)
  // Intercetta i parametri REALI della richiesta AJAX generata dal Run (contengono i filtri:
  // date, organizzazione, stato...), servono poi per riusarli identici in paginazione CACHE.
  sendStatus('Eseguendo ricerca WO...', '');
  let capturedRunParams=null, capturedRunUrl=null;
  const origAjaxRequest = targetWin.Ext.Ajax.request;
  targetWin.Ext.Ajax.request = function(cfg){
    try {
      if (cfg && cfg.url && /xmlhttp/i.test(cfg.url) && !capturedRunParams) {
        capturedRunParams = { ...(cfg.params||{}) };
        capturedRunUrl = cfg.url;
      }
    } catch(_) {}
    return origAjaxRequest.apply(this, arguments);
  };
  const runBtns=targetExt.ComponentQuery.query("button[text=Run]:not([destroyed=true])");
  if (!runBtns?.length) { targetWin.Ext.Ajax.request=origAjaxRequest; throw new Error('RUN_BUTTON_NOT_FOUND'); }
  const runBtn=runBtns[0];
  if (runBtn.handler) runBtn.handler.call(runBtn.scope||runBtn,runBtn);
  else runBtn.fireEvent('click',runBtn);

  // STEP 5 — Aspetta completamento query EAM
  await delay(500);
  await waitForAjax(targetWin);
  targetWin.Ext.Ajax.request = origAjaxRequest; // ripristina, capture fatta

  // STEP 6 — Trova la store WSJOBS e carica TUTTI i record (paginazione EAM = 50/volta)
  sendStatus('Leggendo Work Orders...', '');
  const records=[];
  let wsGrid=null;
  for (const g of targetExt.ComponentQuery.query('gridpanel:not([destroyed=true])')) {
    try {
      if (!g.rendered||!g.getStore) continue;
      const store=g.getStore(); if(!store) continue;
      const func=getWinUserFunc(targetWin);
      if (!func && !(store.storeId||'').toLowerCase().includes('wsjobs')) continue;
      wsGrid=g; break;
    } catch(_) {}
  }
  if (wsGrid) {
    const store=wsGrid.getStore();
    const proxy=store.getProxy?.();
    const isReadonly=(wsGrid.id||'').includes('readonlygrid');

    // Helper: eamid/tenant — letti dopo ogni risposta (proxy.reader aggiornato dal Run)
    const getEamid = () =>
      proxy?.getReader?.()?.rawData?.eamid ||
      proxy?.reader?.rawData?.eamid ||
      proxy?.extraParams?.eamid ||
      Session.eamid || '';
    const getTenant = () =>
      proxy?.getReader?.()?.rawData?.tenant ||
      proxy?.reader?.rawData?.tenant ||
      proxy?.extraParams?.tenant ||
      Session.tenant || 'AMAZONRMENA_PRD';

    // Rileva se il server segnala altri record (MORERECORDPRESENT="+") — logica APM Master
    const morePresent = (rawData) => {
      if (!rawData) return false;
      try {
        if (rawData.nodeType || (typeof rawData==='string'&&rawData.includes('<?xml'))) {
          const doc = typeof rawData==='string'
            ? new DOMParser().parseFromString(rawData,'text/xml') : rawData;
          const meta = doc.querySelector?.('METADATA')||doc;
          return meta.getAttribute?.('MORERECORDPRESENT')==='+' ||
                 meta.querySelector?.('MORERECORDPRESENT')?.textContent==='+';
        }
        const d = rawData?.pageData?.grid?.GRIDRESULT?.GRID?.METADATA ||
                  rawData?.GRIDRESULT?.GRID?.METADATA ||
                  rawData?.METADATA || rawData;
        return d.MORERECORDPRESENT==='+' || d.MORERECORDPRESENT==='Y';
      } catch(_){ return false; }
    };

    // Estrae rawData dalla operation callback (come fa APM Master)
    const getRawData = (op) => {
      try {
        return op?.getResultSet?.()?.rawData ||
               op?.request?.proxy?.getReader?.()?.rawData ||
               op?.response?.responseXML ||
               (()=>{ try{return JSON.parse(op?.response?.responseText||'');}catch(_){return null;} })() ||
               proxy?.getReader?.()?.rawData;
      } catch(_){ return null; }
    };

    // Raccoglie prima pagina (gia' in store dopo Run)
    store.each(rec=>{ try{records.push(rec.getData());}catch(_){} });
    sendStatus('Caricando WO...', `${records.length} caricati`);
    console.log('[WOCal] Prima pagina:', records.length, '| eamid:', getEamid()||'(non ancora)', '| isReadonly:', isReadonly);

    // Caricamento tramite la UI nativa: porta realmente il viewport della grid in fondo,
    // attende l'eventuale lazy-load EAM e accumula i WO senza duplicati. Se la grid usa
    // pagine tradizionali, usa come fallback il suo pulsante Next nativo.
    const MAX_STEPS=40, WAIT_AFTER_SCROLL=900;
    const byWo=new Map();
    const collectStore=()=>{
      let added=0;
      store.each(rec=>{
        try {
          const d=rec.getData();
          const key=String(d[CFG.f.num]||rec.getId?.()||JSON.stringify(d));
          if(!byWo.has(key)){byWo.set(key,d);added++;}
          else byWo.set(key,d);
        } catch(_) {}
      });
      return added;
    };
    collectStore();

    const view=wsGrid.getView?.();
    const findScroller=()=>{
      const root=view?.getEl?.()?.dom || view?.el?.dom || wsGrid.getEl?.()?.dom;
      if(!root) return null;
      const nodes=[root,...root.querySelectorAll('*')];
      let best=null, bestRange=0;
      for(const el of nodes){
        const range=(el.scrollHeight||0)-(el.clientHeight||0);
        if(range>bestRange){bestRange=range;best=el;}
      }
      return bestRange>0?best:root;
    };
    const scrollBottom=()=>{
      let moved=false;
      try {
        const scrollable=view?.getScrollable?.() || wsGrid.getScrollable?.();
        if(scrollable?.scrollTo){scrollable.scrollTo(null,1e9,false);moved=true;}
      } catch(_) {}
      try { if(view?.scrollBy){view.scrollBy(0,1e9,false);moved=true;} } catch(_) {}
      const el=findScroller();
      if(el){
        try {
          el.scrollTop=el.scrollHeight;
          el.dispatchEvent(new targetWin.Event('scroll',{bubbles:true}));
          el.dispatchEvent(new targetWin.WheelEvent('wheel',{deltaY:10000,bubbles:true}));
          moved=true;
        } catch(_) {}
      }
      return {moved,el};
    };
    const clickNativeNext=()=>{
      try {
        const bars=targetExt.ComponentQuery.query('pagingtoolbar:not([destroyed=true])');
        for(const bar of bars){
          if(bar.getStore?.()!==store) continue;
          const next=bar.down?.('#next') || bar.down?.('button[itemId=next]') ||
            bar.down?.('button[tooltip*=Next]');
          if(next && !next.disabled){next.handler?next.handler.call(next.scope||next,next):next.fireEvent('click',next);return true;}
        }
      } catch(_) {}
      return false;
    };

    let stagnant=0, steps=0;
    while(steps<MAX_STEPS && stagnant<3){
      steps++;
      const before=byWo.size;
      const beforeCount=store.getCount?.()||0;
      const {moved,el}=scrollBottom();
      await delay(WAIT_AFTER_SCROLL);
      await waitForAjax(targetWin);
      let added=collectStore();

      // Se lo scroll non ha caricato nulla, prova una sola azione nativa Next.
      let usedNext=false;
      if(!added){
        usedNext=clickNativeNext();
        if(usedNext){await delay(500);await waitForAjax(targetWin);added=collectStore();}
      }

      console.log('[WOCal] UI-load step',steps,{
        moved, usedNext, storeBefore:beforeCount, storeNow:store.getCount?.()||0,
        added, total:byWo.size, scrollTop:el?.scrollTop, scrollHeight:el?.scrollHeight
      });
      if(byWo.size>before){
        stagnant=0;
        sendStatus('Caricando WO...',`${byWo.size} caricati`);
      } else stagnant++;
    }

    records.length=0;
    records.push(...byWo.values());
    console.log('[WOCal] ✓ Totale finale:',records.length,'| passaggi UI:',steps,'| stop inattivi:',stagnant);
  }

  // STEP 7 — Filtra per tecnico lato client
  if (assigned) {
    const aUp=assigned.toUpperCase();
    return records.filter(w=>(w[CFG.f.assigned]||'').toUpperCase().includes(aUp));
  }
  return records;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SCHEDULE LABOR — apre ogni WO filtrato e legge i tre totali dalla scheda
// ═══════════════════════════════════════════════════════════════════════════════

const SCHEDULE_CACHE_KEY='wocal_schedule_hours_final_v1';

function parseEamNumber(raw) {
  if (raw===null||raw===undefined||String(raw).trim()==='') return null;
  const text=String(raw).trim().replace(/\s/g,'');
  const normalized=text.includes(',')
    ? text.replace(/\./g,'').replace(',','.')
    : text.replace(/,(?=\d{3}(\D|$))/g,'');
  const value=parseFloat(normalized);
  return Number.isFinite(value)&&value>=0?value:null;
}

function loadScheduleCache() {
  try { const v=GM_getValue(SCHEDULE_CACHE_KEY,{}); return v&&typeof v==='object'?v:{}; }
  catch(_){ return {}; }
}
function saveScheduleCache(cache) { try { GM_setValue(SCHEDULE_CACHE_KEY,cache); } catch(_){} }
function mergeScheduleHours(wo,hours) {
  if(!hours) return;
  // Non sovrascrivere un dato gia' valido nella lista WSJOBS con un campo vuoto letto dal form:
  // Schedule Labor a volte non ha ancora Sched/Actual popolati anche se la grid li conosce.
  const empty=v=>v===null||v===undefined||v==='';
  if(Number.isFinite(hours.estimated)&&empty(wo[CFG.f.hours])) wo[CFG.f.hours]=hours.estimated;
  if(Number.isFinite(hours.scheduled)&&empty(wo[CFG.f.schedHours])) wo[CFG.f.schedHours]=hours.scheduled;
  if(Number.isFinite(hours.actual)&&empty(wo[CFG.f.actualHours])) wo[CFG.f.actualHours]=hours.actual;
}

function visibleComponent(c) {
  try {
    if(c.isDestroyed||c.rendered===false||c.hidden||c.isHidden?.()) return false;
    const el=c.getEl?.();
    if(el?.isVisible && !el.isVisible(true)) return false;
    const dom=el?.dom;
    if(dom && dom.offsetParent===null && dom.getClientRects?.().length===0) return false;
    return true;
  } catch(_){ return false; }
}
function cleanLabel(value) { return String(value||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim(); }
function normLabel(value) { return cleanLabel(value).toLowerCase().replace(/[^a-z0-9]/g,''); }

function currentRecordMatches(woNum) {
  const wanted=String(woNum).trim();
  for(const win of getExtWindows()){
    try {
      if(!win.Ext?.ComponentQuery) continue;
      const fields=win.Ext.ComponentQuery.query('field[name=workordernum]:not([destroyed=true])');
      if(fields.some(f=>visibleComponent(f)&&String(f.getValue?.()||'').trim()===wanted)) return true;
      const inputs=[...win.document.querySelectorAll('input[name="workordernum"],input[id*="workordernum"]')];
      if(inputs.some(i=>i.offsetParent!==null&&String(i.value||'').trim()===wanted)) return true;
    } catch(_) {}
  }
  return false;
}

async function waitForRecordMatch(woNum,maxMs) {
  for(let waited=0;waited<maxMs;waited+=250){
    if(currentRecordMatches(woNum)){await delay(250);return true;}
    await delay(250);
  }
  return false;
}

async function openWoRecord(woNum) {
  const wanted=String(woNum).trim();

  const tryFromActiveGrid=async(attempt)=>{
    const target=findWsJobsTarget();
    if(!target) return false;
    const {ext:Ext,win}=target;
    const candidates=[];

    for(const grid of Ext.ComponentQuery.query('gridpanel:not([destroyed=true])')){
      try {
        if(!visibleComponent(grid)) continue;
        const store=grid.getStore?.();
        const view=grid.getView?.();
        if(!store||!view||!visibleComponent(view)) continue;
        let rec=null;
        store.each?.(r=>{
          if(String(r.get?.(CFG.f.num)||'').trim()===wanted){rec=r;return false;}
          return true;
        });
        if(!rec) continue;
        const storeId=String(store.storeId||'').toLowerCase();
        const score=(storeId.includes('wsjobs')?4:0)+
          (String(grid.id||'').includes('readonlygrid')?2:0)+
          (grid.getEl?.()?.isVisible?.(true)?2:0);
        candidates.push({grid,store,view,rec,score});
      } catch(_) {}
    }

    candidates.sort((a,b)=>b.score-a.score);
    const hit=candidates[0];
    if(!hit){
      console.warn('[WOCal] WO non trovato nella grid WSJOBS visibile:',wanted);
      return false;
    }

    const {grid,store,view,rec}=hit;
    const idx=store.indexOf?.(rec)??-1;
    if(idx<0) return false;
    grid.getSelectionModel?.()?.select?.(rec);

    // Porta la riga nel viewport. Le grid buffered di EAM non hanno un nodo DOM
    // finche' la riga non viene renderizzata, quindi attendiamo fino a 2 secondi.
    try {
      const buffered=grid.findPlugin?.('bufferedrenderer')||view.bufferedRenderer;
      if(buffered?.scrollTo) buffered.scrollTo(idx,false);
      else if(view.ensureVisible) view.ensureVisible(idx);
      else view.focusRow?.(rec);
    } catch(_) { try { view.focusRow?.(rec); } catch(__) {} }

    let row=null;
    for(let waited=0;waited<2000;waited+=100){
      row=view.getNode?.(rec)||view.getNode?.(idx)||view.getRow?.(idx)||null;
      if(row) break;
      await delay(100);
    }
    if(!row){
      console.warn('[WOCal] Riga WO non renderizzata nella grid visibile:',wanted);
      return false;
    }

    console.log(`[WOCal] Apertura WO via grid itemdblclick (tentativo ${attempt}):`,wanted);
    view.fireEvent('itemdblclick',view,rec,row,idx,{});
    return await waitForRecordMatch(wanted,6000);
  };

  for(let attempt=1;attempt<=2;attempt++){
    if(await tryFromActiveGrid(attempt)) return true;
    if(attempt<2){
      await returnToListView(false);
      await delay(700);
    }
  }

  // Nessun fallback EAM.Nav.goTo: nel tenant Amazon genera un iframe non valido.
  return false;
}

function activateScheduleLaborTab() {
  const wanted='schedule labor';
  for(const win of getExtWindows()){
    try {
      const Ext=win.Ext; if(!Ext?.ComponentQuery) continue;
      const tabs=Ext.ComponentQuery.query('tab:not([destroyed=true])');
      const tab=tabs.find(t=>cleanLabel(t.text||t.title).toLowerCase()===wanted);
      if(tab){
        const panel=tab.tabBar?.up?.('tabpanel')||tab.up?.('tabpanel');
        const card=tab.card||panel?.items?.items?.find(x=>cleanLabel(x.title||x.text).toLowerCase()===wanted);
        if(panel&&card) panel.setActiveTab(card);
        else if(tab.el?.dom) tab.el.dom.click();
        else tab.fireEvent?.('click',tab);
        return win;
      }
      const candidates=[
        ...Ext.ComponentQuery.query('menuitem:not([destroyed=true])'),
        ...Ext.ComponentQuery.query('button:not([destroyed=true])')
      ];
      const item=candidates.find(x=>cleanLabel(x.text||x.tooltip||x.title).toLowerCase()===wanted);
      if(item){
        if(item.handler)item.handler.call(item.scope||item,item);
        else if(item.el?.dom)item.el.dom.click();
        else item.fireEvent?.('click',item);
        return win;
      }
      const dom=[...win.document.querySelectorAll('.x-tab,[role="tab"],.x-menu-item,.x-btn')]
        .find(el=>cleanLabel(el.textContent).toLowerCase()===wanted);
      if(dom){dom.click();return win;}
    } catch(_) {}
  }
  return null;
}

function readScheduleLaborTotals() {
  const result={estimated:null,scheduled:null,actual:null}, found={estimated:false,scheduled:false,actual:false};
  const classify=label=>{
    const n=normLabel(label);
    if(n.includes('woesthours')||n.includes('woestimatedhours')) return 'estimated';
    if(n.includes('woschedhours')||n.includes('woscheduledhours')) return 'scheduled';
    if(n.includes('woactualhours')) return 'actual';
    return '';
  };
  for(const win of getExtWindows()){
    try {
      if(!win.Ext?.ComponentQuery) continue;
      const fields=win.Ext.ComponentQuery.query('field:not([destroyed=true])');
      for(const field of fields){
        if(!visibleComponent(field)) continue;
        const label=[field.fieldLabel,field.label,field.boxLabel,field.name,field.itemId].filter(Boolean).join(' ');
        const kind=classify(label); if(!kind||found[kind]) continue;
        const value=parseEamNumber(field.getValue?.());
        if(value!==null){result[kind]=value;found[kind]=true;}
      }
      for(const labelEl of win.document.querySelectorAll('label,.x-form-item-label,.x-form-item-label-text')){
        const kind=classify(labelEl.textContent); if(!kind||found[kind]) continue;
        const wrap=labelEl.closest('.x-form-item')||labelEl.parentElement;
        const input=wrap?.querySelector('input,textarea');
        const value=parseEamNumber(input?.value??'');
        if(value!==null){result[kind]=value;found[kind]=true;}
      }
    } catch(_) {}
  }
  return {ok:found.estimated&&found.scheduled,hours:result,found};
}

async function inspectScheduleLabor(woNum) {
  if(!await openWoRecord(woNum)) return {ok:false,error:'record_not_opened'};
  const tabWin=activateScheduleLaborTab();
  if(!tabWin) return {ok:false,error:'schedule_tab_not_found'};
  await delay(350); await waitForAjax(tabWin); await delay(250);
  for(let waited=0;waited<CFG.gridTimeoutMs;waited+=250){
    const read=readScheduleLaborTotals();
    if(read.ok) return {ok:true,hours:read.hours};
    await delay(250);
  }
  const read=readScheduleLaborTotals();
  return {ok:read.ok,hours:read.hours,error:read.ok?'':'hour_fields_not_found',found:read.found};
}

async function syncScheduleLaborUI(wos,org) {
  const list=wos||[], site=String(org||'').trim().toUpperCase();
  const stats={total:list.length,loaded:0,cached:0,failed:0,skipped:false,errors:[]};
  if(!site){stats.skipped=true;console.warn('[WOCal] Schedule Labor non sincronizzato: selezionare un sito.');return stats;}
  const cache=loadScheduleCache(), now=Date.now();
  let consecutiveNavigationFailures=0;
  for(let i=0;i<list.length;i++){
    const wo=list[i], num=String(wo[CFG.f.num]||'').trim();
    if(!num){stats.failed++;continue;}
    const key=`${site}|${num}`, cached=cache[key];
    if(cached&&now-cached.ts<CFG.scheduleCacheMs){
      mergeScheduleHours(wo,cached); stats.cached++;
      sendStatus('Schedule Labor',`${i+1}/${list.length} · WO ${num} · cache`);
      continue;
    }
    sendStatus('Lettura Schedule Labor',`${i+1}/${list.length} · WO ${num}`);

    // itemdblclick funziona soltanto dalla List View: dopo ogni lettura il Record View
    // resta aperto, quindi riattiviamo esplicitamente la lista senza rilanciare WSJOBS.
    // Guard: se dopo il tentativo la grid WSJOBS non e' davvero visibile, non ha senso
    // tentare itemdblclick (fallirebbe comunque) — segnaliamo l'errore e passiamo al prossimo WO.
    await returnToListView(false);
    await delay(500);
    if(!findWsJobsTarget()){
      stats.failed++;
      stats.errors.push({wo:num,error:'list_view_not_active'});
      console.warn('[WOCal] Schedule Labor non letto',num,{ok:false,error:'list_view_not_active'});
      consecutiveNavigationFailures++;
      if(consecutiveNavigationFailures>=2){
        stats.failed+=list.length-i-1;
        stats.errors.push({error:'sync_aborted_navigation',remaining:list.length-i-1});
        break;
      }
      continue;
    }
    const result=await inspectScheduleLabor(num);

    if(result.ok){
      const entry={...result.hours,ts:Date.now()};
      mergeScheduleHours(wo,entry); cache[key]=entry; stats.loaded++;
      consecutiveNavigationFailures=0; saveScheduleCache(cache);
    } else {
      stats.failed++;stats.errors.push({wo:num,error:result.error,found:result.found});
      if(result.error==='record_not_opened') consecutiveNavigationFailures++; else consecutiveNavigationFailures=0;
      console.warn('[WOCal] Schedule Labor non letto',num,result);
      if(consecutiveNavigationFailures>=2){
        stats.failed+=list.length-i-1;
        stats.errors.push({error:'sync_aborted_navigation',remaining:list.length-i-1});
        break;
      }
    }
  }
  try { await returnToListView(); } catch(_) {}
  console.log('[WOCal] Schedule Labor sync:',stats);
  return stats;
}


// Lettura veloce diretta dello stesso servizio usato dal tab Schedule Labor.
// La UI sequenziale rimane disponibile come fallback soltanto per le richieste fallite.
function getLiveEamSession() {
  let eamid='',tenant='',requestWin=null;
  const target=findWsJobsTarget();
  const wins=target?[target.win,...getExtWindows()]:getExtWindows();
  for(const win of wins){
    try {
      const storage=win?.EAM?.SessionStorage;
      const appStorage=win?.EAM?.getApplication?.()?.sessionStorage;
      if(!eamid) eamid=String(storage?.getEamId?.()||storage?.get?.('eamid')||appStorage?.get?.('eamid')||'');
      if(!tenant) tenant=String(storage?.getTenant?.()||storage?.get?.('tenant')||appStorage?.get?.('tenant')||'');
      if(!requestWin&&typeof win?.fetch==='function') requestWin=win;
      if(eamid&&tenant&&requestWin) break;
    } catch(_) {}
  }
  eamid=eamid||Session.eamid||'';
  tenant=tenant||Session.tenant||'AMAZONRMENA_PRD';
  requestWin=requestWin||target?.win||((typeof unsafeWindow!=='undefined')?unsafeWindow:window);
  return {eamid,tenant,requestWin};
}

function parseEamJson(text) {
  const raw=String(text||'');
  if(/^\s*<!doctype|<html/i.test(raw)) throw new Error('SESSION_EXPIRED');
  const first=raw.indexOf('{'),last=raw.lastIndexOf('}');
  if(first<0||last<first) throw new Error('MALFORMED_RESPONSE');
  return JSON.parse(raw.slice(first,last+1));
}

function asArray(value) {
  if(Array.isArray(value)) return value;
  return value&&typeof value==='object'?[value]:[];
}

async function fetchScheduleLaborDirect(wo,org) {
  const num=String(wo?.[CFG.f.num]||'').trim();
  if(!num) throw new Error('missing_wo_number');
  const {eamid,tenant,requestWin}=getLiveEamSession();
  if(!eamid) throw new Error('missing_eam_session');

  const base=new URL('/web/base/',requestWin.location.href).href;
  const endpoint=new URL('WSJOBS.SCH',base).href;
  const params=new URLSearchParams({
    GRID_ID:'205',GRID_NAME:'WSJOBS_SCH',DATASPY_ID:'209',
    USER_FUNCTION_NAME:'WSJOBS',SYSTEM_FUNCTION_NAME:'WSJOBS',CURRENT_TAB_NAME:'SCH',
    eamid,tenant,MAX_ROWS:'5000',NUMBER_OF_ROWS_FIRST_RETURNED:'5000',FORCE_REQUERY:'YES',
    workordernum:num,organization:String(org||''),workorderrtype:String(wo?.[CFG.f.typeAlt]||'')
  });

  const AbortCtor=requestWin.AbortController||AbortController;
  const controller=new AbortCtor();
  const timer=setTimeout(()=>controller.abort(),CFG.directTimeoutMs);
  let response;
  try {
    response=await requestWin.fetch(endpoint,{
      method:'POST',credentials:'include',signal:controller.signal,
      headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8','X-Requested-With':'XMLHttpRequest'},
      body:params.toString()
    });
  } finally { clearTimeout(timer); }
  if(!response.ok) throw new Error(`http_${response.status}`);

  const json=parseEamJson(await response.text());
  if(json?.pageData?.success===false){
    const msg=json?.pageData?.messages?.[0]?.msg||'eam_query_failed';
    throw new Error(msg);
  }
  const grid=json?.pageData?.grid?.GRIDRESULT?.GRID||{};
  const records=asArray(grid.DATA);
  const values=json?.pageData?.values||{};
  const sum=(field)=>records.reduce((total,row)=>{
    const value=parseEamNumber(row?.[field]);
    return total+(Number.isFinite(value)?value:0);
  },0);

  const activityEstimated=records.length?sum('actesthours'):null;
  const activityActual=records.length?sum('actactualhours'):null;
  const woEstimated=parseEamNumber(values.woesthours);
  const woScheduled=parseEamNumber(values.woschedhours??values.woscheduledhours);
  const woActual=parseEamNumber(values.woactualhours);
  // FIX#2: woScheduled è il campo pianificato reale; activityEstimated è stime per attività → usalo solo come ultimo fallback
  const scheduled=Number.isFinite(woScheduled)?woScheduled:
    Number.isFinite(woEstimated)?woEstimated:Number.isFinite(activityEstimated)?activityEstimated:0;
  const estimated=Number.isFinite(woEstimated)?woEstimated:scheduled;
  const actual=Number.isFinite(activityActual)?activityActual:Number.isFinite(woActual)?woActual:0;
  return {estimated,scheduled,actual,activityCount:records.length};
}

async function fetchScheduleLaborDirectWithRetry(wo,org) {
  let lastError=null;
  for(let attempt=1;attempt<=2;attempt++){
    try { return await fetchScheduleLaborDirect(wo,org); }
    catch(err){
      lastError=err;
      if(attempt<2) await delay(300*attempt);
    }
  }
  throw lastError||new Error('direct_query_failed');
}

async function syncScheduleLabor(wos,org) {
  const list=wos||[],site=String(org||'').trim().toUpperCase();
  const stats={total:list.length,loaded:0,cached:0,failed:0,skipped:false,direct:0,uiFallback:0,errors:[]};
  if(!site){stats.skipped=true;console.warn('[WOCal] Schedule Labor non sincronizzato: selezionare un sito.');return stats;}

  const cache=loadScheduleCache(),now=Date.now(),pending=[];
  for(const wo of list){
    const num=String(wo?.[CFG.f.num]||'').trim();
    if(!num){stats.failed++;stats.errors.push({error:'missing_wo_number'});continue;}
    const key=`${site}|${num}`,cached=cache[key];
    if(cached&&now-cached.ts<CFG.scheduleCacheMs){mergeScheduleHours(wo,cached);stats.cached++;}
    else pending.push({wo,num,key});
  }

  let cursor=0,completed=stats.cached;
  const failedDirect=[];
  const worker=async()=>{
    while(true){
      const index=cursor++;
      if(index>=pending.length) return;
      const item=pending[index];
      sendStatus('Schedule Labor veloce',`${completed+1}/${list.length} · WO ${item.num}`);
      try {
        const hours=await fetchScheduleLaborDirectWithRetry(item.wo,site);
        const entry={...hours,ts:Date.now()};
        mergeScheduleHours(item.wo,entry);cache[item.key]=entry;
        stats.loaded++;stats.direct++;saveScheduleCache(cache);
      } catch(err){
        failedDirect.push({...item,err});
        console.warn('[WOCal] Query diretta Schedule Labor fallita',item.num,err?.message||err);
      } finally {completed++;}
    }
  };
  const workerCount=Math.min(CFG.directConcurrency,pending.length);
  await Promise.all(Array.from({length:workerCount},()=>worker()));

  if(failedDirect.length){
    // FIX#9: se la sessione è scaduta la UI non funzionerà — abortire subito
    const sessionExpired=failedDirect.some(x=>x.err?.message==='SESSION_EXPIRED');
    if(sessionExpired){
      console.error('[WOCal] Sessione EAM scaduta — fallback UI annullato. Ricaricare la pagina.');
      stats.failed+=failedDirect.length;
      stats.errors.push({error:'SESSION_EXPIRED',count:failedDirect.length});
    } else {
    console.warn(`[WOCal] Fallback UI per ${failedDirect.length} WO non letti direttamente.`);
    sendStatus('Fallback Schedule Labor',`${failedDirect.length} WO via interfaccia EAM`);
    const fallback=await syncScheduleLaborUI(failedDirect.map(x=>x.wo),site);
    stats.loaded+=fallback.loaded;
    stats.cached+=fallback.cached;
    stats.uiFallback=fallback.loaded+fallback.cached;
    stats.failed+=fallback.failed;
    stats.errors.push(...fallback.errors);
    } // end else (session not expired)
  }

  console.log('[WOCal] Schedule Labor sync veloce:',stats);
  return stats;
}

// ═══════════════════════════════════════════════════════════════════════════
//  BULK ASSIGNMENT — Lista tecnici RME DVN3 (fissa, editabile qui)
//  WSSHIF non è interrogabile da questo account, quindi niente auto-roster:
//  i codici sotto vengono comunque validati da EAM al momento della scrittura.
//  Per aggiungere/rimuovere un tecnico: modifica l'array e bumpa @version.
// ═══════════════════════════════════════════════════════════════════════════
const TECNICI_RME = [
  { code:'ALEXZALO', name:'Alex Zalomir' },
  { code:'NOCERICI', name:'Ciro Nocerino' },
  { code:'MEREUDU',  name:'Dumitru Mereuta' },
  { code:'SGRILLOS', name:'Simone Grillo' },
  { code:'MATTZANN', name:'Matteo Zannin' },
  { code:'PROANOGH', name:'Hugo W. Proano Guascal' },
  { code:'XMENO',    name:'Mattia Solimeno', senior:true },
];

function getTechnicians() { return TECNICI_RME.map(t=>({ ...t, code:String(t.code||'').trim().toUpperCase() })); }

// Test da console: window.__wocalTech() → elenca i tecnici configurati.
{
  try {
    (typeof unsafeWindow!=='undefined'?unsafeWindow:window).__wocalTech=()=>{
      const list=getTechnicians();
      console.table(list);
      return list;
    };
  } catch(_) {}
}

// ═══════════════════════════════════════════════════════════════════════════
//  BULK ASSIGNMENT — Fase 2a: scrittura assignedto via form record (una WO)
//  Approccio sicuro (come "Assign To Me" di APM): apre il record, imposta il
//  campo assignedto, salva col pulsante nativo EAM, verifica, torna alla lista.
//  NESSUNA scrittura silenziosa: chiamata esplicita per singola WO.
// ═══════════════════════════════════════════════════════════════════════════

function findAssignedField() {
  for(const win of getExtWindows()){
    try{
      if(!win.Ext?.ComponentQuery) continue;
      for(const f of win.Ext.ComponentQuery.query('field:not([destroyed=true])')){
        if(!visibleComponent(f)) continue;
        const id=String(f.name||f.dataIndex||f.itemId||'').toLowerCase();
        if(id==='assignedto') return {field:f,win};
      }
    }catch(_){}
  }
  return null;
}

// WO Execution: campo LOV interno udfchar13. Default EXDN = "Executed during normal
// operation time (no shutdown required)". Compilato SOLO se vuoto (come APM Assign To Me).
const EXEC_FIELD='udfchar13';
const EXEC_DEFAULT='EXDN';
// Fallback quando il tipo WO non rientra in PM/CM/PDM/SC: mai lasciare vuoto (richiesta utente 2026-07-27).
const EXEC_FALLBACK='EXMW';
// Safety related (udfchar24): sempre 'No' se vuoto (richiesta utente 2026-07-27).
const SAFETY_FIELD='udfchar24';
const SAFETY_VALUE='No';

// Cerca un field ExtJS visibile per name/dataIndex/itemId (match lowercase).
function findFieldByName(name){
  const want=String(name||'').toLowerCase();
  for(const win of getExtWindows()){
    try{
      if(!win.Ext?.ComponentQuery) continue;
      for(const f of win.Ext.ComponentQuery.query('field:not([destroyed=true])')){
        if(!visibleComponent(f)) continue;
        const id=String(f.name||f.dataIndex||f.itemId||'').toLowerCase();
        if(id===want) return {field:f,win};
      }
    }catch(_){}
  }
  return null;
}

// Regola WO Execution per categoria WO (richiesta utente 2026-07-27):
//  Preventive/Corrective/Predictive -> EXMW ; System Check -> EXDN ; Other -> nessun autofill.
const EXEC_BY_CATEGORY={ PM:'EXMW', CM:'EXMW', PDM:'EXMW', SC:'EXDN' };

// Categoria a partire dal codice/etichetta tipo WO (stessa logica di categorize(), robusta
// sia al codice 'PM' sia all'etichetta 'Preventive...' grazie a startsWith).
function categoryForType(typeStr){
  const s=String(typeStr||'').trim().toUpperCase();
  if(!s) return '';
  for(const cat of CFG.categories){
    if(!cat.types.length) continue;
    if(cat.types.some(x=>{const u=String(x).toUpperCase();return s===u||s.startsWith(u);})) return cat.id;
  }
  return 'OTHER';
}

// Legge il tipo WO dal record aperto (prova codice, poi display).
function readWoTypeFromRecord(){
  for(const nm of ['workordertype','workordertype_display','workorderrtype']){
    const ff=findFieldByName(nm);
    if(ff){
      const v=String(ff.field.getValue?.()||'').trim() || String(ff.field.getRawValue?.()||'').trim();
      if(v) return v;
    }
  }
  return '';
}

// Codice Execution da applicare al record aperto in base al tipo WO.
// PM/CM/PDM -> EXMW, SC -> EXDN, tutto il resto (Other/tipo ignoto) -> EXMW (mai vuoto).
function execCodeForOpenRecord(){
  return EXEC_BY_CATEGORY[categoryForType(readWoTypeFromRecord())]||EXEC_FALLBACK;
}

function findSaveControl() {
  for(const win of getExtWindows()){
    try{
      if(!win.Ext?.ComponentQuery) continue;
      for(const b of win.Ext.ComponentQuery.query('button:not([destroyed=true])')){
        if(!visibleComponent(b)) continue;
        const act=String(b.action||'').toLowerCase();
        const iid=String(b.itemId||b.id||'').toLowerCase();
        if(act==='saverec'||act==='saverecord'||act==='save'||iid.includes('saverec')) return {btn:b,win};
      }
      const dom=win.document.querySelector('button[action=saveRec],button[action=saverecord],button.uft-id-saverec');
      if(dom) return {domBtn:dom,win};
    }catch(_){}
  }
  return null;
}

// Click FISICO sul pulsante Save (floppy "Save Record (Ctrl+S)").
// Replica la pressione reale del pulsante con la sequenza mousedown->mouseup->click,
// così EAM committa il record e non lascia lo stato dirty che blocca l'apertura
// di altri WO. Fallback all'handler interno solo se il click fisico non e' possibile.
function pressButton(el){
  if(!el) return false;
  try{
    const win=el.ownerDocument&&el.ownerDocument.defaultView;
    const opt={bubbles:true,cancelable:true,view:win||window};
    try{ el.focus&&el.focus(); }catch(_){}
    ['mousedown','mouseup','click'].forEach(function(t){
      try{ el.dispatchEvent(new MouseEvent(t,opt)); }catch(_){ try{ if(t==='click') el.click(); }catch(__){} }
    });
    return true;
  }catch(_){ try{ el.click(); return true; }catch(__){ return false; } }
}
function clickSaveControl(sc) {
  if(sc.btn){
    const b=sc.btn;
    // Elemento DOM cliccabile del bottone Ext (prova btnEl, poi el)
    const el=(b.btnEl&&b.btnEl.dom)||(b.el&&b.el.dom)||null;
    if(el && pressButton(el)) return true;
    // Fallback: handler interno di Ext
    if(typeof b.handler==='function'){ b.handler.call(b.scope||b,b); return true; }
    if(b.fireHandler){ b.fireHandler(); return true; }
    b.fireEvent?.('click',b); return true;
  }
  if(sc.domBtn){ return pressButton(sc.domBtn); }
  return false;
}

// Preme il Save nella LIST VIEW (griglia con tutti i WO). Da chiamare UNA volta a fine
// Apply: dopo aver salvato ogni record, committa/rinfresca la lista cosi le righe non
// mostrano piu valori vecchi in cache. Torna prima alla lista, poi click fisico + attesa commit.
async function saveGridView(skipReturn) {
  const _sg0=performance.now();
  // skipReturn: chiamato dal loop Apply dove moveWo e' GIA' tornato in lista ->
  // evita un secondo returnToListView + delay ridondanti (risparmio ~0.5-1s/WO).
  if(!skipReturn){ try{ await returnToListView(); }catch(_){} await delay(300); }
  else { await delay(120); }
  const sc=findSaveControl();
  if(!sc){ console.log('[WOCal] Save griglia: pulsante Save non trovato nel contesto lista'); return false; }
  installAjaxDiag(sc.win);
  logButtonIdentity(sc,'gridSave');
  logDirtyStores('pre-gridSave');

  // v1.8.2: la diagnostica v1.7.8/9 ha provato che la vera scrittura al server e' SEMPRE
  // 'WSJOBS.HDR?pageaction=SAVE'. Invece di aspettare genericamente "che il traffico AJAX
  // si calmi" (waitForAjaxSettled, che puo' confondersi con poll di sfondo di EAM, es. le
  // GRIDDATA periodiche viste nei log accanto a "Should be protected"), installiamo un
  // listener mirato SOLO su quella richiesta: sappiamo esattamente quando parte, quando
  // finisce, e quando il traffico collegato al nostro click e' tornato a zero.
  const ajax = sc.win?.Ext?.Ajax;
  let saveStarted=false, saveDone=false, saveError=false, pendingCount=0, totalRequests=0;
  const MAX_WAIT_SAVE=12000; // cap assoluto di sicurezza sul completamento del SAVE
  const onBefore = (conn, opts) => { pendingCount++; totalRequests++; if(String(opts?.url||'').includes('pageaction=SAVE')) saveStarted=true; };
  const onComplete = (conn, resp, opts) => { pendingCount--; if(String(opts?.url||'').includes('pageaction=SAVE')) saveDone=true; };
  const onException = (conn, resp, opts) => { pendingCount--; if(String(opts?.url||'').includes('pageaction=SAVE')){ saveDone=true; saveError=true; } };
  if(ajax){ ajax.on('beforerequest',onBefore); ajax.on('requestcomplete',onComplete); ajax.on('requestexception',onException); }

  console.log('[WOCal-DIAG] click gridSave @'+Math.round(performance.now()));
  const okc=clickSaveControl(sc);
  // Il Save puo' aprire dialog di conferma (es. "Activity dates outside range") che BLOCCANO
  // la richiesta AJAX finche' non si conferma: prima gestiamo i dialog in cascata (Yes/Continue),
  // POI attendiamo il commit reale. Esce subito se non c'e' alcun dialog.
  const sgConfRe=/^(ok|chiudi|close|yes|si|continua|continue|proceed|procedi|conferma|confirm|salva|save)$/i;
  for(let k=0;k<12;k++){
    await delay(180);
    let dlgs; try{ dlgs=scanEamDialogs(); }catch(_){ dlgs=[]; }
    if(dlgs&&dlgs.length){
      const d=dlgs.find(x=>x.buttons.length)||dlgs[0];
      const b=d.buttons.find(x=>btnMatches(x,sgConfRe))||d.buttons[0];
      if(b) clickDialogBtn(b);
      continue;
    }
    break;
  }

  // Attesa mirata: Fase1 aspetta che il SAVE parta (max 800ms, spesso e' gia' partito
  // durante il loop dialog sopra, l'evento e' asincrono e non serve stare "in ascolto attivo").
  const _t0=performance.now();
  while(!saveStarted && (performance.now()-_t0)<800){ await delay(30); }
  if(saveStarted){
    // Fase2: aspetta che il SAVE completi davvero (con cap di sicurezza assoluto).
    while(!saveDone && (performance.now()-_t0)<MAX_WAIT_SAVE){ await delay(40); }
    // Fase3: aspetta che il traffico collegato (refresh GRIDDATA post-save) torni a zero.
    const _pt0=performance.now();
    while(pendingCount>0 && (performance.now()-_pt0)<2000){ await delay(40); }
  } else {
    console.log('[WOCal] gridSave: nessun SAVE AJAX partito in 800ms -> no-op (niente da salvare)');
  }
  if(ajax){ try{ajax.un('beforerequest',onBefore);}catch(_){} try{ajax.un('requestcomplete',onComplete);}catch(_){} try{ajax.un('requestexception',onException);}catch(_){} }

  await delay(100);
  try{ const d2=scanEamDialogs(); if(d2.length){ const dd=d2.find(x=>x.buttons.length)||d2[0]; const bb=dd.buttons.find(x=>btnMatches(x,sgConfRe))||dd.buttons[0]; if(bb) clickDialogBtn(bb); } }catch(_){}
  logDirtyStores('post-gridSave');
  console.log('[WOCal] Save griglia eseguito ok='+okc+' ('+Math.round(performance.now()-_sg0)+'ms) ajax='+totalRequests+' saveOk='+(saveStarted&&saveDone&&!saveError));
  return okc;
}

// Restituisce i nomi dei campi (diversi da 'field') che hanno modifiche non salvate
// nella stessa finestra/record. Usato per evitare che il Save nativo committi
// modifiche estranee non volute dall'utente insieme ad assignedto.
function getDirtyFieldsExcept(win, field) {
  const dirty=[];
  try{
    if(!win?.Ext?.ComponentQuery) return dirty;
    for(const f of win.Ext.ComponentQuery.query('field:not([destroyed=true])')){
      if(f===field) continue;
      if(!visibleComponent(f)) continue;
      // I campi read-only/disabled (es. Activity date protette, "Should be protected")
      // non sono committabili dal Save, quindi non contano come modifiche estranee:
      // vanno esclusi per evitare falsi positivi di form_has_other_dirty_fields.
      if(f.readOnly||f.disabled) continue;
      try{
        if(typeof f.isDirty==='function' && f.isDirty()){
          const id=String(f.name||f.dataIndex||f.itemId||'').toLowerCase();
          dirty.push(id||'(campo senza nome)');
        }
      }catch(_){}
    }
  }catch(_){}
  return dirty;
}

// Dry-run: apre la WO, riporta il valore attuale di assignedto, NON salva.
async function previewAssign(woNum) {
  const num=String(woNum||'').trim();
  if(!await openWoRecord(num)) return {ok:false,error:'record_not_opened'};
  await delay(400);
  const fh=findAssignedField();
  const sc=findSaveControl();
  const ef=findFieldByName(EXEC_FIELD);
  const info={
    ok:!!fh, wo:num,
    current: fh?String(fh.field.getValue?.()||'').trim():null,
    editable: fh?!(fh.field.readOnly||fh.field.disabled):null,
    saveButtonFound: !!sc,
    execCurrent: ef?String(ef.field.getValue?.()||'').trim():null,
    execEditable: ef?!(ef.field.readOnly||ef.field.disabled):null,
    woType: readWoTypeFromRecord(),
    execWouldSet: execCodeForOpenRecord(),
    safetyCurrent: (()=>{ const s2=findFieldByName(SAFETY_FIELD); return s2?String(s2.field.getValue?.()||'').trim():null; })(),
    safetyWouldSet: SAFETY_VALUE
  };
  try{ await returnToListView(); }catch(_){}
  return info;
}

// Scrittura reale su una WO. Imposta assignedto e salva. Ritorna esito verificato.
async function assignWo(woNum, techCode) {
  const num=String(woNum||'').trim();
  const code=String(techCode||'').trim().toUpperCase();
  if(!num) return {ok:false,wo:num,error:'missing_wo'};
  if(!code) return {ok:false,wo:num,error:'missing_tech_code'};

  if(!await openWoRecord(num)) return {ok:false,wo:num,error:'record_not_opened'};
  await delay(400);

  const fh=findAssignedField();
  if(!fh){ try{await returnToListView();}catch(_){}; return {ok:false,wo:num,error:'assignedto_field_not_found'}; }
  const field=fh.field;
  const before=String(field.getValue?.()||'').trim();
  if(before.toUpperCase()===code){ try{await returnToListView();}catch(_){}; return {ok:true,wo:num,already:true,before,after:before}; }
  if(field.readOnly||field.disabled){ try{await returnToListView();}catch(_){}; return {ok:false,wo:num,error:'assignedto_readonly',before}; }

  // FIX ALTA 1: rivalida che il record aperto sia ancora quello richiesto,
  // immediatamente prima di scrivere (potrebbe essere cambiato durante l'attesa).
  if(!currentRecordMatches(num)){ try{await returnToListView();}catch(_){}; return {ok:false,wo:num,error:'record_mismatch_before_write'}; }

  // FIX ALTA 2: il Save nativo EAM commette l'intero form, non solo assignedto.
  // Se ci sono altri campi modificati e non salvati, abortiamo per non scrivere
  // dati estranei senza consenso esplicito dell'utente.
  const dirtyOthers=getDirtyFieldsExcept(fh.win,field);
  if(dirtyOthers.length){ try{await returnToListView();}catch(_){}; return {ok:false,wo:num,error:'form_has_other_dirty_fields',dirtyFields:dirtyOthers}; }

  try{
    field.suspendEvents?.();
    field.setValue?.(code);
    field.resumeEvents?.();
    field.fireEvent?.('change',field,code,before);
    field.fireEvent?.('blur',field);
  }catch(err){ try{await returnToListView();}catch(_){}; return {ok:false,wo:num,error:'set_value_failed',detail:err?.message||String(err),before}; }
  await delay(500);

  // Riempi WO Execution (udfchar13) SOLO se vuoto, mai sovrascrivere. Codice per categoria (EXMW/EXDN), fallback EXMW. Salvato con assignedto.
  let execResult=null;
  try{
    const ef=findFieldByName(EXEC_FIELD);
    if(ef){
      const execBefore=String(ef.field.getValue?.()||'').trim();
      if(execBefore){ execResult={already:execBefore}; }
      else if(ef.field.readOnly||ef.field.disabled){ execResult={skipped:'readonly'}; }
      else {
        const execCode=execCodeForOpenRecord();
        if(!execCode){ execResult={skipped:'no_rule_for_type'}; }
        else {
          ef.field.suspendEvents?.();
          ef.field.setValue?.(execCode);
          ef.field.resumeEvents?.();
          ef.field.fireEvent?.('change',ef.field,execCode,execBefore);
          ef.field.fireEvent?.('blur',ef.field);
          execResult={set:execCode};
          await delay(300);
        }
      }
    }
  }catch(_){}

  // Riempi Safety related (udfchar24) con 'No' SOLO se vuoto, mai sovrascrivere. Salvato con assignedto.
  let safetyResult=null;
  try{
    const sf=findFieldByName(SAFETY_FIELD);
    if(sf){
      const safBefore=String(sf.field.getValue?.()||'').trim();
      if(safBefore){ safetyResult={already:safBefore}; }
      else if(sf.field.readOnly||sf.field.disabled){ safetyResult={skipped:'readonly'}; }
      else {
        sf.field.suspendEvents?.();
        sf.field.setValue?.(SAFETY_VALUE);
        sf.field.resumeEvents?.();
        sf.field.fireEvent?.('change',sf.field,SAFETY_VALUE,safBefore);
        sf.field.fireEvent?.('blur',sf.field);
        safetyResult={set:SAFETY_VALUE};
        await delay(300);
      }
    }
  }catch(_){}

  const sc=findSaveControl();
  if(!sc){ try{await returnToListView();}catch(_){}; return {ok:false,wo:num,error:'save_button_not_found',before,set:code}; }
  if(!clickSaveControl(sc)){ try{await returnToListView();}catch(_){}; return {ok:false,wo:num,error:'save_click_failed',before,set:code}; }

  // Attende e verifica: rilegge il campo; successo se ora vale il codice impostato.
  let after=before;
  for(let waited=0;waited<6000;waited+=300){
    await delay(300);
    const again=findAssignedField();
    if(again){ after=String(again.field.getValue?.()||'').trim(); if(after.toUpperCase()===code) break; }
  }
  const ok=after.toUpperCase()===code;
  try{ await returnToListView(); }catch(_){}
  return ok?{ok:true,wo:num,before,after,exec:execResult,safety:safetyResult,sched:slResult}:{ok:false,wo:num,error:'save_not_confirmed',before,after,set:code,exec:execResult,safety:safetyResult,sched:slResult};
}

// Standalone: riempie WO Execution (udfchar13) SOLO se vuoto, con codice per categoria (fallback EXMW).
// forceCode opzionale per forzare un codice specifico. Non tocca assignedto.
async function fillExecIfEmpty(woNum, forceCode){
  const num=String(woNum||'').trim();
  if(!num) return {ok:false,wo:num,error:'missing_wo'};
  if(!await openWoRecord(num)) return {ok:false,wo:num,error:'record_not_opened'};
  await delay(400);
  if(!currentRecordMatches(num)){ try{await returnToListView();}catch(_){}; return {ok:false,wo:num,error:'record_mismatch_before_write'}; }
  const ef=findFieldByName(EXEC_FIELD);
  if(!ef){ try{await returnToListView();}catch(_){}; return {ok:false,wo:num,error:'exec_field_not_found'}; }
  const execBefore=String(ef.field.getValue?.()||'').trim();
  if(execBefore){ try{await returnToListView();}catch(_){}; return {ok:true,wo:num,already:true,exec:execBefore}; }
  if(ef.field.readOnly||ef.field.disabled){ try{await returnToListView();}catch(_){}; return {ok:false,wo:num,error:'exec_readonly'}; }
  const dirtyOthers=getDirtyFieldsExcept(ef.win,ef.field);
  if(dirtyOthers.length){ try{await returnToListView();}catch(_){}; return {ok:false,wo:num,error:'form_has_other_dirty_fields',dirtyFields:dirtyOthers}; }
  const execCode=String(forceCode||'').trim().toUpperCase()||execCodeForOpenRecord();
  if(!execCode){ try{await returnToListView();}catch(_){}; return {ok:false,wo:num,error:'no_exec_rule_for_type',woType:readWoTypeFromRecord()}; }
  try{
    ef.field.suspendEvents?.(); ef.field.setValue?.(execCode); ef.field.resumeEvents?.();
    ef.field.fireEvent?.('change',ef.field,execCode,execBefore); ef.field.fireEvent?.('blur',ef.field);
  }catch(err){ try{await returnToListView();}catch(_){}; return {ok:false,wo:num,error:'set_value_failed',detail:err?.message||String(err)}; }
  await delay(400);
  const sc=findSaveControl();
  if(!sc){ try{await returnToListView();}catch(_){}; return {ok:false,wo:num,error:'save_button_not_found'}; }
  if(!clickSaveControl(sc)){ try{await returnToListView();}catch(_){}; return {ok:false,wo:num,error:'save_click_failed'}; }
  let after='';
  for(let waited=0;waited<6000;waited+=300){ await delay(300); const again=findFieldByName(EXEC_FIELD); if(again){ after=String(again.field.getValue?.()||'').trim(); if(after.toUpperCase()===execCode) break; } }
  const ok=after.toUpperCase()===execCode;
  try{ await returnToListView(); }catch(_){}
  return ok?{ok:true,wo:num,exec:after}:{ok:false,wo:num,error:'save_not_confirmed',exec:after};
}

// ─────────────────────────────────────────────────────────────────────────
//  DIALOG EAM (message box modali durante il save)
// ─────────────────────────────────────────────────────────────────────────
function scanEamDialogs(){
  const out=[];
  for(const win of getExtWindows()){
    try{
      if(!win.Ext?.ComponentQuery) continue;
      const boxes=win.Ext.ComponentQuery.query('messagebox:not([destroyed=true]), window[modal=true]:not([destroyed=true])');
      for(const box of boxes){
        try{ if(box.isVisible&&!box.isVisible()) continue; }catch(_){}
        let txt='';
        try{ txt=(box.el&&box.el.dom?box.el.dom.innerText:'')||''; }catch(_){}
        let btns=[];
        try{ btns=(win.Ext.ComponentQuery.query('button:not([destroyed=true])',box)||[]).filter(b=>{try{return b.isVisible?b.isVisible():true;}catch(_){return true;}}); }catch(_){}
        out.push({win,box,text:txt.replace(/\s+/g,' ').trim(),buttons:btns});
      }
    }catch(_){}
  }
  return out;
}
function clickDialogBtn(b){ try{ if(typeof b.handler==='function'){ b.handler.call(b.scope||b,b); return true; } if(b.fireHandler){ b.fireHandler(); return true; } if(b.el&&b.el.dom){ b.el.dom.click(); return true; } }catch(_){}; return false; }
function btnMatches(b,re){ return re.test(String(b.text||b.itemId||'').trim()); }

// ─────────────────────────────────────────────────────────────────────────
//  SPOSTAMENTO DATA WO (schedstartdate/schedenddate) — mattone per modalita bozza
// ─────────────────────────────────────────────────────────────────────────
// Dry-run: legge start/end attuali e stato dei campi data. NON scrive.
async function previewMove(woNum){
  const num=String(woNum||'').trim();
  if(!num) return {ok:false,error:'missing_wo'};
  if(!await openWoRecord(num)) return {ok:false,wo:num,error:'record_not_opened'};
  await delay(400);
  const match=currentRecordMatches(num);
  const sf=findFieldByName(CFG.f.start), ef=findFieldByName(CFG.f.end);
  const readRaw=(fx)=>{ if(!fx) return null; const v=fx.field.getValue?.(); return (v instanceof Date)?toEam(v):String(v||fx.field.getRawValue?.()||'').trim(); };
  const info={
    ok:!!sf, wo:num, recordMatch:match,
    startField: CFG.f.start, startFound:!!sf, startEditable: sf?!(sf.field.readOnly||sf.field.disabled):null, startCurrent: readRaw(sf),
    endField: CFG.f.end, endFound:!!ef, endEditable: ef?!(ef.field.readOnly||ef.field.disabled):null, endCurrent: readRaw(ef),
    dirtyFields: sf?getDirtyFieldsExcept(sf.win,null):null
  };
  try{ await returnToListView(); }catch(_){}
  return info;
}

// v1.7.6: legge la riga del WO dallo STORE della griglia WSJOBS (post-save) per verificare
// che lo Scheduled Start sia stato committato. Ritorna {start:Date|null, tech:string}.
function readGridRow(woNum){
  const wanted=String(woNum||'').trim();
  const out={start:null,tech:''};
  for(const win of getExtWindows()){
    try{
      const Ext=win.Ext; if(!Ext?.ComponentQuery) continue;
      for(const grid of Ext.ComponentQuery.query('gridpanel:not([destroyed=true])')){
        const store=grid.getStore?.(); if(!store||!store.each) continue;
        let rec=null;
        store.each(function(rr){ if(String(rr.get?.(CFG.f.num)||'').trim()===wanted){ rec=rr; return false; } return true; });
        if(!rec) continue;
        const sv=rec.get?.(CFG.f.start);
        const sd=(sv instanceof Date)?sv:fromEam(String(sv||'').trim());
        if(sd) out.start=sd;
        const tv=rec.get?.('assignedto'); if(tv!=null&&String(tv).trim()) out.tech=String(tv).trim();
        if(out.start) return out;
      }
    }catch(_){}
  }
  return out;
}

// Scrittura reale: sposta lo Scheduled Start al giorno 'YYYY-MM-DD', orario invariato.
// Regola fine: schedenddate = max(fine attuale, nuovo start). Scrive end solo se cambia. Verifica dopo il save.
async function moveWo(woNum, targetDayIso, assignCode, deferSave){
  const num=String(woNum||'').trim();
  const day=String(targetDayIso||'').trim();
  if(!num) return {ok:false,wo:num,error:'missing_wo'};
  const md=day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(!md) return {ok:false,wo:num,error:'bad_target_day',detail:'usa YYYY-MM-DD'};
  const _mt0=performance.now();
  if(!await openWoRecord(num)) return {ok:false,wo:num,error:'record_not_opened'};
  console.log('[WOCal] move '+num+': apertura '+Math.round(performance.now()-_mt0)+'ms');
  await delay(150);
  if(!currentRecordMatches(num)){ try{await returnToListView();}catch(_){}; return {ok:false,wo:num,error:'record_mismatch_before_write'}; }
  const sf=findFieldByName(CFG.f.start), ef=findFieldByName(CFG.f.end);
  if(!sf){ try{await returnToListView();}catch(_){}; return {ok:false,wo:num,error:'start_field_not_found'}; }
  if(sf.field.readOnly||sf.field.disabled){ try{await returnToListView();}catch(_){}; return {ok:false,wo:num,error:'start_readonly'}; }
  const dirtyOthers=getDirtyFieldsExcept(sf.win,null);
  if(dirtyOthers.length){ try{await returnToListView();}catch(_){}; return {ok:false,wo:num,error:'form_has_other_dirty_fields',dirtyFields:dirtyOthers}; }
  const readDate=(fx)=>{ if(!fx) return null; const v=fx.field.getValue?.(); if(v instanceof Date) return isNaN(v.getTime())?null:v; return fromEam(String(v||fx.field.getRawValue?.()||'').trim()); };
  const oldStart=readDate(sf), oldEnd=readDate(ef);
  const y=+md[1],mo=+md[2]-1,dd=+md[3];
  const hh=oldStart?oldStart.getHours():8, mi=oldStart?oldStart.getMinutes():0;
  const newStart=new Date(y,mo,dd,hh,mi,0,0);
  let newEnd=oldEnd;
  if(!oldEnd || newStart.getTime()>oldEnd.getTime()){ const eh=oldEnd?oldEnd.getHours():hh, em=oldEnd?oldEnd.getMinutes():mi; newEnd=new Date(y,mo,dd,eh,em,0,0); }
  // Tetto massimo: end non deve mai superare start + MAX_SPAN_DAYS giorni (evita 'end date la prossima settimana' quando il vecchio range era ampio)
  const MAX_SPAN_DAYS=1;
  const capEnd=new Date(newStart.getFullYear(),newStart.getMonth(),newStart.getDate()+MAX_SPAN_DAYS,newEnd?newEnd.getHours():hh,newEnd?newEnd.getMinutes():mi,0,0);
  if(newEnd && newEnd.getTime()>capEnd.getTime()){ newEnd=capEnd; }
  const before={start:oldStart?toEam(oldStart):null,end:oldEnd?toEam(oldEnd):null};
  const setField=(fx,val,prev)=>{ fx.field.suspendEvents?.(); fx.field.setValue?.(val); fx.field.resumeEvents?.(); fx.field.fireEvent?.('change',fx.field,val,prev); fx.field.fireEvent?.('select',fx.field,val); fx.field.fireEvent?.('blur',fx.field); };
  const endWritable = !!ef && !(ef.field.readOnly||ef.field.disabled);
  const endShouldChange = endWritable && newEnd && (!oldEnd || newEnd.getTime()!==oldEnd.getTime());
  const movingLater = !oldEnd || newStart.getTime()>oldEnd.getTime();
  let endChanged=false;
  // Ordine sicuro: spostando in avanti imposto prima la FINE (>= nuovo start), poi lo START,
  // cosi non violo mai la regola EAM "end date must be >= start date".
  try{
    if(movingLater){
      if(endShouldChange){ setField(ef,newEnd,oldEnd); endChanged=true; }
      setField(sf,newStart,oldStart);
    } else {
      setField(sf,newStart,oldStart);
      if(endShouldChange){ setField(ef,newEnd,oldEnd); endChanged=true; }
    }
  }catch(err){ try{await returnToListView();}catch(_){}; return {ok:false,wo:num,error:'set_value_failed',detail:err?.message||String(err),before}; }

  // ── Assegnazione tecnico OPZIONALE nella STESSA sessione (single-pass) ──
  // Evita di riaprire il WO con assignWo dopo il save delle date: la riapertura
  // trovava lo store della griglia ancora "dirty" e abortiva con
  // form_has_other_dirty_fields. Qui scriviamo tutto PRIMA dell'unico save.
  const wantTech = assignCode ? String(assignCode).trim().toUpperCase() : '';
  let assignRep=null, execRep=null, safetyRep=null;
  if(wantTech){
    try{
      const fh=findAssignedField();
      if(!fh){ assignRep={ok:false,error:'assignedto_field_not_found'}; }
      else if(fh.field.readOnly||fh.field.disabled){ assignRep={ok:false,error:'assignedto_readonly'}; }
      else {
        const beforeTech=String(fh.field.getValue?.()||'').trim();
        if(beforeTech.toUpperCase()===wantTech){ assignRep={ok:true,already:beforeTech}; }
        else {
          fh.field.suspendEvents?.(); fh.field.setValue?.(wantTech); fh.field.resumeEvents?.();
          fh.field.fireEvent?.('change',fh.field,wantTech,beforeTech); fh.field.fireEvent?.('blur',fh.field);
          assignRep={ok:true,set:wantTech,before:beforeTech}; await delay(150);
        }
        // WO Execution (udfchar13) SOLO se vuoto, mai sovrascrivere
        try{
          const exf=findFieldByName(EXEC_FIELD);
          if(exf){ const eb=String(exf.field.getValue?.()||'').trim();
            if(eb){ execRep={already:eb}; }
            else if(exf.field.readOnly||exf.field.disabled){ execRep={skipped:'readonly'}; }
            else { const ec=execCodeForOpenRecord();
              if(!ec){ execRep={skipped:'no_rule_for_type'}; }
              else { exf.field.suspendEvents?.(); exf.field.setValue?.(ec); exf.field.resumeEvents?.();
                exf.field.fireEvent?.('change',exf.field,ec,eb); exf.field.fireEvent?.('blur',exf.field);
                execRep={set:ec}; await delay(150); } } }
        }catch(_){}
        // Safety related (udfchar24) = 'No' SOLO se vuoto, mai sovrascrivere Yes
        try{
          const saf=findFieldByName(SAFETY_FIELD);
          if(saf){ const sb=String(saf.field.getValue?.()||'').trim();
            if(sb){ safetyRep={already:sb}; }
            else if(saf.field.readOnly||saf.field.disabled){ safetyRep={skipped:'readonly'}; }
            else { saf.field.suspendEvents?.(); saf.field.setValue?.(SAFETY_VALUE); saf.field.resumeEvents?.();
              saf.field.fireEvent?.('change',saf.field,SAFETY_VALUE,sb); saf.field.fireEvent?.('blur',saf.field);
              safetyRep={set:SAFETY_VALUE}; await delay(150); } }
        }catch(_){}
      }
    }catch(e){ assignRep={ok:false,error:'assign_set_failed',detail:e?.message||String(e)}; }
  }

  // v1.7.6 DEFER-SAVE (chiamata dal loop Apply): NON salviamo qui. Settiamo i campi,
  // verifichiamo il tecnico dal form ancora aperto, torniamo in lista lasciando il record
  // modificato. Il caller esegue l'UNICO save (saveGridView dallo stato lista) e verifica
  // la data dallo store. Evita il doppio save (~3.5s/WO risparmiati).
  if(deferSave){
    let techOkDef=true;
    if(wantTech){
      const faD=findAssignedField();
      const curD=faD?String(faD.field.getValue?.()||'').trim().toUpperCase():'';
      techOkDef=(curD===wantTech);
      if(assignRep){ assignRep.ok=techOkDef; if(!techOkDef) assignRep.error=assignRep.error||'assign_not_confirmed'; }
    }
    try{ await returnToListView(); }catch(_){}
    console.log('[WOCal] move '+num+': set-only '+Math.round(performance.now()-_mt0)+'ms (defer) techOk='+(wantTech?techOkDef:'-')+' target='+day);
    const resD={ok:true,wo:num,before,deferred:true,target:day,after:{start:toEam(newStart),end:endChanged?toEam(newEnd):before.end}};
    if(wantTech){ resD.assign=assignRep; resD.exec=execRep; resD.safety=safetyRep; resD.techOk=techOkDef; }
    return resD;
  }

  await delay(150);
  const sc=findSaveControl();
  if(!sc){ try{await returnToListView();}catch(_){}; return {ok:false,wo:num,error:'save_button_not_found',before}; }
  installAjaxDiag(sc.win);
  logButtonIdentity(sc,'detailSave WO='+num);
  logDirtyStores('pre-detailSave WO='+num);
  // v1.8.6: intercetta il dialog "date fuori range" PRIMA che venga renderizzato,
  // confermando "Yes" istantaneamente. Se EAM non usa Ext.MessageBox.show per questo
  // dialog (o l'hook non matcha), origMsgShow resta invariato e il polling sotto
  // (Fase1/Fase2) gestisce tutto come prima: nessuna regressione possibile, solo
  // guadagno opzionale. Ripristinato SEMPRE nel finally, anche in caso di errore,
  // per evitare di accumulare wrapper annidati sulle chiamate successive.
  const origMsgShow = sc.win?.Ext?.MessageBox?.show;
  let dialogIntercepted = false;
  if (origMsgShow) {
    sc.win.Ext.MessageBox.show = function(cfg) {
      const msg = String(cfg?.msg || cfg?.message || cfg?.title || '');
      if (/Activity.*Date|date range/i.test(msg)) {
        dialogIntercepted = true;
        console.log('[WOCal] Dialog intercettato e auto-confermato WO='+num+': '+msg.slice(0,80));
        if (cfg && typeof cfg.fn === 'function') cfg.fn('yes');
        else if (cfg && typeof cfg.callback === 'function') cfg.callback('yes');
        return this;
      }
      return origMsgShow.apply(this, arguments);
    };
  }
  console.log('[WOCal-DIAG] click detailSave WO='+num+' @'+Math.round(performance.now()));
  if(!clickSaveControl(sc)){
    if (origMsgShow && sc.win?.Ext?.MessageBox) sc.win.Ext.MessageBox.show = origMsgShow;
    try{await returnToListView();}catch(_){}; return {ok:false,wo:num,error:'save_click_failed',before};
  }
  // Post-save: gestisci i dialog EAM (Continue/errori) e attendi il commit reale via
  // AJAX idle. NON usiamo isDirty come gate: sui record con campi Activity protetti
  // resta dirty=true anche dopo un save riuscito, facendo sprecare ~10s per WO.
  let after=null, dialogText=null, errored=false, confirmedContinue=false, sawDialog=false;
  const reErr=/(must be later than or equal|must be greater|must be later|deve essere|not valid|non valido)/i;
  const okRe=/^(ok|chiudi|close)$/i;
  // Qualsiasi bottone di conferma/prosecuzione (non solo "Continue"): il cambio di
  // assignedto puo' aprire dialog con testi diversi che prima venivano ignorati,
  // restando aperti e bloccando il commit (timeout ~12s sui WO dopo il primo).
  const confirmRe=/^(ok|yes|s[iì]|si|continua|continue|save|salva|proceed|procedi|apply|applica|conferma|confirm|accetta|accept)$/i;
  try{
    if(dialogIntercepted){ confirmedContinue=true; sawDialog=true; }
    // Fase 1: intercetta e conferma l'eventuale dialog (max ~3s, esce appena sparito)
    for(let waited=0;waited<3000;waited+=200){
      await delay(200);
      const dlgs=scanEamDialogs();
      if(dlgs.length){
        const d=dlgs.find(x=>x.buttons.length)||dlgs[0];
        const t=String(d.text||'');
        console.log('[WOCal] DIALOG post-save move '+num+': "'+t.slice(0,140)+'" btns=['+d.buttons.map(function(b){return String(b.text||b.itemId||'?');}).join(' | ')+']');
        if(reErr.test(t)){
          const okb=d.buttons.find(b=>btnMatches(b,okRe))||d.buttons[0];
          if(okb) clickDialogBtn(okb);
          errored=true; dialogText=t; break;
        }
        const conf=d.buttons.find(b=>btnMatches(b,confirmRe));
        if(conf){ clickDialogBtn(conf); confirmedContinue=true; sawDialog=true; dialogText=t; await delay(150); continue; }
        // Dialog senza bottone di conferma riconoscibile: gia' loggato sopra per diagnosi.
      } else if(sawDialog){ break; }
      else {
        const again=findFieldByName(CFG.f.start);
        if(again){ const av=again.field.getValue?.(); const ad=(av instanceof Date)?av:fromEam(String(av||'').trim());
          let dirty=true; try{ dirty=(typeof again.field.isDirty==='function')?again.field.isDirty():false; }catch(_){ dirty=false; }
          if(ad){ after=ad; if(iso(ad)===day && !dirty) break; }
        }
      }
    }
    // Fase 2: attende il completamento della richiesta di salvataggio (commit reale), poi rilegge la data.
    if(!errored){
      // v1.8.0: diagnostica v1.7.8/9 ha provato (4/4 WO, listener AJAX attivo) che il click
      // detailSave NON genera MAI una richiesta AJAX -> il vero save avviene dopo, nel
      // gridSave (WSJOBS.HDR?pageaction=SAVE). Questi waitForAjaxSettled aspettavano un
      // AJAX che strutturalmente non arriva: budget tagliato da 1200 a 250ms (margine di
      // sicurezza minimo, non azzerato, per il caso raro non ancora osservato).
      try{ await waitForAjaxSettled(sf.win,250); }catch(_){}
      await delay(50); // v1.8.6: era 150, margine ridotto (nessun AJAX da attendere qui)
      // Gestisce eventuali dialog che appaiono DOPO il commit (in cascata, max 10).
      for(let k=0;k<10;k++){
        const dlgs2=scanEamDialogs();
        if(!dlgs2.length) break;
        const d2=dlgs2.find(x=>x.buttons.length)||dlgs2[0]; const t2=String(d2.text||'');
        console.log('[WOCal] DIALOG post-save(2) move '+num+': "'+t2.slice(0,140)+'" btns=['+d2.buttons.map(function(b){return String(b.text||b.itemId||'?');}).join(' | ')+']');
        if(reErr.test(t2)){ const okb2=d2.buttons.find(b=>btnMatches(b,okRe))||d2.buttons[0]; if(okb2) clickDialogBtn(okb2); errored=true; dialogText=t2; break; }
        const conf2=d2.buttons.find(b=>btnMatches(b,confirmRe));
        if(conf2){ clickDialogBtn(conf2); confirmedContinue=true; await delay(300); continue; }
        break;
      }
      if(!errored){ try{ await waitForAjaxSettled(sf.win,150); }catch(_){} await delay(50); } // v1.8.6: era 150, stesso motivo sopra
      const again2=findFieldByName(CFG.f.start);
      if(again2){ const av2=again2.field.getValue?.(); const ad2=(av2 instanceof Date)?av2:fromEam(String(av2||'').trim()); if(ad2) after=ad2; }
    }
  } finally {
    if (origMsgShow && sc.win?.Ext?.MessageBox) sc.win.Ext.MessageBox.show = origMsgShow;
  }
  if(errored){ try{await returnToListView();}catch(_){}; return {ok:false,wo:num,error:'validation_error',detail:dialogText,before}; }
  logDirtyStores('post-detailSave WO='+num);
  const dateOk=!!after && iso(after)===day;
  // Verifica tecnico (se richiesto e non gia' assegnato): rilegge dal record ancora aperto.
  let techOk=true;
  if(wantTech){
    if(assignRep && assignRep.ok===false){ techOk=false; }
    else if(assignRep && assignRep.already){ techOk=true; }
    else {
      techOk=false;
      for(let w=0;w<3000;w+=300){
        const fa=findAssignedField();
        if(fa){ const cur=String(fa.field.getValue?.()||'').trim().toUpperCase(); if(cur===wantTech){ techOk=true; break; } }
        await delay(300);
      }
      if(assignRep){ assignRep.ok=techOk; if(!techOk) assignRep.error=assignRep.error||'assign_not_confirmed'; }
    }
  }
  const ok=dateOk && techOk;
  console.log('[WOCal] move '+num+': TOTALE '+Math.round(performance.now()-_mt0)+'ms ok='+ok+' dateOk='+dateOk+(wantTech?(' techOk='+techOk):'')+' afterStart='+(after?iso(after):'null')+' target='+day);
  try{ await returnToListView(); }catch(_){}
  if(ok){
    const res={ok:true,wo:num,before,after:{start:toEam(after),end:endChanged?toEam(newEnd):before.end},continueDialog:confirmedContinue};
    if(wantTech){ res.assign=assignRep; res.exec=execRep; res.safety=safetyRep; }
    return res;
  }
  const res={ok:false,wo:num,error:dateOk?'assign_not_confirmed':'save_not_confirmed',before,after:after?toEam(after):null,detail:dialogText};
  if(wantTech){ res.assign=assignRep; res.exec=execRep; res.safety=safetyRep; }
  return res;
}

// Test da console (ESPLICITI). NON eseguono nulla in automatico.
{
  try {
    const W=(typeof unsafeWindow!=='undefined'?unsafeWindow:window);
    // Dry-run sicuro: __wocalPreviewAssign('12345678')
    W.__wocalPreviewAssign=async(wo)=>{ const r=await previewAssign(wo); console.log('[WOCal] previewAssign:',r); return r; };
    // Scrittura reale su 1 WO: __wocalAssign('12345678','MEREUDU')
    W.__wocalAssign=async(wo,code)=>{ const r=await assignWo(wo,code); console.log('[WOCal] assignWo:',r); return r; };
    // Riempie WO Execution (per categoria, fallback EXMW) se vuoto: __wocalFillExec('12345678') oppure forza: __wocalFillExec('12345678','EXMW')
    W.__wocalFillExec=async(wo,code)=>{ const r=await fillExecIfEmpty(wo,code); console.log('[WOCal] fillExecIfEmpty:',r); return r; };
    // Dry-run data: __wocalPreviewMove('12345678')
    W.__wocalPreviewMove=async(wo)=>{ const r=await previewMove(wo); console.log('[WOCal] previewMove:',r); return r; };
    // Sposta start al giorno YYYY-MM-DD (scrive!): __wocalMove('12345678','2026-07-27')
    W.__wocalMove=async(wo,day)=>{ const r=await moveWo(wo,day); console.log('[WOCal] moveWo:',r); return r; };
  } catch(_) {}
}

// ═══════════════════════════════════════════════════════════════════════════
//  CATEGORIA WO
// ═══════════════════════════════════════════════════════════════════════════
function categorize(wo) {
  const t=(wo[CFG.f.type]||'').trim().toUpperCase();
  for (const cat of CFG.categories) {
    if (!cat.types.length) continue;
    if (cat.types.some(x=>t===x||t.startsWith(x))) return cat.id;
  }
  return 'OTHER';
}

// ═══════════════════════════════════════════════════════════════════════════
//  HTML CALENDAR PAGE
// ═══════════════════════════════════════════════════════════════════════════
function buildPage(data) {
  const monDate=new Date(data.monday+'T00:00:00'), sunDate=addDays(monDate,6), todayStr=iso(new Date());
  const grouped={};
  CFG.categories.forEach(c=>{grouped[c.id]={};});
  (data.wos||[]).forEach(wo=>{
    const catId=categorize(wo), d=fromEam(wo[CFG.f.start]); if(!d) return;
    const k=iso(d); if(!grouped[catId][k]) grouped[catId][k]=[]; grouped[catId][k].push(wo);
  });
  const dayNames=['DOM','LUN','MAR','MER','GIO','VEN','SAB'];
  const days=[];
  for(let i=0;i<7;i++){const d=addDays(monDate,i);days.push({key:iso(d),label:dayNames[i],date:d,isToday:iso(d)===todayStr,isWknd:i===6});}

  // Ore WO: EAM cambia alias tra lista WSJOBS e Record View. Prima prova gli alias
  // noti, poi scopre dinamicamente campi nascosti tramite il nome normalizzato del model.
  const normKey=k=>String(k||'').toLowerCase().replace(/[^a-z0-9]/g,'');
  function numericField(wo,aliases,patterns){
    const keys=Object.keys(wo||{});
    for(const alias of aliases){
      const wanted=normKey(alias), key=keys.find(k=>normKey(k)===wanted);
      if(!key) continue;
      const raw=wo[key]; if(raw===undefined||raw===null||raw==='') continue;
      const v=parseFloat(String(raw).trim().replace(/\.(?=\d{3}(\D|$))/g,'').replace(',','.')); if(Number.isFinite(v)&&v>=0) return {value:v,key};
    }
    for(const key of keys){
      const nk=normKey(key); if(!patterns.some(p=>p.every(part=>nk.includes(part)))) continue;
      const raw=wo[key]; if(raw===undefined||raw===null||raw==='') continue;
      const v=parseFloat(String(raw).trim().replace(/\.(?=\d{3}(\D|$))/g,'').replace(',','.')); if(Number.isFinite(v)&&v>=0) return {value:v,key};
    }
    return {value:null,key:''};
  }
  function expectedInfo(wo){return numericField(wo,
    [CFG.f.hours,'expectedhours','expected_hours','woesthours','estimatedlaborhours',CFG.f.duration],
    [['estimated','hour'],['expected','hour'],['est','hour'],['est','duration']]);}
  function scheduledInfo(wo){return numericField(wo,
    [CFG.f.schedHours,'scheduled_hours','schedhours','woschedhours','scheduledlaborhours','schedlaborhours'],
    [['scheduled','hour'],['sched','hour']]);}
  function actualInfo(wo){return numericField(wo,
    [CFG.f.actualHours,'actual_hours','woactualhours','bookedhours','laborbookedhours'],
    [['actual','hour'],['booked','hour']]);}
  function expectedHours(wo){return expectedInfo(wo).value;}
  function fmtHours(v){
    if(v===null||v===undefined||!Number.isFinite(v)) return '—';
    return (Math.round(v*10)/10).toLocaleString('it-IT',{minimumFractionDigits:v%1?1:0,maximumFractionDigits:1})+' h';
  }
  function fmtDur(wo){ return fmtHours(expectedHours(wo)); }

  const allWos=data.wos||[];
  const dailyStats={};
  days.forEach(d=>dailyStats[d.key]={count:0,hours:0,missing:0});
  const techStats=new Map();
  let totalHours=0, scheduledTotal=0, scheduledKnown=0, actualTotal=0, actualKnown=0,
      assignedHours=0, unassignedHours=0, missingHours=0, unassignedCount=0;
  const discoveredHourFields={estimated:new Set(),scheduled:new Set(),actual:new Set()};
  allWos.forEach(wo=>{
    const ei=expectedInfo(wo), si=scheduledInfo(wo), ai=actualInfo(wo), h=ei.value,
          asgn=String(wo[CFG.f.assigned]||'').trim()||'NON ASSEGNATO';
    if(ei.key)discoveredHourFields.estimated.add(ei.key);
    if(si.key){discoveredHourFields.scheduled.add(si.key);scheduledKnown++;scheduledTotal+=si.value;}
    if(ai.key){discoveredHourFields.actual.add(ai.key);actualKnown++;actualTotal+=ai.value;}
    const d=fromEam(wo[CFG.f.start]), key=d?iso(d):'';
    if(h===null){missingHours++;if(dailyStats[key])dailyStats[key].missing++;}
    else {
      totalHours+=h;
      if(asgn==='NON ASSEGNATO') unassignedHours+=h; else assignedHours+=h;
      if(dailyStats[key]) dailyStats[key].hours+=h;
    }
    if(dailyStats[key]) dailyStats[key].count++;
    if(asgn==='NON ASSEGNATO') unassignedCount++;
    const t=techStats.get(asgn)||{name:asgn,count:0,hours:0,missing:0};
    t.count++; if(h===null)t.missing++;else t.hours+=h; techStats.set(asgn,t);
  });
  const techRows=[...techStats.values()].sort((a,b)=>b.hours-a.hours||b.count-a.count);
  const woHoursMap={};
  allWos.forEach(wo=>{ const n=String(wo[CFG.f.num]||''); if(n) woHoursMap[n]=expectedHours(wo); });
  const techLoadMap={};
  techStats.forEach((v,k)=>{ if(k && k!=='NON ASSEGNATO') techLoadMap[String(k).toUpperCase()]={count:v.count,hours:Math.round((v.hours||0)*10)/10}; });
  console.log('[WOCal] Campi ore rilevati:',{
    estimated:[...discoveredHourFields.estimated],scheduled:[...discoveredHourFields.scheduled],
    actual:[...discoveredHourFields.actual],scheduledKnown,total:allWos.length
  });
  const SCOL={R:'#3498db',AWA:'#3498db',WIP:'#f39c12',COMP:'#27ae60',HOLD:'#e67e22',CAN:'#e74c3c',C:'#2ecc71'};

  function card(wo, catId, dayKey){
    const num=wo[CFG.f.num]||'', desc=wo[CFG.f.desc]||'', eq=wo[CFG.f.equip]||'',
          eqd=wo[CFG.f.equipDesc]||'', asgn=wo[CFG.f.assigned]||'',
          stat=wo[CFG.f.status]||'', type=wo[CFG.f.type]||'',
          dur=fmtDur(wo), sched=scheduledInfo(wo).value, actual=actualInfo(wo).value,
          loc=wo[CFG.f.location]||'', shft=String(wo[CFG.f.shift]||'').trim(),
          sc=SCOL[(stat||'').toUpperCase()]||'#7f8c8d',
          statDisp=wo[CFG.f.statusDisp]||stat,
          dispEq=eqd?`${eq} - ${eqd}`:eq;
    return `<div class="wc" data-wo="${esc(num)}" data-cat="${esc(catId||'')}" data-day="${esc(dayKey||'')}" data-hours="${expectedHours(wo)||0}" data-tech="${esc((asgn||'').toUpperCase())}" onclick="cardClick(event,this)" ondblclick="oWO(${esc(JSON.stringify(String(num)))})" title="Click: seleziona/deseleziona \u00B7 Doppio click: apri in EAM\nWO: ${esc(num)}\n${esc(desc)}\nExpected Hours: ${esc(dur)}\nStatus: ${esc(stat)}\nEquip: ${esc(dispEq)}\nAssigned: ${esc(asgn||'Non assegnato')}">
<div class="wct"><label class="wsel-l" onclick="event.stopPropagation()"><input type="checkbox" class="wsel" data-wo="${esc(num)}" onchange="toggleSel(this)"></label><span class="wn">WO: ${esc(num)}</span><span class="wd${dur==='—'?' miss':''}" title="WO Estimated Hours">${dur}</span></div>
<div class="wx">${esc(desc)}</div>
${sched!==null?`<div class="wh"><span>SCHED ${fmtHours(sched)}</span><span>REMAIN ${fmtHours(Math.max(0,(expectedHours(wo)||0)-sched))}</span>${actual!==null?`<span>ACT ${fmtHours(actual)}</span>`:''}</div>`:''}
${dispEq?`<div class="we">${esc(dispEq)}</div>`:''}${loc?`<div class="we">${esc(loc)}</div>`:''}
<div class="wf">${asgn?`<span class="wb">${esc(asgn)}</span>`:''}${shft?`<span class="ws">${esc(shft)}</span>`:'<span class="ws wse">SHIFT?</span>'}<span class="wt" style="border-color:${sc};color:${sc}">${esc(statDisp)}${type?' - '+esc(type):''}</span></div>
</div>`;
  }

  function section(cat){
    const cw=grouped[cat.id], catWos=Object.values(cw).flat(), tot=catWos.length,
          catHours=catWos.reduce((s,w)=>s+(expectedHours(w)||0),0);
    let cols='';
    days.forEach(day=>{
      const dw=cw[day.key]||[];
      cols+=`<div class="dc${day.isToday?' dt':''}${day.isWknd?' dw':''}" data-cat="${esc(cat.id)}" data-day="${day.key}"><div class="db" data-cat="${esc(cat.id)}" data-day="${day.key}">${dw.map(w=>card(w,cat.id,day.key)).join('')}<div class="nt"${dw.length?' style="display:none"':''}>-</div></div></div>`;
    });
    const gh=days.map(d=>`<div class="gh${d.isToday?' dt':''}${d.isWknd?' dw':''}">
<div class="gd">${d.label}${d.isToday?' <span class="tb">TODAY</span>':''}</div>
<div class="gdate">${pad(d.date.getDate())}/${pad(d.date.getMonth()+1)}/${d.date.getFullYear()}</div>
<div class="gc${(cw[d.key]||[]).length?' ga':''}">${(cw[d.key]||[]).length} WO · ${fmtHours((cw[d.key]||[]).reduce((s,w)=>s+(expectedHours(w)||0),0))}</div>
</div>`).join('');
    return `<section class="cs">
<div class="sh" style="background:${cat.color};border-left:4px solid ${cat.accent}">
  <span class="sl">${esc(cat.label)}</span>
  <span class="sw">- ${toEam(monDate)} to ${toEam(sunDate)}</span>
  <span class="sk">${tot} WO · ${fmtHours(catHours)}</span>
</div>
${tot===0?`<div class="se">Nessun WO di tipo ${esc(cat.label)} questa settimana.</div>`:`<div class="cg"><div class="cgr">${gh}</div><div class="cgb">${cols}</div></div>`}
</section>`;
  }

  const sections=CFG.categories.map(section).join('');
  const tot=allWos.length, wl=`${toEam(monDate)} - ${toEam(sunDate)}`, eb=CFG.baseUrl;
  const monJs=JSON.stringify(String(data.monday||'')), orgJs=JSON.stringify(String(data.org||'')),
        assJs=JSON.stringify(String(data.assigned||'')), ebJs=JSON.stringify(String(eb||''));
  const techListJs=JSON.stringify(getTechnicians().map(x=>({code:x.code,name:x.name,senior:!!x.senior})));
  const daysMetaJs=JSON.stringify(days.map(d=>({key:d.key,label:d.label,today:!!d.isToday})));
  const woHoursJs=JSON.stringify(woHoursMap);
  const techLoadJs=JSON.stringify(techLoadMap);
  const dayCapacity=days.map(d=>{
    const s=dailyStats[d.key];
    return `<div class="dload${d.isToday?' today':''}"><div class="dl-day">${d.label}</div><div class="dl-hours">${fmtHours(s.hours)}</div><div class="dl-sub">${s.count} WO${s.missing?` · ${s.missing} senza ore`:''}</div></div>`;
  }).join('');
  const techTable=techRows.slice(0,12).map(t=>`<tr class="${t.name==='NON ASSEGNATO'?'unassigned':''}"><td>${esc(t.name)}</td><td>${t.count}</td><td>${fmtHours(t.hours)}</td><td>${t.missing||'—'}</td></tr>`).join('');
  const sync=data.scheduleSync||{}, syncLabel=sync.skipped?'Seleziona un sito':`${(sync.loaded||0)+(sync.cached||0)}/${sync.total||tot} WO letti${sync.failed?` · ${sync.failed} errori`:''}`;
  const dashboard=`<section id="ops">
    <div class="ops-head"><div><div class="eyebrow">${esc(data.org||'MULTI-SITE')} · WEEKLY CONTROL</div><h2>Workload planning</h2></div><div class="shift-pending">SCHEDULE LABOR <strong>${esc(syncLabel)}</strong></div></div>
    <div class="kpis">
      <div class="kpi"><span>Expected Hours</span><strong>${fmtHours(totalHours)}</strong><small>${tot} work orders</small></div>
      <div class="kpi"><span>Schedule Labor</span><strong>${scheduledKnown?fmtHours(scheduledTotal):'—'}</strong><small>${scheduledKnown?`${scheduledKnown}/${tot} WO con dato`:'sincronizzazione non disponibile'}</small></div>
      <div class="kpi${(scheduledKnown?Math.max(0,totalHours-scheduledTotal):unassignedHours)>0?' warn':''}"><span>Da pianificare</span><strong>${scheduledKnown?fmtHours(Math.max(0,totalHours-scheduledTotal)):fmtHours(unassignedHours)}</strong><small>${scheduledKnown?'Expected meno Scheduled':`${unassignedCount} WO senza tecnico`}</small></div>
      <div class="kpi ${missingHours?'risk':''}"><span>Dati incompleti</span><strong>${missingHours}</strong><small>WO senza Expected Hours</small></div>
    </div>
    <div class="ops-grid"><div><h3>Carico previsto per giorno</h3><div class="day-load">${dayCapacity}</div></div>
    <div class="tech-load"><h3>Carico per tecnico</h3><div class="table-wrap"><table><thead><tr><th>Tecnico</th><th>WO</th><th>Expected</th><th>Senza ore</th></tr></thead><tbody>${techTable||'<tr><td colspan="4">Nessun dato</td></tr>'}</tbody></table></div></div></div>
  </section>`;

  return `<!DOCTYPE html><html lang="it"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WO Calendar - ${wl}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1923;color:#c8d8e8;font-size:13px;}
#tb{background:#0a1220;border-bottom:1px solid #1e3a54;padding:8px 14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;position:sticky;top:0;z-index:100;box-shadow:0 2px 8px rgba(0,0,0,.5);}
#tb h1{font-size:14px;font-weight:700;color:#7ec8f7;white-space:nowrap;}#wr{font-size:12px;color:#6a9abd;white-space:nowrap;}
.nb{background:#1e3a5a;border:1px solid #3a6a9a;color:#7ec8f7;border-radius:4px;padding:4px 10px;cursor:pointer;font-size:12px;}.nb:hover{background:#2a5a8a;}
.to{background:#1a4a2a;border:1px solid #2a7a3a;color:#68d994;border-radius:4px;padding:4px 10px;cursor:pointer;font-size:11px;}.to:hover{background:#236b30;}
#fo,#fa{background:#0e1e2e;border:1px solid #2e4a6a;color:#a0bcd0;border-radius:4px;padding:3px 7px;font-size:12px;width:110px;}
.fl{font-size:11px;color:#4a8aaa;white-space:nowrap;}
#sb{font-size:11px;padding:0 4px;color:#27ae60;}#sb.L{color:#f39c12;}#sb.E{color:#e74c3c;}
#ops{background:#f4f1e8;color:#18231e;border-bottom:1px solid #b8b2a2;padding:18px 20px 20px;}
.ops-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:14px}.eyebrow{font-size:10px;font-weight:800;letter-spacing:.18em;color:#6f725f}.ops-head h2{font-family:Georgia,'Times New Roman',serif;font-size:25px;font-weight:600;line-height:1.05;color:#18231e}.shift-pending{font-size:9px;letter-spacing:.11em;color:#77766d;text-align:right}.shift-pending strong{display:block;font-size:11px;letter-spacing:0;color:#9a6b21;margin-top:3px}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(130px,1fr));border:1px solid #b8b2a2;background:#ded9cc}.kpi{background:#f8f5ed;padding:12px 14px;border-right:1px solid #b8b2a2}.kpi:last-child{border-right:0}.kpi span{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#676b60}.kpi strong{display:block;font-family:Georgia,'Times New Roman',serif;font-size:24px;color:#1d3328;margin:4px 0 2px}.kpi small{font-size:10px;color:#74776f}.kpi.warn strong{color:#a46114}.kpi.risk strong{color:#a33a2b}
.ops-grid{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(310px,.8fr);gap:18px;margin-top:17px}.ops-grid h3{font-size:11px;text-transform:uppercase;letter-spacing:.09em;color:#535a50;margin-bottom:8px}.day-load{display:grid;grid-template-columns:repeat(7,1fr);border:1px solid #c8c2b4}.dload{padding:10px 8px;background:#eeeadf;border-right:1px solid #c8c2b4;min-width:0}.dload:last-child{border-right:0}.dload.today{background:#dbe4d8}.dl-day{font-size:9px;font-weight:800;color:#64695e}.dl-hours{font-family:Georgia,'Times New Roman',serif;font-size:18px;color:#1e3529;margin:4px 0}.dl-sub{font-size:9px;color:#777970;white-space:normal}.table-wrap{max-height:146px;overflow:auto;border:1px solid #c8c2b4;background:#f8f5ed}table{width:100%;border-collapse:collapse;font-size:10px}th{text-align:left;text-transform:uppercase;letter-spacing:.04em;color:#686d62;background:#e6e1d5;position:sticky;top:0}th,td{padding:6px 8px;border-bottom:1px solid #d7d1c5}td:not(:first-child),th:not(:first-child){text-align:right}.unassigned td{color:#9b5418;font-weight:700}
@media(max-width:1050px){.ops-grid{grid-template-columns:1fr}.kpis{grid-template-columns:repeat(2,1fr)}.kpi:nth-child(2){border-right:0}.kpi:nth-child(-n+2){border-bottom:1px solid #b8b2a2}}@media(max-width:720px){.day-load{grid-template-columns:repeat(4,1fr)}.dload{border-bottom:1px solid #c8c2b4}.kpis{grid-template-columns:1fr}.kpi{border-right:0;border-bottom:1px solid #b8b2a2}}
.cs{border-bottom:2px solid #0a1218;}
.sh{padding:9px 14px;display:flex;align-items:center;gap:8px;color:#fff;font-weight:600;font-size:13px;}
.sl{flex-shrink:0;}.sw{font-size:11px;opacity:.7;}.sk{margin-left:auto;font-size:11px;background:rgba(255,255,255,.15);padding:1px 8px;border-radius:10px;}
.se{padding:10px 14px;color:#3a5a7a;font-size:12px;background:#0a1520;}
.cg{background:#0a1520;}.cgr{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));border-bottom:1px solid #1a3050;}
.gh{padding:8px 8px 7px;text-align:center;background:#0e1a2e;border-right:1px solid #1a2e44;min-width:0;}.gh:last-child{border-right:none;}
.gh.dt{background:linear-gradient(180deg,#123a5c,#0e2a44);border-bottom:3px solid #4fc3f7;}.gh.dw{opacity:.55;}
.gd{font-size:11px;font-weight:800;color:#8fd0ff;text-transform:uppercase;letter-spacing:.04em;}
.gdate{font-size:10px;color:#8fb4d4;margin:2px 0;font-weight:600;}
.gc{font-size:9px;color:#8fb4d4;background:#152c48;border-radius:8px;padding:2px 7px;display:inline-block;margin-top:3px;font-weight:600;}.gc.ga{color:#d4ecff;background:#245a8a;font-weight:700;}
.tb{font-size:8px;background:#3498db;color:#fff;border-radius:2px;padding:1px 3px;margin-left:3px;vertical-align:middle;}
.cgb{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));}
.dc{border-right:1px solid #1a2e44;min-height:60px;padding:3px;min-width:0;}.dc:last-child{border-right:none;}
.dc.dt{background:#0b1f33;}.dc.dw{background:#090f18;opacity:.7;}
.db{display:flex;flex-direction:column;gap:3px;}.nt{font-size:10px;color:#1e3a54;text-align:center;padding:8px 0;}
.wc{background:#101e2e;border:1px solid #1e3a54;border-radius:4px;padding:4px 6px;cursor:pointer;transition:background .12s,border-color .12s;}.wc:hover{background:#162840;border-color:#3a6a9a;}.wc.sel{background:#1a2f22;border-color:#4ade80;box-shadow:inset 0 0 0 1px #4ade80;}.wc.sel:hover{background:#20392a;}
.wct{display:flex;justify-content:space-between;align-items:center;margin-bottom:0;}
.wn{font-size:10px;font-weight:700;color:#7ec8f7;}.wd{font-size:10px;font-weight:700;color:#68d994;background:#0d2a1a;border-radius:3px;padding:1px 4px;}.wd:before{content:'EXP ';font-size:8px;color:#4b9566}.wd.miss{color:#9a8470;background:#201d1a}.wd.miss:before{content:'EXP ';color:#806f61}
.wx{font-size:11px;color:#a0c0d8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:1px;line-height:1.2;}
.wh{display:flex;gap:5px;flex-wrap:wrap;margin:1px 0;color:#d4b96a;font-size:8px;font-weight:700;letter-spacing:.03em}.wh span{border:1px solid #5b4d27;background:#211f17;padding:1px 4px;border-radius:2px}
.we{font-size:10px;color:#5a8aaa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:0;line-height:1.2;}
.wf{display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-top:3px;}
.wb{font-size:12px;font-weight:800;background:#7a3a00;color:#ffb454;border-radius:3px;padding:2px 7px;white-space:nowrap;letter-spacing:.02em;}
.ws{font-size:11px;font-weight:700;background:#7a3a00;color:#ffb454;border-radius:3px;padding:2px 6px;white-space:nowrap;letter-spacing:.02em;}
.wse{background:#8b0000!important;color:#ff4444!important;}
.wt{font-size:9px;border:1px solid;border-radius:3px;padding:1px 4px;white-space:nowrap;}
#lo{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(10,18,32,.88);display:none;align-items:center;justify-content:center;z-index:999;flex-direction:column;gap:12px;}
#lo.on{display:flex;}.sp{width:36px;height:36px;border:3px solid #1e3a5a;border-top-color:#7ec8f7;border-radius:50%;animation:spin .7s linear infinite;}
@keyframes spin{to{transform:rotate(360deg);}}.lt{color:#7ec8f7;font-size:13px;}.ls{color:#4a8aaa;font-size:11px;}
::-webkit-scrollbar{width:5px;height:5px;}::-webkit-scrollbar-track{background:#0a1220;}::-webkit-scrollbar-thumb{background:#1e3a54;border-radius:3px;}
#cc{padding-bottom:128px;}
.wsel-l{display:inline-flex;align-items:center;margin:-3px 6px -3px -5px;cursor:pointer;padding:3px 5px;border-radius:6px;transition:background .12s;}.wsel-l:hover{background:#1e3a5a;}
.wsel{cursor:pointer;width:30px;height:30px;accent-color:#4ade80;margin:0;}
#bulkbar{position:fixed;bottom:0;left:0;width:100%;background:#0a1220;border-top:2px solid #3498db;padding:9px 16px;display:none;align-items:center;gap:12px;z-index:220;box-shadow:0 -2px 12px rgba(0,0,0,.6);flex-wrap:wrap;}
#bulkbar.on{display:flex;}
#bbcount{font-weight:700;color:#7ec8f7;}
#bbhours{color:#68d994;background:#0d2a1a;border-radius:3px;padding:2px 9px;font-weight:700;}
#bbtech{background:#0e1e2e;border:1px solid #3a6a9a;color:#c8d8e8;border-radius:4px;padding:5px 10px;font-size:13px;min-width:210px;}#bbtechmanual{background:#0e1e2e;border:1px solid #3a6a9a;color:#c8d8e8;border-radius:4px;padding:5px 10px;font-size:13px;width:130px;}#bbtechmanual::placeholder{color:#4a6a8a;font-style:italic;}
#bbassign{background:#1a4a2a;border:1px solid #2a7a3a;color:#68d994;border-radius:4px;padding:6px 18px;cursor:pointer;font-weight:700;}
#bbassign:hover{background:#236b30;}
#bbclear{background:#2a1a1a;border:1px solid #6a3a3a;color:#e08080;border-radius:4px;padding:6px 12px;cursor:pointer;}
.modal{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(6,12,20,.82);display:none;align-items:center;justify-content:center;z-index:500;padding:20px;}
.modal.on{display:flex;}
.mbox{background:#0e1a28;border:1px solid #2e4a6a;border-radius:8px;max-width:560px;width:100%;max-height:86vh;overflow:auto;padding:20px 22px;box-shadow:0 10px 40px rgba(0,0,0,.6);}
.mbox h3{color:#7ec8f7;font-size:16px;margin-bottom:12px;}
.mbox p{margin:8px 0;color:#c8d8e8;line-height:1.5;}
.mnote{font-size:11px;color:#7fa0b8;opacity:.85;}
.loadbox{display:flex;align-items:center;gap:14px;background:#0a1520;border:1px solid #1e3a54;border-radius:6px;padding:12px;margin:12px 0;text-align:center;}
.loadbox>div{flex:1;font-size:11px;color:#6a9abd;}.loadbox b{color:#7ec8f7;font-size:14px;}.loadbox .arr{flex:0;font-size:20px;color:#3498db;}
.wolist{list-style:none;max-height:180px;overflow:auto;border:1px solid #1e3a54;border-radius:4px;margin-top:8px;padding:0;}
.wolist li{display:flex;justify-content:space-between;padding:4px 10px;border-bottom:1px solid #14263a;font-size:12px;color:#a0c0d8;}
.wolist li span{color:#68d994;}
.mbtns{display:flex;justify-content:flex-end;gap:10px;margin-top:16px;}
.mcancel{background:#1e2a3a;border:1px solid #3a4a5a;color:#a0bcd0;border-radius:4px;padding:8px 16px;cursor:pointer;}
.mok{background:#1a4a2a;border:1px solid #2a7a3a;color:#68d994;border-radius:4px;padding:8px 18px;cursor:pointer;font-weight:700;}
.mok:hover{background:#236b30;}
.prog{display:flex;flex-direction:column;align-items:center;gap:12px;padding:16px;}
#pmstat{color:#7ec8f7;font-size:14px;}
.reptab{width:100%;border-collapse:collapse;font-size:12px;}
.reptab th,.reptab td{padding:6px 8px;border-bottom:1px solid #1e3a54;text-align:left;}
.reptab th{color:#6a9abd;text-transform:uppercase;font-size:10px;}
/* v1.6 bozza */
.wc.pend{border-color:#e0b050;box-shadow:0 0 0 1px #e0b050 inset,0 2px 8px rgba(224,176,80,.18);background:#1a1c1e;}
.wc.pend:hover{background:#20211d;border-color:#f0c060;}
.wpb{font-size:8px;font-weight:800;letter-spacing:.04em;color:#0f1923;background:#e0b050;border-radius:3px;padding:1px 5px;margin-right:5px;white-space:nowrap;text-transform:uppercase;}
.wb.pend{background:#5b4d1a;color:#f0d78a;}
#bbday{background:#0e1e2e;border:1px solid #3a6a9a;color:#c8d8e8;border-radius:4px;padding:5px 10px;font-size:13px;min-width:150px;}
#bbstage{background:#1e3a5a;border:1px solid #3a7abf;color:#7ec8f7;border-radius:4px;padding:6px 16px;cursor:pointer;font-weight:700;}
#bbstage:hover{background:#2a5a8a;}
#pendbar{position:fixed;bottom:0;left:0;width:100%;background:#1a1508;border-top:2px solid #e0b050;padding:9px 16px;display:none;align-items:center;gap:12px;z-index:210;box-shadow:0 -2px 12px rgba(0,0,0,.6);flex-wrap:wrap;}
#pendbar.on{display:flex;}
#pbcount{font-weight:800;color:#f0c860;}
#pbsummary{font-size:11px;color:#b8a05a;}
#pbapply{background:#1a4a2a;border:1px solid #2a7a3a;color:#68d994;border-radius:4px;padding:6px 18px;cursor:pointer;font-weight:700;margin-left:auto;}
#pbapply:hover{background:#236b30;}
#pbclear{background:#2a1a1a;border:1px solid #6a3a3a;color:#e08080;border-radius:4px;padding:6px 12px;cursor:pointer;}
.dl-hours.draft,.dl-day.draft{color:#c8a63c;}
.reptab .rok td{color:#68d994;}.reptab .rerr td{color:#e08080;}.reptab .rwarn td{color:#e0b050;background:rgba(224,176,80,.08);}
@media print{
  #tb,#bulkbar,#pendbar,#lo,.wsel,.wsel-l{display:none!important;}
  body{background:#fff!important;color:#111!important;margin:0;padding:0;}
  .cs{background:#f0f0f0!important;border-radius:0;margin-bottom:12px;break-inside:avoid;}
  .sh{color:#fff!important;padding:6px 10px;}
  .cg{overflow:visible!important;}
  .cgb{display:grid!important;overflow:visible!important;}
  .dc{overflow:visible!important;min-height:0!important;}
  .wc{background:#fff!important;border:1px solid #bbb!important;break-inside:avoid;margin-bottom:4px;box-shadow:none!important;}
  .wct,.wn,.wx,.we{color:#111!important;}
  .wb,.ws{background:#444!important;color:#fff!important;}
  .wse{background:#c00!important;color:#fff!important;}
  .wh span{background:#eee!important;color:#111!important;border:1px solid #ccc;}
  .wt{border-color:#555!important;color:#555!important;}
  .gh,.gd,.gdate,.gc{color:#111!important;background:#e8e8e8!important;}
  .dt .gd,.dt .gdate,.dt .gc{background:#d0e8ff!important;}
  .wd{background:#f8f8f0!important;}
  .nt{display:none!important;}
  #cc{display:block!important;}
}
</style></head><body>
<div id="lo"><div class="sp"></div><div class="lt" id="lt">Caricamento...</div><div class="ls" id="ls"></div></div>
<div id="tb">
  <h1>WO Calendar Planner</h1>
  <button class="nb" onclick="nav(-1)">Prec</button>
  <span id="wr">${wl}</span>
  <button class="nb" onclick="nav(1)">Succ</button>
  <button class="to" onclick="goToday()">Oggi</button>
  <span class="fl">Site:</span>
  <input type="text" id="fo" value="${esc(data.org||'')}" placeholder="es. DVN3" onkeydown="if(event.key==='Enter')applyF()"/>
  <span class="fl">Tecnico:</span>
  <input type="text" id="fa" value="${esc(data.assigned||'')}" placeholder="es. MEREUDU" onkeydown="if(event.key==='Enter')applyF()"/>
  <button class="nb" onclick="applyF()">Filtra</button>
  <button class="nb" onclick="printCalendar()" title="Stampa / Salva come PDF" style="background:#1a4a1a;color:#68d994;border-color:#2e7d32;">&#128247; PDF</button>
  <span id="sb">${tot} WO - ${wl}</span>
</div>
${dashboard}
<div id="cc">${sections}</div>
<div id="bulkbar">
  <span id="bbcount">0 WO selezionati</span>
  <span id="bbhours">0 h</span>
  <label class="fl">Tecnico:</label>
  <select id="bbtech" onchange="document.getElementById('bbtechmanual').value=''"><option value="">- invariato -</option></select><input type="text" id="bbtechmanual" placeholder="o codice manuale" maxlength="20" oninput="this.value=this.value.toUpperCase();document.getElementById('bbtech').value=''"/>
  <label class="fl">Sposta a:</label>
  <select id="bbday"><option value="">- invariato -</option></select>
  <button id="bbstage" onclick="stageSelection()">Aggiungi a bozza</button>
  <button id="bbclear" onclick="clearSel()">Deseleziona</button>
</div>
<div id="pendbar">
  <span id="pbcount">0 modifiche in bozza</span>
  <span id="pbsummary"></span>
  <button id="pbapply" onclick="openApply()">Applica in EAM</button>
  <button id="pbclear" onclick="clearPending()">Annulla tutto</button>
</div>
<div id="cmodal" class="modal"><div class="mbox">
  <h3>Applica modifiche in EAM</h3>
  <div id="cmbody"></div>
  <div class="mbtns"><button class="mcancel" onclick="closeConfirm()">Annulla</button><button class="mok" onclick="doApply()">Applica in EAM</button></div>
</div></div>
<div id="pmodal" class="modal"><div class="mbox">
  <h3 id="pmtitle">Assegnazione in corso...</h3>
  <div id="pmbody"></div>
  <div class="mbtns"><button id="pmclose" class="mok" onclick="closeProgress()" style="display:none">Chiudi e aggiorna</button></div>
</div></div>
<script>
var _mon=${monJs},_org=${orgJs},_ass=${assJs},_eb=${ebJs};
var _techs=${techListJs},_woh=${woHoursJs},_tload=${techLoadJs};
var _days=${daysMetaJs};
var SEL=new Set();
function pesc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function toggleSel(cb){var w=cb.getAttribute('data-wo');if(cb.checked)SEL.add(w);else SEL.delete(w);var card=cb.closest('.wc');if(card)card.classList[cb.checked?'add':'remove']('sel');updateBB();}
function clearSel(){SEL.clear();var cs=document.querySelectorAll('.wsel');for(var i=0;i<cs.length;i++)cs[i].checked=false;var ws=document.querySelectorAll('.wc.sel');for(var j=0;j<ws.length;j++)ws[j].classList.remove('sel');updateBB();}
function cardClick(ev,card){var cb=card.querySelector('.wsel');if(!cb)return;cb.checked=!cb.checked;toggleSel(cb);}
function fmtH(v){return (Math.round((v||0)*10)/10).toLocaleString('it-IT',{maximumFractionDigits:1})+' h';}
function updateBB(){var bar=document.getElementById('bulkbar');var n=SEL.size,h=0;SEL.forEach(function(w){var v=_woh[w];if(typeof v==='number')h+=v;});document.getElementById('bbcount').textContent=n+' WO selezionat'+(n===1?'o':'i');document.getElementById('bbhours').textContent=fmtH(h);bar.classList[n>0?'add':'remove']('on');layoutBars();}
function getBbTech(){var sel=document.getElementById('bbtech').value;if(sel)return sel;return(document.getElementById('bbtechmanual').value||'').trim().toUpperCase();}
function openConfirm(){var code=getBbTech();if(!code){alert('Seleziona un tecnico dal menu o inserisci un codice manuale.');return;}if(SEL.size===0){alert('Seleziona almeno una WO.');return;}var tech=null;for(var i=0;i<_techs.length;i++){if(_techs[i].code===code){tech=_techs[i];break;}}if(!tech)tech={code:code,name:code};var selH=0;SEL.forEach(function(w){var v=_woh[w];if(typeof v==='number')selH+=v;});var cur=_tload[code]||{count:0,hours:0};var afterH=Math.round((cur.hours+selH)*10)/10;var afterN=cur.count+SEL.size;var rows='';SEL.forEach(function(w){rows+='<li>'+pesc(w)+' <span>'+fmtH(_woh[w])+'</span></li>';});document.getElementById('cmbody').innerHTML='<p>Assegnerai <b>'+SEL.size+' WO</b> ('+fmtH(selH)+') a <b>'+pesc(tech.name)+'</b> ('+pesc(code)+').</p><div class="loadbox"><div>Carico attuale<br><b>'+cur.count+' WO &middot; '+fmtH(cur.hours)+'</b></div><div class="arr">&rarr;</div><div>Dopo assegnazione<br><b>'+afterN+' WO &middot; '+fmtH(afterH)+'</b></div></div><p class="mnote">Ogni WO verra aperta e salvata singolarmente in EAM con verifica. Le WO gia assegnate ad altri tecnici verranno riassegnate. Il carico "dopo" e una stima di pianificazione.</p><ul class="wolist">'+rows+'</ul>';document.getElementById('cmodal').classList.add('on');}
function closeConfirm(){document.getElementById('cmodal').classList.remove('on');}
function doAssign(){closeConfirm();if(!window.opener||window.opener.closed){alert('Tab EAM chiusa. Riapri il calendario da EAM.');return;}var code=getBbTech();var list=[];SEL.forEach(function(w){list.push(w);});document.getElementById('pmtitle').textContent='Assegnazione in corso...';document.getElementById('pmbody').innerHTML='<div class="prog"><div class="sp"></div><div id="pmstat">0 / '+list.length+'</div></div>';document.getElementById('pmclose').style.display='none';document.getElementById('pmodal').classList.add('on');var _tgt='*';try{if(_eb){var _u=new URL(_eb);_tgt=_u.origin;}}catch(_e){}
  window.opener.postMessage({type:'WOCAL_ASSIGN',wos:list,tech:code},_tgt);window.opener.focus();}
function closeProgress(){document.getElementById('pmodal').classList.remove('on');request(_mon,_org,_ass);}
function initBulk(){var sel=document.getElementById('bbtech');if(sel&&_techs&&_techs.length){for(var i=0;i<_techs.length;i++){var o=document.createElement('option');o.value=_techs[i].code;o.textContent=_techs[i].name+' ('+_techs[i].code+')'+(_techs[i].senior?' *':'');sel.appendChild(o);}}var dsel=document.getElementById('bbday');if(dsel&&_days){for(var k=0;k<_days.length;k++){var od=document.createElement('option');od.value=_days[k].key;od.textContent=_days[k].label+(_days[k].today?' (oggi)':'');dsel.appendChild(od);}}buildWOS();updateBB();}
initBulk();
var PENDING={};
var WOS={};
function layoutBars(){var pb=document.getElementById('pendbar');var bb=document.getElementById('bulkbar');if(!bb)return;var on=pb&&pb.classList.contains('on');bb.style.bottom=on?(pb.offsetHeight+'px'):'0';}
function buildWOS(){WOS={};var cs=document.querySelectorAll('.wc');for(var i=0;i<cs.length;i++){var c=cs[i];var w=c.getAttribute('data-wo');if(!w)continue;WOS[w]={cat:c.getAttribute('data-cat')||'',day:c.getAttribute('data-day')||'',tech:(c.getAttribute('data-tech')||'').toUpperCase(),hours:parseFloat(c.getAttribute('data-hours'))||0};}}
function findCard(w){var cs=document.querySelectorAll('.wc');for(var i=0;i<cs.length;i++){if(cs[i].getAttribute('data-wo')===w)return cs[i];}return null;}
function dayLabel(k){for(var i=0;i<_days.length;i++){if(_days[i].key===k)return _days[i].label;}return k;}
function pendCount(){return Object.keys(PENDING).length;}
function fixEmpty(db){if(!db)return;var nt=db.querySelector('.nt');var has=db.querySelector('.wc');if(nt)nt.style.display=has?'none':'';}
function relocateCard(w,newDay){var c=findCard(w);if(!c)return;var cat=c.getAttribute('data-cat');var src=c.parentNode;var tgt=document.querySelector('.db[data-cat="'+cat+'"][data-day="'+newDay+'"]');if(!tgt||tgt===src){c.setAttribute('data-day',newDay);return;}tgt.appendChild(c);c.setAttribute('data-day',newDay);fixEmpty(src);fixEmpty(tgt);}
function setCardPending(w){var c=findCard(w);if(!c)return;var wct=c.querySelector('.wct');if(!wct)return;var badge=wct.querySelector('.wpb');var p=PENDING[w];if(!p){c.classList.remove('pend');if(badge)badge.parentNode.removeChild(badge);return;}c.classList.add('pend');var parts=[];if(p.tech)parts.push('tec '+p.tech);if(p.day)parts.push('\u00BB '+dayLabel(p.day));var txt='BOZZA'+(parts.length?': '+parts.join(' \u00B7 '):'');if(!badge){badge=document.createElement('span');badge.className='wpb';wct.insertBefore(badge,wct.firstChild);}badge.textContent=txt;}
function stageSelection(){var tech=getBbTech()||'';var day=document.getElementById('bbday').value||'';if(!tech&&!day){alert('Scegli un tecnico e/o un giorno di destinazione.');return;}if(SEL.size===0){alert('Seleziona almeno una WO.');return;}SEL.forEach(function(w){var p=PENDING[w]||{};var o=WOS[w]||{};if(tech){if(o.tech===tech){if(p.tech!==undefined)delete p.tech;}else p.tech=tech;}if(day){if(o.day===day){if(p.day!==undefined)delete p.day;}else p.day=day;}if(day)relocateCard(w,(p.day||o.day));if(Object.keys(p).length)PENDING[w]=p;else delete PENDING[w];setCardPending(w);});clearSel();recomputeLoads();renderPending();}
function renderPending(){var n=pendCount();var bar=document.getElementById('pendbar');bar.classList[n>0?'add':'remove']('on');var nt=0,nd=0;Object.keys(PENDING).forEach(function(w){if(PENDING[w].tech)nt++;if(PENDING[w].day)nd++;});document.getElementById('pbcount').textContent=n+' WO in bozza';document.getElementById('pbsummary').textContent=(nt?nt+' riassegnazioni':'')+(nt&&nd?' \u00B7 ':'')+(nd?nd+' spostamenti':'')+(n?' \u00B7 carichi aggiornati con la bozza':'');var cc=document.getElementById('cc');if(cc)cc.style.paddingBottom=(n>0?176:128)+'px';layoutBars();}
function clearPending(){if(!pendCount())return;if(!confirm('Annullare tutte le modifiche in bozza? La settimana verra ricaricata da EAM.'))return;PENDING={};request(_mon,_org,_ass);}
function effDay(w){return (PENDING[w]&&PENDING[w].day)||(WOS[w]&&WOS[w].day)||'';}
function effTech(w){if(PENDING[w]&&PENDING[w].tech)return PENDING[w].tech;return (WOS[w]&&WOS[w].tech)||'';}
function recomputeLoads(){var dmap={};for(var i=0;i<_days.length;i++)dmap[_days[i].key]={count:0,hours:0};var tmap={};Object.keys(WOS).forEach(function(w){var day=effDay(w);var tech=effTech(w)||'NON ASSEGNATO';var h=WOS[w].hours||0;if(dmap[day]){dmap[day].count++;dmap[day].hours+=h;}if(!tmap[tech])tmap[tech]={name:tech,count:0,hours:0};tmap[tech].count++;tmap[tech].hours+=h;});var np=pendCount()>0;var dl=document.querySelector('.day-load');if(dl){var h1='';for(var j=0;j<_days.length;j++){var d=_days[j];var sx=dmap[d.key]||{count:0,hours:0};h1+='<div class="dload'+(d.today?' today':'')+'"><div class="dl-day'+(np?' draft':'')+'">'+d.label+'</div><div class="dl-hours'+(np?' draft':'')+'">'+fmtH(sx.hours)+'</div><div class="dl-sub">'+sx.count+' WO</div></div>';}dl.innerHTML=h1;}var rows=[];Object.keys(tmap).forEach(function(k){rows.push(tmap[k]);});rows.sort(function(a,b){return b.hours-a.hours||b.count-a.count;});var tb=document.querySelector('.tech-load tbody');if(tb){var h2='';for(var m=0;m<rows.length&&m<12;m++){var t=rows[m];h2+='<tr class="'+(t.name==='NON ASSEGNATO'?'unassigned':'')+'"><td>'+pesc(t.name)+'</td><td>'+t.count+'</td><td>'+fmtH(t.hours)+'</td><td>\u2014</td></tr>';}tb.innerHTML=h2||'<tr><td colspan="4">Nessun dato</td></tr>';}}
function openApply(){if(!pendCount()){alert('Nessuna modifica in bozza.');return;}if(!window.opener||window.opener.closed){alert('Tab EAM chiusa. Riapri il calendario da EAM.');return;}var rows='';Object.keys(PENDING).forEach(function(w){var p=PENDING[w];var o=WOS[w]||{};var ch=[];if(p.tech)ch.push('tecnico: '+pesc(o.tech||'nessuno')+' \u2192 '+pesc(p.tech));if(p.day)ch.push('giorno: '+pesc(dayLabel(o.day))+' \u2192 '+pesc(dayLabel(p.day)));rows+='<li>'+pesc(w)+' <span>'+ch.join(' \u00B7 ')+'</span></li>';});document.getElementById('cmbody').innerHTML='<p>Applicherai <b>'+pendCount()+' modifiche</b> in EAM. Ogni WO verra aperta e salvata singolarmente con verifica.</p><p class="mnote">Assicurati che la tab EAM sia sulla lista Work Orders (WSJOBS). Execution/Safety compilati solo se vuoti; Safety=Yes mai sovrascritto.</p><ul class="wolist">'+rows+'</ul>';document.getElementById('cmodal').classList.add('on');}
function doApply(){closeConfirm();if(!window.opener||window.opener.closed){alert('Tab EAM chiusa.');return;}var items=[];Object.keys(PENDING).forEach(function(w){items.push({wo:w,tech:PENDING[w].tech||'',day:PENDING[w].day||''});});document.getElementById('pmtitle').textContent='Applicazione in corso...';document.getElementById('pmbody').innerHTML='<div class="prog"><div class="sp"></div><div id="pmstat">0 / '+items.length+'</div></div>';document.getElementById('pmclose').style.display='none';document.getElementById('pmodal').classList.add('on');var _tgt='*';try{if(_eb){var _u=new URL(_eb);_tgt=_u.origin;}}catch(_e){}window.opener.focus();window.opener.postMessage({type:'WOCAL_APPLY',items:items},_tgt);}
function renderApplyDone(rep){var okN=0;for(var i=0;i<rep.length;i++)if(rep[i].ok)okN++;var errN=rep.length-okN;var rows='';var safeAlert=0;for(var j=0;j<rep.length;j++){var r=rep[j];var cls=r.ok?'rok':'rerr';var det=[];if(r.move){if(r.move.ok)det.push('spostato'+(r.move.after&&r.move.after.start?' a '+pesc(r.move.after.start):''));else det.push('sposta ERR: '+pesc(r.move.error||'?'));}if(r.assign){if(r.assign.ok)det.push(r.assign.already?'tecnico gia ok':'assegnato '+pesc(r.assign.after||''));else det.push('assegna ERR: '+pesc(r.assign.error||'?'));}if(!r.move&&!r.assign&&r.error)det.push(pesc(r.error));var extra='';if(r.exec&&r.exec.set)extra+=' \u00B7 Exec='+pesc(r.exec.set);if(r.safety&&r.safety.set)extra+=' \u00B7 Safety='+pesc(r.safety.set);if(r.safety&&r.safety.already&&String(r.safety.already).trim().toUpperCase()!=='NO'){cls+=' rwarn';extra+=' \u00B7 <b>\u26A0 Safety gia = '+pesc(r.safety.already)+' (VERIFICA, non toccato)</b>';safeAlert++;}rows+='<tr class="'+cls+'"><td>'+pesc(r.wo)+'</td><td>'+(r.ok?'OK':'ERRORE')+'</td><td>'+det.join(' \u00B7 ')+extra+'</td></tr>';}document.getElementById('pmtitle').textContent='Completato: '+okN+' ok, '+errN+' error'+(errN===1?'e':'i')+(safeAlert?(' \u2014 \u26A0 '+safeAlert+' Safety=Yes da verificare'):'');document.getElementById('pmbody').innerHTML='<table class="reptab"><thead><tr><th>WO</th><th>Esito</th><th>Dettaglio</th></tr></thead><tbody>'+rows+'</tbody></table>';document.getElementById('pmclose').style.display='';}
function oWO(n){
  if(!n) return;
  if(window.opener&&!window.opener.closed){window.opener.postMessage({type:'WOCAL_NAVIGATE',woNum:n},'*');window.opener.focus();}
  else window.open(_eb+'WSJOBS?DRILLBACK=true&workordernum='+encodeURIComponent(n),'_blank');
}
function nav(o){var d=new Date(_mon+'T00:00:00');d.setDate(d.getDate()+o*7);request(p2(d.getFullYear())+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate()),_org,_ass);}
function printCalendar(){window.print();}
function goToday(){var d=new Date(),wd=d.getDay();d.setDate(d.getDate()-wd);request(p2(d.getFullYear())+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate()),_org,_ass);}
function applyF(){_org=(document.getElementById('fo').value||'').trim().toUpperCase();_ass=(document.getElementById('fa').value||'').trim().toUpperCase();request(_mon,_org,_ass);}
function request(mon,org,ass){
  if(!window.opener||window.opener.closed){setSt('EAM chiuso - riapri da EAM','E');return;}
  lo(true,'Navigando a Work Orders...','');
  window.opener.postMessage({type:'WOCAL_FETCH',monday:mon,org:org,assigned:ass},'*');
  window.opener.focus();
  setTimeout(function(){lo(false);setSt('Timeout sincronizzazione (5 min)','E');},300000);
}
window.addEventListener('message',function(e){
  if(!e.data) return;
  if(e.data.type==='WOCAL_DATA'){
    lo(false);
    if(e.data.newUrl) window.location.href=e.data.newUrl;
    else setSt('Errore: '+(e.data.error||'?'),'E');
  }
  if(e.data.type==='WOCAL_STATUS'){
    var lt=document.getElementById('lt'),ls=document.getElementById('ls');
    if(lt) lt.textContent=e.data.msg||'';if(ls) ls.textContent=e.data.sub||'';
  }
  if(e.data.type==='WOCAL_ASSIGN_PROGRESS'){
    var st=document.getElementById('pmstat');
    if(st) st.textContent=e.data.done+' / '+e.data.total+(e.data.wo?'  (WO '+e.data.wo+')':'');
  }
  if(e.data.type==='WOCAL_ASSIGN_DONE'){
    var rep=e.data.report||[];var okN=0;for(var i=0;i<rep.length;i++)if(rep[i].ok)okN++;var errN=rep.length-okN;var rows='';
    var safeAlert=0;for(var j=0;j<rep.length;j++){var r=rep[j];var cls=r.ok?'rok':'rerr';var msg=r.ok?(r.already?'gia assegnato':(r.before?('da '+pesc(r.before)+' a '+pesc(r.after)):('assegnato '+pesc(r.after||'')))):pesc(r.error||'errore');var extra='';if(r.exec&&r.exec.set)extra+=' · Exec='+pesc(r.exec.set);if(r.safety&&r.safety.set)extra+=' · Safety='+pesc(r.safety.set);if(r.safety&&r.safety.already&&String(r.safety.already).trim().toUpperCase()!=='NO'){cls+=' rwarn';extra+=' · <b>\u26A0 Safety gia = '+pesc(r.safety.already)+' (VERIFICA MANUALE, non toccato)</b>';safeAlert++;}rows+='<tr class="'+cls+'"><td>'+pesc(r.wo)+'</td><td>'+(r.ok?'OK':'ERRORE')+'</td><td>'+msg+extra+'</td></tr>';}
    document.getElementById('pmtitle').textContent='Completato: '+okN+' ok, '+errN+' error'+(errN===1?'e':'i')+(safeAlert?(' \u2014 \u26A0 '+safeAlert+' WO con Safety=Yes da verificare'):'');
    document.getElementById('pmbody').innerHTML='<table class="reptab"><thead><tr><th>WO</th><th>Esito</th><th>Dettaglio</th></tr></thead><tbody>'+rows+'</tbody></table>';
    document.getElementById('pmclose').style.display='';
  }
  if(e.data.type==='WOCAL_APPLY_PROGRESS'){var st=document.getElementById('pmstat');if(st)st.textContent=e.data.done+' / '+e.data.total+(e.data.wo?'  (WO '+e.data.wo+')':'');}
  if(e.data.type==='WOCAL_NEED_FOCUS'){
    var pmt=document.getElementById('pmtitle');
    if(pmt) pmt.innerHTML='⚠ <b>Passa alla tab EAM</b> per avviare elaborazione (evita timer rallentati dal browser)';
    var pms=document.getElementById('pmstat');
    if(pms) pms.textContent='In attesa che la tab EAM sia in primo piano...';
  }
  if(e.data.type==='WOCAL_APPLY_DONE'){renderApplyDone(e.data.report||[]);}
});
function lo(v,msg,sub){var e=document.getElementById('lo');if(e)e.classList[v?'add':'remove']('on');if(v){var lt=document.getElementById('lt'),ls=document.getElementById('ls');if(lt)lt.textContent=msg||'';if(ls)ls.textContent=sub||'';}}
function setSt(m,c){var e=document.getElementById('sb');if(e){e.textContent=m;e.className=c||'';}}
function p2(n){return String(n).padStart(2,'0');}
<\/script></body></html>`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  STATUS → scheda calendario (aggiorna spinner durante navigazione)
// ═══════════════════════════════════════════════════════════════════════════
function sendStatus(msg, sub) {
  if (calTab && !calTab.closed) calTab.postMessage({type:'WOCAL_STATUS',msg,sub:sub||''},'*');
}

// ═══════════════════════════════════════════════════════════════════════════
//  HOOK XHR/FETCH (cattura eamid per navigazione WO al click)
// ═══════════════════════════════════════════════════════════════════════════
const Session = {
  eamid:'', tenant:'AMAZONRMENA_PRD', lastUrl:'', lastRunUrl:'', lastRunBody:'',
  load(){ this.eamid=GM_getValue('wocal_eamid',''); this.tenant=GM_getValue('wocal_tenant','AMAZONRMENA_PRD'); },
  save(){ GM_setValue('wocal_eamid',this.eamid); GM_setValue('wocal_tenant',this.tenant); },
  capture(text,url){
    if(url) this.lastUrl=url;
    if(!text||this.eamid) return;
    const me=text.match(/"eamid"\s*:\s*"([^"]+)"/); if(me){this.eamid=me[1];this.save();}
    const mt=text.match(/"tenant"\s*:\s*"([^"]+)"/); if(mt){this.tenant=mt[1];this.save();}
  }
};
function hookXHR(win){
  if(win.__wocal_xhr_hooked) return; win.__wocal_xhr_hooked=true;
  try{
    const OO=win.XMLHttpRequest.prototype.open, OS=win.XMLHttpRequest.prototype.send;
    win.XMLHttpRequest.prototype.open=function(m,u){this.__wu=(u||'').toString();return OO.apply(this,arguments);};
    win.XMLHttpRequest.prototype.send=function(b){
      const u=this.__wu||'';
      // Corpo POST reale della query WSJOBS: contiene tutti i filtri EAM/MADDON.
      if(/WSJOBS\.xmlhttp/i.test(u) && typeof b==='string' && !/COMPONENT_INFO_TYPE_MODE=CACHE/i.test(b)) {
        Session.lastRunUrl=u; Session.lastRunBody=b;
      }
      if(u.includes('hxgnsmartcloud') || /WSJOBS\.xmlhttp/i.test(u))
        this.addEventListener('load',function(){if(this.status===200)Session.capture(this.responseText||'',u);});
      return OS.apply(this,arguments);
    };
  }catch(_){}
}
function hookFetch(win){
  if(win.__wocal_fetch_hooked) return; win.__wocal_fetch_hooked=true;
  try{
    const OF=win.fetch;
    win.fetch=async function(...args){
      const resp=await OF.apply(this,args);
      const u=args[0] instanceof Request?args[0].url:(typeof args[0]==='string'?args[0]:'');
      if(resp?.ok&&u.includes('hxgnsmartcloud')&&!Session.eamid)
        try{Session.capture(await resp.clone().text());}catch(_){}
      return resp;
    };
  }catch(_){}
}
function hookExtAjax(win){
  if(win.__wocal_ext_hooked) return; win.__wocal_ext_hooked=true;
  try{win.Ext.Ajax.on('requestcomplete',(_,resp)=>Session.capture((resp?.responseText)||''));}catch(_){}
}
function waitAndHookExt(win,att){
  if(win.__wocal_ext_hooked) return;
  if(win.Ext?.Ajax){hookExtAjax(win);return;}
  if((att||0)<40) setTimeout(()=>waitAndHookExt(win,(att||0)+1),500);
}

// ═══════════════════════════════════════════════════════════════════════════
//  APRI NUOVA SCHEDA (spinner immediato, poi il calendario quando pronto)
// ═══════════════════════════════════════════════════════════════════════════
let calTab=null;

async function openCalendar(monD, org, assigned) {
  setBtn('Caricamento...',true);

  // Apri subito la scheda con spinner
  const loadHtml=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>WO Calendar</title>
<style>*{margin:0;padding:0;box-sizing:border-box;}body{background:#0f1923;display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:14px;font-family:system-ui,sans-serif;}
.sp{width:44px;height:44px;border:3px solid #1e3a5a;border-top-color:#7ec8f7;border-radius:50%;animation:spin .7s linear infinite;}
@keyframes spin{to{transform:rotate(360deg);}}.lt{color:#7ec8f7;font-size:14px;font-weight:600;}.ls{color:#4a8aaa;font-size:12px;}</style></head><body>
<div class="sp"></div><div class="lt" id="lt">Navigando a Work Orders...</div><div class="ls" id="ls">Attendere...</div>
<script>window.addEventListener('message',function(e){if(!e.data)return;
if(e.data.type==='WOCAL_DATA'){if(e.data.newUrl)window.location.href=e.data.newUrl;else{document.getElementById('lt').textContent='Errore: '+(e.data.error||'?');document.getElementById('lt').style.color='#e74c3c';document.querySelector('.sp').style.display='none';}}
if(e.data.type==='WOCAL_STATUS'){var lt=document.getElementById('lt'),ls=document.getElementById('ls');if(lt)lt.textContent=e.data.msg||'';if(ls)ls.textContent=e.data.sub||'';}
});<\/script></body></html>`;

  const blob0=new Blob([loadHtml],{type:'text/html;charset=utf-8'});
  const url0=URL.createObjectURL(blob0);
  if(calTab&&!calTab.closed){calTab.location.href=url0;calTab.focus();}
  else calTab=window.open(url0,'wocal_tab');
  await delay(400);

  try {
    const wos=await fetchWOs(monD,addDays(monD,6),org,assigned);
    const scheduleSync=await syncScheduleLabor(wos,org);
    const html=buildPage({monday:iso(monD),org:org||'',assigned:assigned||'',wos,scheduleSync});
    const blob=new Blob([html],{type:'text/html;charset=utf-8'});
    const url=URL.createObjectURL(blob);
    if(calTab&&!calTab.closed) calTab.postMessage({type:'WOCAL_DATA',newUrl:url},'*');
    setBtn('WO Calendar',false);
  } catch(e) {
    setBtn('WO Calendar',false);
    const msg=e.message==='GRID_NOT_FOUND'?'WSJOBS non trovato (EAM caricato?)':
              e.message==='RUN_BUTTON_NOT_FOUND'?'Bottone Run non trovato':
              e.message==='ORG_FILTER_NOT_FOUND'?'Filtro Organization non trovato: ricerca annullata per evitare dati di altri siti':e.message;
    if(calTab&&!calTab.closed) calTab.postMessage({type:'WOCAL_DATA',newUrl:'',error:msg},'*');
    console.error('[WOCal]',e);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  MESSAGGI DALLA SCHEDA CALENDARIO
// ═══════════════════════════════════════════════════════════════════════════
function listenMessages(){
  window.addEventListener('message',async(e)=>{
    if(!e.data||typeof e.data!=='object') return;
    // FIX ALTA (verifica bulk v1.1.0): accetta solo messaggi dalla tab calendario che questo
    // script ha effettivamente aperto. Blocca comandi (incl. scritture) da fonti estranee.
    if(!calTab||e.source!==calTab) return;
    if(e.data.type==='WOCAL_NAVIGATE'){
      const n=e.data.woNum; if(!n) return;
      try{
        if(!await openWoRecord(n))
          window.location.href=CFG.baseUrl+'WSJOBS?DRILLBACK=true&workordernum='+encodeURIComponent(n)+'&tenant='+Session.tenant;
      }catch(_){}
    }
    if(e.data.type==='WOCAL_ASSIGN'){
      const list=[...new Set(Array.isArray(e.data.wos)?e.data.wos.map(x=>String(x)):[])]; // FIX ALTA: dedup
      const tech=String(e.data.tech||'').trim().toUpperCase();
      const report=[];
      if(!tech||!list.length){ if(calTab&&!calTab.closed) calTab.postMessage({type:'WOCAL_ASSIGN_DONE',report},'*'); return; }
      let consecutiveFails=0;
      for(let i=0;i<list.length;i++){
        const wo=list[i]; let r;
        try{ r=await assignWo(wo,tech); }catch(err){ r={ok:false,wo,error:err?.message||String(err)}; }
        if(!r||typeof r!=='object') r={ok:false,wo,error:'no_result'};
        if(r.wo===undefined) r.wo=wo;
        report.push(r);
        if(calTab&&!calTab.closed) calTab.postMessage({type:'WOCAL_ASSIGN_PROGRESS',done:i+1,total:list.length,wo,result:r},'*');
        // FIX MEDIA: abort dopo 3 fallimenti consecutivi (probabile problema sistemico, non della singola WO)
        if(r.ok){ consecutiveFails=0; } else {
          consecutiveFails++;
          if(consecutiveFails>=3){
            for(let j=i+1;j<list.length;j++) report.push({ok:false,wo:list[j],error:'aborted_after_consecutive_failures'});
            break;
          }
        }
      }
      if(calTab&&!calTab.closed) calTab.postMessage({type:'WOCAL_ASSIGN_DONE',report},'*');
      return;
    }
    if(e.data.type==='WOCAL_APPLY'){
      if(document.visibilityState!=='visible'){
        console.log('[WOCal] tab EAM in background - attendo che torni visibile prima di avviare Apply');
        if(calTab&&!calTab.closed) calTab.postMessage({type:'WOCAL_NEED_FOCUS'},'*');
        await new Promise(function(resolve){
          if(document.visibilityState==='visible'){ resolve(); return; }
          function h(){ if(document.visibilityState==='visible'){ document.removeEventListener('visibilitychange',h); resolve(); } }
          document.addEventListener('visibilitychange',h);
        });
        console.log('[WOCal] tab EAM visibile - avvio Apply');
      }
      const items=Array.isArray(e.data.items)?e.data.items:[];
      const report=[];
      if(!items.length){ if(calTab&&!calTab.closed) calTab.postMessage({type:'WOCAL_APPLY_DONE',report},'*'); return; }
      let consecutiveFails=0;
      for(let i=0;i<items.length;i++){
        const it=items[i]||{}, wo=String(it.wo||'');
        if(!wo){ continue; }
        const tech=String(it.tech||'').trim().toUpperCase();
        const day=String(it.day||'').trim();
        const r={wo,ok:true}; let anyFail=false;
        if(day){
          // Single-pass v1.7.7 (RIPRISTINO v1.7.5): moveWo esegue il PROPRIO Save (stato detail,
          // committa i VALORI al server) + gestione dialog + verifica. Il test v1.7.6 ha provato
          // che senza questo detail-save la data NON si committa (viene scartata all'uscita).
          let mr; try{ mr=await moveWo(wo,day,tech||null); }catch(err){ mr={ok:false,error:err?.message||String(err)}; }
          if(!mr||typeof mr!=='object') mr={ok:false,error:'no_result'};
          r.move=mr;
          if(tech){ r.assign=mr.assign||{ok:!!mr.ok}; if(mr.exec)r.exec=mr.exec; if(mr.safety)r.safety=mr.safety; }
          if(!mr.ok){ r.ok=false; anyFail=true; }
        }
        if(tech && !day && !anyFail){
          // Solo tecnico (nessuno spostamento): apertura singola, assignWo va bene.
          let ar; try{ ar=await assignWo(wo,tech); }catch(err){ ar={ok:false,error:err?.message||String(err)}; }
          if(!ar||typeof ar!=='object') ar={ok:false,error:'no_result'};
          r.assign=ar; if(ar.exec)r.exec=ar.exec; if(ar.safety)r.safety=ar.safety; if(!ar.ok){ r.ok=false; anyFail=true; }
        }
        report.push(r);
        // v1.7.7: Save griglia per-WO (flusha lo store, altrimenti i WO dopo il primo falliscono).
        if(day && r.ok){ try{ await saveGridView(true); }catch(_){} }
        if(calTab&&!calTab.closed) calTab.postMessage({type:'WOCAL_APPLY_PROGRESS',done:i+1,total:items.length,wo,result:r},'*');
        if(anyFail){ consecutiveFails++; if(consecutiveFails>=3){ for(let j=i+1;j<items.length;j++){ report.push({ok:false,wo:String((items[j]||{}).wo||''),error:'aborted_after_consecutive_failures'}); } break; } } else consecutiveFails=0;
      }
      // Save FINALE della griglia: v1.8.0 - la diagnostica (log [WOCal-AJAX]) ha confermato
      // che se TUTTI i WO ok avevano uno spostamento data (r.move presente), il save per-WO
      // (riga sopra) ha GIA' persistito tutto: questo save finale risultava un no-op puro
      // (0 richieste AJAX, ~2.4s di solo timeout sprecato). Serve SOLO se c'e' almeno un WO
      // ok con SOLO cambio tecnico senza spostamento (passa per assignWo, che non fa alcun
      // save di griglia). Skip sicuro negli altri casi.
      if(report.some(function(r){return r&&r.ok&&!r.move;})){ try{ await saveGridView(); }catch(_){} }
      if(calTab&&!calTab.closed) calTab.postMessage({type:'WOCAL_APPLY_DONE',report},'*');
      return;
    }
    if(e.data.type==='WOCAL_FETCH'){
      try{
        const mon=new Date(e.data.monday+'T00:00:00');
        const org=e.data.org||'', assigned=e.data.assigned||'';
        const wos=await fetchWOs(mon,addDays(mon,6),org,assigned);
        const scheduleSync=await syncScheduleLabor(wos,org);
        const html=buildPage({monday:iso(mon),org,assigned,wos,scheduleSync});
        const blob=new Blob([html],{type:'text/html;charset=utf-8'});
        const url=URL.createObjectURL(blob);
        if(calTab&&!calTab.closed) calTab.postMessage({type:'WOCAL_DATA',newUrl:url},'*');
      }catch(err){
        if(calTab&&!calTab.closed) calTab.postMessage({type:'WOCAL_DATA',newUrl:'',error:err.message},'*');
      }
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  BOTTONE EAM
// ═══════════════════════════════════════════════════════════════════════════
let btnEl=null, dvn3BtnEl=null;
function setBtn(l,d){
  if(btnEl){btnEl.textContent=l;btnEl.disabled=!!d;}
  if(dvn3BtnEl) dvn3BtnEl.disabled=!!d;
}

function injectButton(){
  if(document.getElementById('wocal-final-btn')) return;
  btnEl=document.createElement('button');
  btnEl.id='wocal-final-btn';
  btnEl.textContent='WO Calendar Finale';
  btnEl.onclick=()=>openCalendar(monday(new Date()),CFG.defaultOrg,CFG.defaultAssigned);
  document.body.appendChild(btnEl);

  dvn3BtnEl=document.createElement('button');
  dvn3BtnEl.id='wocal-final-dvn3-btn';
  dvn3BtnEl.textContent='WO Calendar Finale · DVN3';
  dvn3BtnEl.title="Carica soltanto i Work Order dell'organizzazione DVN3";
  dvn3BtnEl.onclick=()=>openCalendar(monday(new Date()),'DVN3',CFG.defaultAssigned);
  document.body.appendChild(dvn3BtnEl);
}

GM_addStyle(`
  #wocal-final-btn,#wocal-final-dvn3-btn{
    position:fixed;right:16px;z-index:99997;
    border-radius:6px;padding:7px 14px;cursor:pointer;
    font-size:13px;font-weight:600;
    box-shadow:0 2px 10px rgba(0,0,0,.5);
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    transition:background .15s;
  }
  #wocal-final-btn{bottom:80px;background:#1e3a5a;border:1px solid #3a7abf;color:#7ec8f7;}
  #wocal-final-dvn3-btn{bottom:118px;background:#173c2a;border:1px solid #3f9b68;color:#a9e5bf;}
  #wocal-final-btn:hover:not(:disabled){background:#2a5a8a;}
  #wocal-final-dvn3-btn:hover:not(:disabled){background:#22583d;}
  #wocal-final-btn:disabled,#wocal-final-dvn3-btn:disabled{opacity:.6;cursor:not-allowed;}
`);

// ═══════════════════════════════════════════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════════════════════════════════════════
function boot(){
  if(window.self!==window.top) return;
  if(!window.location.hostname.toLowerCase().includes('hxgnsmartcloud')) return;
  if(window.location.pathname.includes('logindisp')) return;
  Session.load();
  const win=(typeof unsafeWindow!=='undefined')?unsafeWindow:window;
  hookXHR(win); if(win!==window) hookXHR(window);
  hookFetch(win); if(win!==window) hookFetch(window);
  waitAndHookExt(win);
  listenMessages();
  const go=()=>{if(!document.body){setTimeout(go,200);return;}injectButton();};
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',go);
  else go();
}

boot();

})();
