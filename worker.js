/**
 * 拾集 Cloud API v1.8.0 — deploy as a Cloudflare Worker.
 * Bind Cloudflare D1 database as DB; add Worker Secret SJ_TOKEN (min 32 chars).
 * Allowed browser origin is fixed to the user's GitHub Pages domain.
 * The secret must NOT be committed to GitHub or embedded in index.html.
 */
const ALLOWED_ORIGIN = 'https://sweijue.github.io';
const MAX_STATE_BYTES = 1_500_000;
const encoder = new TextEncoder();
const headersFor = origin => ({
  'Content-Type':'application/json; charset=utf-8',
  'Cache-Control':'no-store',
  'Vary':'Origin',
  ...(origin === ALLOWED_ORIGIN ? {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods':'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers':'Content-Type, Authorization, X-Shiji-Token',
    'Access-Control-Max-Age':'86400'
  }:{}),
});
function reply(body,status,origin){return new Response(JSON.stringify(body),{status,headers:headersFor(origin)});}
async function safeEquals(a,b){
  if(!a||!b)return false;
  const [A,B] = await Promise.all([a,b].map(s=>crypto.subtle.digest('SHA-256',encoder.encode(s))));
  const x=new Uint8Array(A),y=new Uint8Array(B);let d=0;for(let i=0;i<x.length;i++)d|=x[i]^y[i];return d===0;
}
async function schema(db){
  await db.prepare(`CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK (id=1),
    revision INTEGER NOT NULL DEFAULT 0,
    content TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL UNIQUE,
    shared_text TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'shortcut',
    received_at INTEGER NOT NULL,
    delivered_at INTEGER DEFAULT NULL
  )`).run();
  await db.prepare("INSERT OR IGNORE INTO app_state (id,revision,content,updated_at) VALUES (1,0,'{}',0)").run();
}
async function readJSON(request,limit=MAX_STATE_BYTES){
  const text=await request.text();
  if(encoder.encode(text).length>limit)throw Object.assign(new Error('payload-too-large'),{status:413});
  try {return JSON.parse(text)}catch{throw Object.assign(new Error('invalid-json'),{status:400})}
}
function extractUrl(v){
  const text=String(v||'').trim();
  // Social apps may share a sentence containing a single URL.
  const match=text.match(/https?:\/\/[^\s<>"'，。]+/i);
  if(!match)return '';
  try{const u=new URL(match[0]);return ['https:','http:'].includes(u.protocol)&&u.href.length<=2500?u.href:''}catch{return ''}
}
export default {
  async fetch(request,env){
    const origin=request.headers.get('Origin')||'';
    if(origin && origin!==ALLOWED_ORIGIN)return reply({error:'origin-not-allowed'},403,origin);
    if(request.method==='OPTIONS'){
      if(origin!==ALLOWED_ORIGIN)return reply({error:'origin-not-allowed'},403,origin);
      return new Response(null,{status:204,headers:headersFor(origin)});
    }
    const pathname=new URL(request.url).pathname.replace(/\/+$/,'')||'/';
    if(pathname==='/health'&&request.method==='GET')return reply({ok:true,version:'1.8.0',configured:!!env.DB&&!!env.SJ_TOKEN},200,origin);
    if(!env.DB||!env.SJ_TOKEN||String(env.SJ_TOKEN).length<32)return reply({error:'server-not-configured'},503,origin);
    try{
      let body=null;
      if(['POST','PUT'].includes(request.method))body=await readJSON(request,pathname==='/api/state'?MAX_STATE_BYTES:25_000);
      const provided=request.headers.get('Authorization')?.replace(/^Bearer\s+/i,'')
        ||request.headers.get('X-Shiji-Token')
        ||(pathname==='/api/collect'?body?.token:null);
      if(!await safeEquals(String(provided||''),String(env.SJ_TOKEN)))return reply({error:'unauthorized'},401,origin);
      await schema(env.DB);
      if(pathname==='/api/state'&&request.method==='GET'){
        const r=await env.DB.prepare('SELECT revision,content,updated_at FROM app_state WHERE id=1').first();
        return reply({revision:r.revision,updatedAt:r.updated_at,data:r.revision?JSON.parse(r.content):null},200,origin);
      }
      if(pathname==='/api/state'&&request.method==='PUT'){
        if(!Number.isInteger(body?.expectedRevision)||body.expectedRevision<0||typeof body?.data!=='object'||body.data===null||Array.isArray(body.data))return reply({error:'invalid-state'},400,origin);
        if(!Array.isArray(body.data.items)||!Array.isArray(body.data.shoppingLists)||!Array.isArray(body.data.travelPlans))return reply({error:'invalid-collections'},400,origin);
        const content=JSON.stringify(body.data);
        if(encoder.encode(content).length>MAX_STATE_BYTES-1000)return reply({error:'state-too-large'},413,origin);
        const res=await env.DB.prepare('UPDATE app_state SET content=?, revision=revision+1, updated_at=? WHERE id=1 AND revision=?')
          .bind(content,Date.now(),body.expectedRevision).run();
        if(!res.meta?.changes){
          const latest=await env.DB.prepare('SELECT revision FROM app_state WHERE id=1').first();
          return reply({error:'revision-conflict',revision:latest?.revision},409,origin);
        }
        return reply({ok:true,revision:body.expectedRevision+1},200,origin);
      }
      if(pathname==='/api/collect'&&request.method==='POST'){
        const url=extractUrl(body?.url||body?.text);
        if(!url)return reply({error:'valid-url-required'},400,origin);
        const sharedText=String(body.sharedText||body.text||'').slice(0,9000);
        await env.DB.prepare(`INSERT INTO inbox (url,shared_text,source,received_at,delivered_at)
          VALUES (?,?,'shortcut',?,NULL)
          ON CONFLICT(url) DO UPDATE SET shared_text=excluded.shared_text,received_at=excluded.received_at,delivered_at=NULL`)
          .bind(url,sharedText,Date.now()).run();
        return reply({ok:true,message:'已收到，開啟拾集後將自動同步',url},200,origin);
      }
      if(pathname==='/api/inbox'&&request.method==='GET'){
        const result=await env.DB.prepare('SELECT id,url,shared_text,received_at FROM inbox WHERE delivered_at IS NULL ORDER BY id LIMIT 35').all();
        return reply({items:result.results||[]},200,origin);
      }
      if(pathname==='/api/inbox/ack'&&request.method==='POST'){
        const ids=Array.isArray(body?.ids)?body.ids.filter(x=>Number.isInteger(x)&&x>0).slice(0,35):[];
        if(!ids.length)return reply({ok:true,acked:0},200,origin);
        let n=0;
        for(const id of ids){const r=await env.DB.prepare('UPDATE inbox SET delivered_at=? WHERE id=? AND delivered_at IS NULL').bind(Date.now(),id).run();n+=r.meta?.changes||0}
        return reply({ok:true,acked:n},200,origin);
      }
      return reply({error:'not-found'},404,origin);
    }catch(e){return reply({error:e.message||'internal-error'},e.status||500,origin)}
  }
};
