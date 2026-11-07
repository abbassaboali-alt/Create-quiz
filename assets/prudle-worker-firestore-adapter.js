/* Prudle authenticated Worker adapter for the legacy quizzes API.
   Explicitly NOT Firebase SDK: methods map to verified POST /db operations.
   All requests are checked by Prudle Worker/Firebase security rules.
*/
const API='https://api-prudle.abbassaboali.workers.dev';
let currentToken='';
let verifiedUser=null;
// Refresh legacy Firestore-style listeners after confirmed writes without polling.
const localListeners=new Set();
let localRefreshTimer=0;
function notifyLocalListeners(){
  if(localRefreshTimer)clearTimeout(localRefreshTimer);
  localRefreshTimer=setTimeout(()=>{
    localRefreshTimer=0;
    for(const listener of localListeners)listener();
  },120);
}

const read=(k)=>sessionStorage.getItem(k)||'';
function normalize(v){
  if(v instanceof Date)return {__type:'timestamp',value:v.toISOString()};
  if(v && v.__type==='timestamp')return {__type:'timestamp',value:v.value||new Date((v.seconds||0)*1000).toISOString()};
  if(v && typeof v==='object'){
    if(v.__type==='serverTimestamp')return v;
    if(v.__type==='deleteField')return v;
    if(Array.isArray(v))return v.map(normalize);
    return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,normalize(x)]));
  }
  return v;
}
async function freshToken(){
  let token=read('firebaseToken')||currentToken;
  const expires=Number(read('firebaseTokenExpiresAt')||0);
  if(expires && expires < Date.now()+60000){
    const refresh=read('firebaseRefreshToken');
    if(!refresh)throw Error('رمز Firebase منتهي، سجّل الدخول مرة أخرى من نفس نطاق الموقع');
    const r=await fetch(API+'/auth/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({refreshToken:refresh})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok || !(d.idToken||d.id_token))throw Error('تعذر تجديد رمز Firebase: '+(d.error||r.status));
    token=d.idToken||d.id_token;
    sessionStorage.setItem('firebaseToken',token);
    if(d.refreshToken||d.refresh_token)sessionStorage.setItem('firebaseRefreshToken',d.refreshToken||d.refresh_token);
    sessionStorage.setItem('firebaseTokenExpiresAt',String(Date.now()+Math.max(60,Number(d.expiresIn||d.expires_in||3600)-60)*1000));
  }
  if(!token)throw Error('رمز Firebase غير موجود. سجّل الدخول إلى نفس نطاق برودل وفي نفس التبويب');
  currentToken=token;
  return token;
}
async function request(payload){
  const token=await freshToken();
  const session=read('prudleSessionToken');
  const headers={'Content-Type':'application/json','Authorization':'Bearer '+token};
  if(session && Number(read('prudleSessionExpiresAt'))>Date.now())headers['X-Prudle-Session']=session;
  const response=await fetch(API+'/db',{method:'POST',headers,body:JSON.stringify(payload)});
  const value=await response.json().catch(()=>({}));
  if(!response.ok||value.success===false||value.ok===false){
    const message=String(value.error||value.message||('Prudle /db HTTP '+response.status));
    const err=Error('Worker /db HTTP '+response.status+': '+message);
    err.status=response.status;
    err.code=value.code||'';
    console.error('[Prudle /db]',{action:payload.action,collection:payload.collection||payload.path||'',status:response.status,message});
    // Do not convert denied requests or failed queries into empty results.
    throw err;
  }
  return value.data??value;
}
function asTimestamp(value){
  const ms=Date.parse(value);
  if(!Number.isFinite(ms))return value;
  const d=new Date(ms);
  return {seconds:Math.floor(ms/1000),nanoseconds:(ms%1000)*1000000,toDate:()=>new Date(d.getTime())};
}
function decode(v,key=''){
  if(typeof v==='string' && /(?:At|TS|Timestamp|Time)$/i.test(key) && /^\d{4}-\d\d-\d\dT/.test(v))return asTimestamp(v);
  if(Array.isArray(v))return v.map(x=>decode(x));
  if(v && typeof v==='object'){
    if(v.__type==='timestamp'){const d=new Date(v.value);return {seconds:Math.floor(d.getTime()/1000),nanoseconds:0,toDate:()=>d};}
    return Object.fromEntries(Object.entries(v).map(([k,a])=>[k,decode(a,k)]));
  }
  return v;
}
function snapshot(x,path){
  const id=String(x?.id||path?.split('/').pop()||'');
  const data=x?.data && typeof x.data==='object' && !Array.isArray(x.data) ? x.data : x;
  const exists=x?.exists!==false && !!data;
  return {id,exists,ref:new Doc(path||''),data:()=>exists?decode(data):undefined,get:(key)=>decode(data?.[key])};
}
function list(docs,col){
  const arr=(docs||[]).map(x=>snapshot(x,col+'/'+x.id));
  return {docs:arr,size:arr.length,empty:arr.length===0,forEach:fn=>arr.forEach(fn),docChanges:()=>arr.map(doc=>({type:'added',doc}))};
}
function getField(obj,key){
  if(key==='__name__')return obj.id;
  return String(key).split('.').reduce((v,part)=>v==null?undefined:v[part],obj);
}
function compareField(a,b){
  if(a===b)return 0;
  if(a==null)return -1;
  if(b==null)return 1;
  const toComparable=x=>{
    if(x && typeof x==='object'){
      if(typeof x.seconds==='number')return x.seconds*1000+Number(x.nanoseconds||0)/1e6;
      if(typeof x.toDate==='function')return x.toDate().getTime();
    }
    if(typeof x==='string' && /^\d{4}-\d\d-\d\dT/.test(x)){
      const t=Date.parse(x);if(Number.isFinite(t))return t;
    }
    return x;
  };
  const aa=toComparable(a),bb=toComparable(b);
  if(typeof aa==='number' && typeof bb==='number')return aa<bb?-1:1;
  if(typeof aa==='boolean' && typeof bb==='boolean')return aa===false?-1:1;
  return String(aa).localeCompare(String(bb),'en');
}
class Doc{
  constructor(path){this.path=path;this.id=path.split('/').pop();}
  async get(){const r=await request({action:'getDoc',path:this.path});return snapshot(r,this.path);}
  async set(data,opt={}){const result=await request({action:'setDoc',path:this.path,data:normalize(data),merge:!!opt.merge});notifyLocalListeners();return result;}
  async update(data){if(Object.values(data).some(v=>v?.__type==='deleteField'))throw Error('حذف حقول Firestore غير مدعوم حاليًا عبر Worker /db. لم يتم تنفيذ هذا التعديل لحماية البيانات.');const result=await request({action:'updateDoc',path:this.path,data:normalize(data)});notifyLocalListeners();return result;}
  async delete(){const result=await request({action:'deleteDoc',path:this.path});notifyLocalListeners();return result;}
}
class Query{
  constructor(path,filters=[],sorts=[],max=0){this.path=path;this.filters=filters;this.sorts=sorts;this.max=max;}
  where(field,op,value){return new Query(this.path,[...this.filters,{field,op,value}],this.sorts,this.max);}
  orderBy(field,direction='asc'){return new Query(this.path,this.filters,[...this.sorts,{field,direction}],this.max);}
  limit(value){return new Query(this.path,this.filters,this.sorts,value);}
  doc(id){return new Doc(this.path+'/'+(id||crypto.randomUUID().replace(/-/g,'')));}
  async add(data){const ref=this.doc();await ref.set(data);return ref;}
  async get(){
    // IMPORTANT: the Worker forces __name__ ASC when paginate:true.
    // Mixing this with createdAt DESC can trigger a Firestore composite-index
    // error that does not occur for the original SDK orderBy query.
    // Fetch every authorized page in stable document-id order, then reproduce
    // the original order and limit locally after all pages are loaded.
    let cursor=null;
    const docs=[];
    const seenCursors=new Set();
    let pages=0;
    do{
      const r=await request({
        action:'query',collection:this.path,filters:this.filters,
        orderBy:[],limit:250,paginate:true,
        ...(cursor?{cursor}:{})
      });
      if(!Array.isArray(r.documents))throw Error('استجابة Worker /db غير صالحة: documents ليست قائمة');
      docs.push(...r.documents);
      if(!r.hasMore)break;
      if(!r.nextCursor || seenCursors.has(r.nextCursor))throw Error('فشل جلب بقية البيانات: cursor مفقود أو مكرر');
      cursor=r.nextCursor;
      seenCursors.add(cursor);
      if(++pages>5000)throw Error('عدد صفحات البيانات تجاوز حد الأمان');
    }while(true);
    let sorted=docs;
    if(this.sorts.length){
      // Firestore orderBy excludes records missing the ordered field.
      sorted=docs.filter(doc=>this.sorts.every(sort=>getField(doc,sort.field)!==undefined));
      sorted.sort((a,b)=>{
        for(const sort of this.sorts){
          const direction=String(sort.direction||'asc').toLowerCase()==='desc'?-1:1;
          const difference=compareField(getField(a,sort.field),getField(b,sort.field));
          if(difference!==0)return direction*difference;
        }
        return String(a.id||'').localeCompare(String(b.id||''));
      });
    }
    if(this.max)sorted=sorted.slice(0,this.max);
    return list(sorted,this.path);
  }
  onSnapshot(next,error){
    let active=true;
    // Initial read. Automatic real-time listener requires Firestore websocket;
    // Worker /db exposes request/response only. Refresh is done after app writes.
    let loading=false,again=false;
    async function refresh(){
      if(!active)return;
      if(loading){again=true;return;}
      loading=true;
      try{const data=await this.get();if(active)next(data);}
      catch(e){if(active)error?.(e);}
      finally{loading=false;if(again){again=false;refresh.call(this);}}
    }
    const updater=()=>refresh.call(this);
    localListeners.add(updater);
    updater();
    return ()=>{active=false;localListeners.delete(updater)};
  }
}
class Batch{
  constructor(){this.ops=[];}
  set(ref,data,opts={}){this.ops.push(()=>ref.set(data,opts));return this;}
  update(ref,data){this.ops.push(()=>ref.update(data));return this;}
  delete(ref){this.ops.push(()=>ref.delete());return this;}
  async commit(){
    // Worker /db has no atomic generic-batch route. Do not call these atomic.
    for(const op of this.ops)await op();
    return this.ops.length;
  }
}
const firestore=()=>({collection:path=>new Query(path),batch:()=>new Batch()});
firestore.FieldValue={serverTimestamp:()=>({__type:'serverTimestamp'}),delete:()=>({__type:'deleteField'})};
export const firebase={initializeApp:()=>({}),firestore};
export async function verifyAdmin(){
  const uid=read('firebaseUid')||localStorage.getItem('authUid')||localStorage.getItem('firebaseUid');
  if(!uid)throw Error('لا توجد جلسة مستخدم. سجل الدخول إلى برودل أولاً');
  const data=await request({action:'query',collection:'USERS',filters:[{field:'authUid',op:'==',value:uid}],limit:1});
  const users=data.documents||[];
  const user=users[0];
  if(!user)throw Error('تعذر التحقق من حساب الموظف في USERS');
  const roles=(Array.isArray(user.roles)&&user.roles.length?user.roles:[user.role]).map(v=>String(v||'').trim().toLowerCase());
  if(!roles.includes('admin'))throw Error('ليس لديك صلاحية Admin لهذه الصفحة');
  verifiedUser=user;
  return user;
}
export function checkedUser(){return verifiedUser;}
