import * as XLSX from "xlsx";

const REPORT_CACHE_MAX = 200;
const STALE_MS = 5 * 60_000;
const V21_CIRCUIT_MS = 60_000;

export function installReportRoutes(app,{supabaseUrl,publishableKey}){
  const cache=new Map();
  const inFlight=new Map();
  const defaultV21=String(process.env.AIGUKA_REPORT_V21_DEFAULT||"true").toLowerCase()!=="false";
  let v21CircuitOpenUntil=0;
  let v21FailureCount=0;

  const headers=()=>({
    apikey:publishableKey,
    authorization:`Bearer ${publishableKey}`,
    "content-type":"application/json",
    "x-aiguka-railway-test":"enabled"
  });

  async function rpc(name,args={},options={}){
    if(!publishableKey)throw Error("MISSING_SUPABASE_PUBLISHABLE_KEY");
    const timeoutMs=Math.max(1000,Number(options.timeoutMs||60000));
    const r=await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`,{
      method:"POST",headers:headers(),body:JSON.stringify(args),
      signal:AbortSignal.timeout(timeoutMs),cache:"no-store"
    });
    const t=await r.text();let j;try{j=JSON.parse(t)}catch{j={raw:t.slice(0,500)}}
    if(!r.ok)throw Error(j?.message||j?.error||`RPC_HTTP_${r.status}`);
    return j;
  }

  function args(q,limit=null){
    const v=n=>{const x=String(q[n]??"").trim();return x||null};
    return {
      p_from:v("from"),p_to:v("to"),p_page_id:v("page_id"),
      p_ad_account_id:v("ad_account_id"),p_campaign_id:v("campaign_id"),
      p_adset_id:v("adset_id"),p_ad_id:v("ad_id"),p_search:v("search"),
      p_limit:limit??Math.min(Math.max(Number(q.limit||100),1),10000),
      p_offset:Math.max(Number(q.offset||0),0)
    };
  }

  function requestedVersion(req){
    return String(req.query.version||req.query.report_version||"").trim().toLowerCase();
  }

  function wantsV21(req){
    const value=requestedVersion(req);
    if(["2.1","v2.1","v21","shadow"].includes(value))return true;
    if(["1","v1","legacy"].includes(value))return false;
    return defaultV21;
  }

  function explicitlyRequestsV21(req){
    return ["2.1","v2.1","v21","shadow"].includes(requestedVersion(req));
  }

  function stableKey(action,version,payload){
    const ordered=Object.fromEntries(Object.entries(payload||{}).sort(([a],[b])=>a.localeCompare(b)));
    return `${version}:${action}:${JSON.stringify(ordered)}`;
  }

  function trimCache(){
    const now=Date.now();
    for(const [key,entry] of cache){
      if(entry.staleUntil<=now)cache.delete(key);
    }
    while(cache.size>REPORT_CACHE_MAX){
      const oldest=cache.keys().next().value;
      if(oldest===undefined)break;
      cache.delete(oldest);
    }
  }

  async function cachedRpc(req,res,{action,version,name,payload,ttlMs,timeoutMs}){
    const key=stableKey(action,version,payload);
    const now=Date.now();
    const existing=cache.get(key);
    if(existing&&existing.expiresAt>now){
      res.setHeader("x-aiguka-cache","HIT");
      res.setHeader("x-aiguka-report-version",version);
      res.setHeader("server-timing",`report;dur=0;desc=cache-hit`);
      return existing.value;
    }

    const started=performance.now();
    let promise=inFlight.get(key);
    let shared=true;
    if(!promise){
      shared=false;
      promise=rpc(name,payload,{timeoutMs});
      inFlight.set(key,promise);
    }

    try{
      const value=await promise;
      const finished=Date.now();
      cache.delete(key);
      cache.set(key,{value,expiresAt:finished+ttlMs,staleUntil:finished+ttlMs+STALE_MS});
      trimCache();
      res.setHeader("x-aiguka-cache",shared?"COALESCED":"MISS");
      res.setHeader("x-aiguka-report-version",version);
      res.setHeader("server-timing",`report;dur=${(performance.now()-started).toFixed(1)};desc=${shared?"coalesced":"database"}`);
      return value;
    }catch(error){
      if(existing&&existing.staleUntil>now){
        res.setHeader("x-aiguka-cache","STALE");
        res.setHeader("x-aiguka-report-version",version);
        res.setHeader("x-aiguka-stale","true");
        res.setHeader("server-timing",`report;dur=${(performance.now()-started).toFixed(1)};desc=stale-fallback`);
        return {...existing.value,stale:true,warning:"REPORT_SOURCE_TEMPORARILY_UNAVAILABLE"};
      }
      throw error;
    }finally{
      if(inFlight.get(key)===promise)inFlight.delete(key);
    }
  }

  function rpcName(action,v21){
    if(v21){
      if(action==="filters")return "v8_report_filters_v21";
      if(action==="summary")return "v8_report_summary_v21";
      if(action==="ads")return "v8_report_ads_v21";
      if(action==="daily")return "v8_report_daily_v21";
      if(action==="leads")return "v8_report_leads_v21";
    }
    if(action==="filters")return "v8_report_filters_test";
    if(action==="summary")return "v8_report_summary_test";
    if(action==="ads")return "v8_report_ads_test";
    if(action==="daily")return "v8_report_daily_test";
    if(action==="leads")return "v8_report_leads_test";
    return null;
  }

  function ttlFor(action){
    if(action==="filters")return 10*60_000;
    if(action==="leads")return 15_000;
    return 30_000;
  }

  async function reportRpc(req,res,{action,payload,timeoutMs=15_000}){
    const requestedV21=wantsV21(req);
    if(!requestedV21){
      return cachedRpc(req,res,{
        action,version:"1",name:rpcName(action,false),payload,
        ttlMs:ttlFor(action),timeoutMs:60_000
      });
    }

    const circuitOpen=Date.now()<v21CircuitOpenUntil;
    if(!circuitOpen||explicitlyRequestsV21(req)){
      try{
        const value=await cachedRpc(req,res,{
          action,version:"2.1",name:rpcName(action,true),payload,
          ttlMs:ttlFor(action),timeoutMs
        });
        v21CircuitOpenUntil=0;
        return value;
      }catch(error){
        v21FailureCount+=1;
        v21CircuitOpenUntil=Date.now()+V21_CIRCUIT_MS;
        console.error(`[AIGUKA report] V2.1 ${action} failed; falling back to V1`,error);
        res.setHeader("x-aiguka-v21-fallback","true");
        res.setHeader("x-aiguka-v21-error",String(error?.message||error).slice(0,160));
      }
    }else{
      res.setHeader("x-aiguka-v21-circuit","open");
      res.setHeader("x-aiguka-v21-fallback","true");
    }

    const legacy=await cachedRpc(req,res,{
      action,version:"1-fallback",name:rpcName(action,false),payload,
      ttlMs:Math.min(ttlFor(action),15_000),timeoutMs:60_000
    });
    return {...legacy,fallback_from:"2.1",warning:legacy?.warning||"REPORT_V21_TEMPORARY_FALLBACK"};
  }

  function exportRows(rows,type){
    if(type==="ads")return rows.map(x=>({
      "Quảng cáo":x.ad_name||"","ID quảng cáo":x.ad_id||"",
      "Tài khoản QC":x.ad_account_name||"","Chiến dịch":x.campaign_name||"",
      "Nhóm quảng cáo":x.adset_name||"","Chi tiêu gồm thuế":+x.spend_with_tax||0,
      "Hội thoại":+x.conversations||0,"Có SĐT/Zalo":+x.contacts||0,
      "Tỷ lệ lấy số (%)":+x.contact_rate||0,"Khách nóng":+x.hot_leads||0,
      "Cost/Hội thoại":+x.cost_per_conversation||0,"Cost/SĐT":+x.cost_per_contact||0
    }));
    if(type==="daily")return rows.map(x=>({
      "Ngày":x.report_date||"","Page":x.page_name||"","Tài khoản QC":x.ad_account_name||"",
      "Chi tiêu gồm thuế":+x.spend_with_tax||0,"Hội thoại":+x.conversations||0,
      "Có SĐT/Zalo":+x.contacts||0,"Tỷ lệ lấy số (%)":+x.contact_rate||0,
      "Khách nóng":+x.hot_leads||0,"Cost/Hội thoại":+x.cost_per_conversation||0,
      "Cost/SĐT":+x.cost_per_contact||0
    }));
    return rows.map(x=>({
      "Ngày":x.report_date||"","Khách hàng":x.customer_name||"","SĐT":x.phone||"",
      "Zalo":x.zalo||"","Page":x.page_name||"","Tài khoản QC":x.ad_account_name||"",
      "Quảng cáo":x.ad_name||"","Chiến dịch":x.campaign_name||"",
      "Sản phẩm":x.product_label||x.product_group||"","Khách nóng":x.is_hot_lead?"Có":"Không",
      "Nhân viên":x.pancake_employee||"","Tin cuối":x.last_snippet||""
    }));
  }

  app.get("/functions/v1/aiguka-v8-report-api",async(req,res)=>{
    const action=String(req.query.action||"health").toLowerCase();
    try{
      if(action==="health")return res.json({
        ok:true,service:"aiguka-v8-report-railway",version:"2.1-cutover-with-v1-fallback",
        default_report_version:defaultV21?"2.1":"1",cache_entries:cache.size,
        inflight_requests:inFlight.size,v21_circuit_open:Date.now()<v21CircuitOpenUntil,
        v21_circuit_open_until:v21CircuitOpenUntil?new Date(v21CircuitOpenUntil).toISOString():null,
        v21_failure_count:v21FailureCount
      });
      if(action==="v21_status")return res.json(await cachedRpc(req,res,{
        action,version:"2.1",name:"v8_report_v21_status_admin",payload:{},ttlMs:10_000,timeoutMs:15_000
      }));
      if(action==="v21_parity")return res.json(await rpc("v8_report_v21_parity",{
        p_from:String(req.query.from||"").trim()||null,
        p_to:String(req.query.to||"").trim()||null
      },{timeoutMs:30_000}));
      if(action==="filters")return res.json(await reportRpc(req,res,{action,payload:{}}));
      if(action==="summary"){
        const a=args(req.query);delete a.p_limit;delete a.p_offset;
        return res.json(await reportRpc(req,res,{action,payload:a}));
      }
      if(["ads","daily","leads"].includes(action)){
        return res.json(await reportRpc(req,res,{action,payload:args(req.query)}));
      }
      if(action==="system"){
        const d=await rpc("v8_admin_control_overview",{}, {timeoutMs:30_000});
        return res.json({ok:true,data:{pages:d.pages||[],ad_accounts:d.ad_accounts||[],workers:[],server:d.health||null}});
      }
      if(action==="export"){
        const type=["ads","daily","leads"].includes(String(req.query.report))?String(req.query.report):"ads";
        const v21=wantsV21(req);
        let d;
        try{
          d=await rpc(rpcName(type,v21),args(req.query,10000),{timeoutMs:v21?30_000:90_000});
          res.setHeader("x-aiguka-report-version",v21?"2.1":"1");
        }catch(error){
          if(!v21)throw error;
          v21FailureCount+=1;
          v21CircuitOpenUntil=Date.now()+V21_CIRCUIT_MS;
          res.setHeader("x-aiguka-v21-fallback","true");
          d=await rpc(rpcName(type,false),args(req.query,10000),{timeoutMs:90_000});
          res.setHeader("x-aiguka-report-version","1-fallback");
        }
        const ws=XLSX.utils.json_to_sheet(exportRows(d.data||[],type));
        const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,type);
        const buffer=XLSX.write(wb,{type:"buffer",bookType:"xlsx"});
        res.setHeader("content-type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("content-disposition",`attachment; filename="bao-cao-${type}-${req.query.from||""}_den_${req.query.to||""}.xlsx"`);
        return res.send(buffer);
      }
      res.status(404).json({ok:false,error:"unknown_route"});
    }catch(error){
      console.error("[AIGUKA report]",error);
      res.status(500).json({ok:false,error:error instanceof Error?error.message:String(error),report_version:wantsV21(req)?"2.1":"1"});
    }
  });

  return {rpc};
}
